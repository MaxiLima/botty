import fs from 'node:fs';
import path from 'node:path';
import type { Router } from 'express';
import {
  DEFAULT_MODELS,
  McpProbeRequestSchema,
  OnboardingApplyRequestSchema,
  type OnboardingAnswers,
  type OnboardingMtimes,
  type OnboardingStepName,
} from '@botty/shared';
import type { AgentContext } from '../context.js';
import { templatesDir } from '../env.js';
import { answersFromConfig, renderHeartbeat, renderMcp, renderPersona, renderTeam } from '../config/index.js';
import { createMcpConnections } from '../mcp/connections.js';
import { nowIso } from '../db/index.js';
import { parseBody, wrap } from './errors.js';

/** Written only by POST /api/onboarding/apply — deliberately NOT in
 * SETTABLE_SETTINGS_KEYS, so PUT /api/settings keeps rejecting it. */
export const ONBOARDING_COMPLETED_KEY = 'onboarding.completedAt';

const PROBE_TIMEOUT_MS = 10_000;

type TargetFile = keyof OnboardingMtimes;

/** Wizard step → config file it writes. sources/schedule/directives all land in heartbeat.md. */
const STEP_TARGET: Record<OnboardingStepName, TargetFile> = {
  persona: 'persona',
  team: 'team',
  sources: 'heartbeat',
  mcp: 'mcp',
  schedule: 'heartbeat',
  directives: 'heartbeat',
};

/** persona.md / team.md ship as fixture-flavored templates (sim: Maxo's persona,
 * the Acme roster) or neutral `.real.md` variants. A file still byte-identical to
 * any shipped variant carries no user content — prefill it blank instead, so the
 * fixture persona and team never leak into a new user's wizard. */
function isSeededTemplate(file: 'persona' | 'team', current: string): boolean {
  const cur = current.trim();
  return [`${file}.md`, `${file}.real.md`].some((name) => {
    try {
      return fs.readFileSync(path.join(templatesDir, name), 'utf8').trim() === cur;
    } catch {
      return false;
    }
  });
}

const BLANK_PERSONA = {
  kind: 'fields',
  name: '',
  role: '',
  addressAs: '',
  timezone: '',
  tone: '',
  banned: '',
} as const;

/**
 * The web client's repeating-group steps (Team, Directives' checklist) can
 * carry rows the user never filled in — an empty "add a person"/"add a
 * checklist item" row left over from a step they skipped or clicked through.
 * `TeamMemberAnswerSchema.name` and `ChecklistItemAnswerSchema.text` are
 * rightly `min(1)` in the frozen shared schema (a real row needs a name/text),
 * so those rows 400 the whole preview/apply request instead of just being
 * ignored. Drop rows with a blank identifying field here, before validating
 * against that schema, so a step the user skipped never fails the request —
 * this only ever removes empty placeholder rows; a partially-filled row
 * (e.g. a name typo) still fails validation as it should.
 */
function dropBlankOnboardingRows(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const top = body as Record<string, unknown>;
  const answers = top.answers;
  if (typeof answers !== 'object' || answers === null) return body;
  const nextAnswers: Record<string, unknown> = { ...(answers as Record<string, unknown>) };

  const team = nextAnswers.team;
  if (typeof team === 'object' && team !== null) {
    const people = (team as Record<string, unknown>).people;
    if (Array.isArray(people)) {
      nextAnswers.team = {
        ...(team as Record<string, unknown>),
        people: people.filter(
          (p) =>
            typeof p === 'object' &&
            p !== null &&
            typeof (p as Record<string, unknown>).name === 'string' &&
            ((p as Record<string, unknown>).name as string).trim().length > 0,
        ),
      };
    }
  }

  const directives = nextAnswers.directives;
  if (typeof directives === 'object' && directives !== null) {
    const checklist = (directives as Record<string, unknown>).checklist;
    if (Array.isArray(checklist)) {
      nextAnswers.directives = {
        ...(directives as Record<string, unknown>),
        checklist: checklist.filter(
          (c) =>
            typeof c === 'object' &&
            c !== null &&
            typeof (c as Record<string, unknown>).text === 'string' &&
            ((c as Record<string, unknown>).text as string).trim().length > 0,
        ),
      };
    }
  }

  return { ...top, answers: nextAnswers };
}

export function registerOnboardingRoutes(router: Router, ctx: AgentContext): void {
  const { db, config, env } = ctx;

  const targetPath = (file: TargetFile): string =>
    path.join(env.configDir, file === 'mcp' ? 'mcp.json' : `${file}.md`);

  const mtimes = (): OnboardingMtimes => {
    const stat = (file: TargetFile): number | null => {
      try {
        return fs.statSync(targetPath(file)).mtimeMs;
      } catch {
        return null;
      }
    };
    return { persona: stat('persona'), team: stat('team'), heartbeat: stat('heartbeat'), mcp: stat('mcp') };
  };

  const currentRaw = (file: TargetFile): string =>
    file === 'mcp' ? config.mcpRaw() : config.raw(file);

  /**
   * Render the files the confirmed steps produce. Only answers belonging to a
   * step in `steps` participate — a re-run where the user only walked the
   * Schedule step must not fold in (or write) anything else.
   */
  const renderTargets = (
    answers: OnboardingAnswers,
    steps: OnboardingStepName[],
  ): Partial<Record<TargetFile, string>> => {
    const confirmed = (step: OnboardingStepName): boolean => steps.includes(step);
    const files: Partial<Record<TargetFile, string>> = {};
    if (confirmed('persona') && answers.persona) files.persona = renderPersona(answers.persona);
    if (confirmed('team') && answers.team) files.team = renderTeam(answers.team);
    const heartbeatAnswers: Pick<OnboardingAnswers, 'schedule' | 'sources' | 'directives'> = {
      ...(confirmed('schedule') && answers.schedule ? { schedule: answers.schedule } : {}),
      ...(confirmed('sources') && answers.sources ? { sources: answers.sources } : {}),
      ...(confirmed('directives') && answers.directives ? { directives: answers.directives } : {}),
    };
    if (Object.keys(heartbeatAnswers).length > 0) {
      // Carry-through base: the parse of the current file, so hand-tuned
      // non-curated knobs survive the wizard verbatim.
      files.heartbeat = renderHeartbeat(heartbeatAnswers, config.heartbeat(), env.mode);
    }
    if (confirmed('mcp') && answers.mcp) files.mcp = renderMcp(answers.mcp);
    return files;
  };

  /** llm.models patch from the directives step: unknown tasks dropped, values
   * equal to the built-in default omitted (so future default changes track). */
  const modelsPatch = (
    answers: OnboardingAnswers,
    steps: OnboardingStepName[],
  ): Record<string, string> | null => {
    if (!steps.includes('directives')) return null;
    const models = answers.directives?.advanced.models;
    if (!models) return null;
    const patch: Record<string, string> = {};
    for (const [task, model] of Object.entries(models)) {
      if (!(task in DEFAULT_MODELS)) continue;
      if (!model || model === DEFAULT_MODELS[task as keyof typeof DEFAULT_MODELS]) continue;
      patch[task] = model;
    }
    return patch;
  };

  router.get(
    '/onboarding',
    wrap((_req, res) => {
      const completedAt = db.getSetting<string>(ONBOARDING_COMPLETED_KEY) ?? null;
      const { answers, warnings } = answersFromConfig({
        personaRaw: config.persona(),
        team: config.team(),
        heartbeat: config.heartbeat(),
        mcp: config.mcp(),
        mode: env.mode,
        models: db.getSetting<Record<string, string>>('llm.models'),
      });
      if (isSeededTemplate('persona', config.persona())) answers.persona = BLANK_PERSONA;
      if (isSeededTemplate('team', config.raw('team'))) answers.team = { people: [] };
      res.json({
        onboarded: completedAt !== null,
        completedAt,
        checks: {
          mode: env.mode,
          // What the Agent SDK resolves ambiently also includes a logged-in
          // Claude Code session; the env vars are the only cheaply-checkable
          // signal, so absence renders as a warn, not a hard fail.
          llmAuth: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
          mockLlm: env.mockLlm,
          notifier:
            process.platform === 'darwin'
              ? fs.existsSync(path.join(env.dataDir, 'Botty.app'))
              : null,
          dataDir: env.dataDir,
        },
        prefill: answers,
        prefillWarnings: warnings,
        mtimes: mtimes(),
      });
    }),
  );

  router.post(
    '/onboarding/preview',
    wrap((req, res) => {
      const { answers, steps } = parseBody(OnboardingApplyRequestSchema, dropBlankOnboardingRows(req.body));
      const rendered = renderTargets(answers, steps);
      const files: Record<string, { content: string; current: string | null; changed: boolean }> = {};
      for (const [file, content] of Object.entries(rendered) as [TargetFile, string][]) {
        const current = currentRaw(file);
        files[file] = { content, current: current || null, changed: content !== current };
      }
      const models = modelsPatch(answers, steps);
      res.json({ files, ...(models ? { settings: { 'llm.models': models } } : {}) });
    }),
  );

  router.post(
    '/onboarding/apply',
    wrap((req, res) => {
      const { answers, steps, mtimes: clientMtimes } = parseBody(
        OnboardingApplyRequestSchema,
        dropBlankOnboardingRows(req.body),
      );
      const rendered = renderTargets(answers, steps);
      const warnings: Record<string, string[]> = {};

      for (const [file, content] of Object.entries(rendered) as [TargetFile, string][]) {
        const fileWarnings: string[] = [];
        // Staleness: v1 is last-write-wins + archive — the mtime check only
        // annotates that a concurrent edit was overwritten (and archived).
        if (clientMtimes && clientMtimes[file] !== null) {
          try {
            if (fs.statSync(targetPath(file)).mtimeMs !== clientMtimes[file]) {
              fileWarnings.push(
                'file changed on disk while the wizard was open — overwritten (previous version archived in config/archive/)',
              );
            }
          } catch {
            fileWarnings.push('file disappeared from disk while the wizard was open — recreated');
          }
        }
        const result =
          file === 'mcp' ? config.saveMcp(content) : config.save(file, content);
        fileWarnings.push(...result.warnings);
        if (fileWarnings.length > 0) warnings[file] = fileWarnings;
      }

      const models = modelsPatch(answers, steps);
      if (models) db.setSetting('llm.models', models);

      // The one writer of this key — deliberately outside the PUT /api/settings allowlist.
      db.setSetting(ONBOARDING_COMPLETED_KEY, nowIso());
      res.json({ ok: true, warnings });
    }),
  );

  router.post(
    '/onboarding/mcp-probe',
    wrap(async (req, res) => {
      const { server } = parseBody(McpProbeRequestSchema, req.body);
      // Throwaway connection manager scoped to this one probe — the ad-hoc
      // server config is not (yet) part of the live mcp.json.
      const probe = createMcpConnections({
        getConfig: () => ({ servers: { probe: { ...server, type: 'stdio' } } }),
      });
      try {
        const tools = await Promise.race([
          probe.listTools('probe'),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`server did not respond within ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS),
          ),
        ]);
        res.json({ ok: true, tools: tools.map((t) => t.name) });
      } catch (err) {
        // Probe failures never block saving (matches runtime behavior for
        // unreachable servers). Error text may name the command — never env values.
        res.json({ ok: false, tools: [], error: (err as Error).message });
      } finally {
        await probe.closeAll().catch(() => {});
      }
    }),
  );
}
