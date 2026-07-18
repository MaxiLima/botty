import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OnboardingApplyRequest, OnboardingState, WsEvent } from '@botty/shared';
import type { AgentEnv } from '../../src/env.js';
import type { AgentContext } from '../../src/context.js';
import type { Ingest } from '../../src/ingest/index.js';
import type { Loop } from '../../src/loop/index.js';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { createConfig } from '../../src/config/index.js';
import { createLlm } from '../../src/llm/index.js';
import { createMemory } from '../../src/memory/index.js';
import { createChat } from '../../src/chat/index.js';
import { createServer } from '../../src/server/index.js';
import { createMcpConnections } from '../../src/mcp/connections.js';
import { createPendingActionQueue } from '../../src/mcp/pending.js';
import { createMcpToolsFactory } from '../../src/mcp/tools.js';
import { seedConfigTemplates } from '../../src/env.js';

interface Harness {
  ctx: AgentContext;
  base: string;
  events: WsEvent[];
  configDir: string;
  teardown(): Promise<void>;
}

/** Same harness pattern as server.test.ts, but seeded from the real templates —
 * onboarding's prefill/apply semantics are defined against template content. */
async function setup(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-onboarding-test-'));
  const env: AgentEnv = {
    dataDir,
    dbPath: ':memory:',
    configDir: path.join(dataDir, 'config'),
    configArchiveDir: path.join(dataDir, 'config', 'archive'),
    logsDir: path.join(dataDir, 'logs'),
    mode: 'sim',
    simUrl: 'http://localhost:4821',
    mockLlm: true,
    port: 0,
  };
  fs.mkdirSync(env.configDir, { recursive: true });
  seedConfigTemplates(env.configDir, 'sim');

  const db = new Db(':memory:');
  const bus = createBus();
  const config = createConfig(env, db, bus);
  const llm = await createLlm({ env, db, bus });
  const mcpConnections = createMcpConnections({ getConfig: () => config.mcp() });
  const pendingActions = createPendingActionQueue({ db, bus, connections: mcpConnections });
  const mcpTools = createMcpToolsFactory({ config, connections: mcpConnections, pending: pendingActions });
  const memory = createMemory({ db, config });
  const chat = createChat({ db, bus, llm, memory, attachmentsDir: path.join(dataDir, 'attachments'), mcpTools });
  const ctx: AgentContext = { env, db, bus, config, llm, memory, chat, mcpConnections, pendingActions };

  const ingest: Ingest = { start() {}, stop() {}, checkNow: async (s) => db.insertSourceCheck({ source: s }).id };
  const loop: Loop = { start() {}, stop() {}, async runNow() { return db.insertTickLog('manual').id; } };

  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));

  const server = createServer(ctx, { ingest, loop });
  await server.start();

  return {
    ctx,
    base: `http://127.0.0.1:${server.port()}`,
    events,
    configDir: env.configDir,
    async teardown() {
      await server.stop();
      await config.stop();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const getState = async (base: string): Promise<OnboardingState> => {
  const res = await fetch(`${base}/api/onboarding`);
  expect(res.status).toBe(200);
  return (await res.json()) as OnboardingState;
};

const postJson = async (base: string, url: string, body: unknown): Promise<Response> =>
  fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('GET /api/onboarding', () => {
  it('reports not-onboarded on a fresh install, with checks and BLANK persona/team prefill', async () => {
    const h = await setup();
    try {
      const state = await getState(h.base);
      expect(state.onboarded).toBe(false);
      expect(state.completedAt).toBeNull();
      expect(state.checks.mode).toBe('sim');
      expect(state.checks.mockLlm).toBe(true);
      expect(state.checks.dataDir).toBe(h.ctx.env.dataDir);
      expect(state.prefillWarnings).toEqual([]);
      // Untouched seeded templates carry no user content — the fixture persona
      // (Maxo) and Acme roster must never leak into a new user's wizard.
      expect(state.prefill.team!.people).toEqual([]);
      expect(state.prefill.persona!).toEqual({
        kind: 'fields',
        name: '',
        role: '',
        addressAs: '',
        timezone: '',
        tone: '',
        banned: '',
      });
      expect(state.mtimes.persona).toBeTypeOf('number');
      expect(state.mtimes.mcp).toBeTypeOf('number');

      const health = (await (await fetch(`${h.base}/api/health`)).json()) as { onboarded: boolean };
      expect(health.onboarded).toBe(false);
    } finally {
      await h.teardown();
    }
  });

  it('prefills from the files once they differ from the seeded template', async () => {
    const h = await setup();
    try {
      h.ctx.config.save(
        'persona',
        '# PERSONA\n\n## Identity\n\nYou are botty.\n\n## About Ana\n\nAna, CTO at Initech.\n\n## Voice & tone\n\nTerse.\n\n## Banned\n\nNothing.\n',
      );
      h.ctx.config.save(
        'team',
        '# TEAM\n\n## People\n\n- **Ana** — weight: CRITICAL | email: ana@initech.example\n',
      );
      const state = await getState(h.base);
      expect(state.prefill.persona!.kind).toBe('sections');
      expect(state.prefill.team!.people.map((p) => p.name)).toEqual(['Ana']);
    } finally {
      await h.teardown();
    }
  });
});

describe('POST /api/onboarding/apply', () => {
  it('writes only the files of steps the user confirmed', async () => {
    const h = await setup();
    try {
      const state = await getState(h.base);
      const before = {
        persona: fs.readFileSync(path.join(h.configDir, 'persona.md'), 'utf8'),
        team: fs.readFileSync(path.join(h.configDir, 'team.md'), 'utf8'),
        mcp: fs.readFileSync(path.join(h.configDir, 'mcp.json'), 'utf8'),
      };
      const answers = {
        ...state.prefill,
        schedule: { ...state.prefill.schedule!, tickIntervalMin: 5 },
      };
      // Full answers object, but the user only confirmed the Schedule step.
      const body: OnboardingApplyRequest = { answers, steps: ['schedule'], mtimes: state.mtimes };
      const res = await postJson(h.base, '/api/onboarding/apply', body);
      expect(res.status).toBe(200);
      const out = (await res.json()) as { ok: boolean; warnings: Record<string, string[]> };
      expect(out.ok).toBe(true);
      expect(out.warnings).toEqual({});

      expect(fs.readFileSync(path.join(h.configDir, 'persona.md'), 'utf8')).toBe(before.persona);
      expect(fs.readFileSync(path.join(h.configDir, 'team.md'), 'utf8')).toBe(before.team);
      expect(fs.readFileSync(path.join(h.configDir, 'mcp.json'), 'utf8')).toBe(before.mcp);
      expect(h.ctx.config.heartbeat().tickIntervalMin).toBe(5);
      // template's directives/sources content survived the heartbeat re-render
      expect(h.ctx.config.heartbeat().instructions).toContain('Bias hard toward silence');

      const after = await getState(h.base);
      expect(after.onboarded).toBe(true);
      expect(after.completedAt).not.toBeNull();
      const health = (await (await fetch(`${h.base}/api/health`)).json()) as { onboarded: boolean };
      expect(health.onboarded).toBe(true);
    } finally {
      await h.teardown();
    }
  });

  it('re-run prefill returns the just-applied answers identically', async () => {
    const h = await setup();
    try {
      const state = await getState(h.base);
      const answers = {
        ...state.prefill,
        team: { people: [{ name: 'Zoe', weight: 'CRITICAL' as const, slackHandle: '@zoe' }] },
        directives: {
          ...state.prefill.directives!,
          thisWeek: 'Launch week.',
          checklist: [{ every: 2, unit: 'h' as const, text: 'check the burn-down' }],
        },
      };
      const body: OnboardingApplyRequest = {
        answers,
        steps: ['persona', 'team', 'sources', 'mcp', 'schedule', 'directives'],
      };
      expect((await postJson(h.base, '/api/onboarding/apply', body)).status).toBe(200);

      const rerun = await getState(h.base);
      expect(rerun.prefill.team).toEqual(answers.team);
      expect(rerun.prefill.schedule).toEqual(answers.schedule);
      expect(rerun.prefill.sources).toEqual(answers.sources);
      expect(rerun.prefill.directives).toEqual(answers.directives);
      expect(rerun.prefill.mcp).toEqual(answers.mcp);
      expect(rerun.prefillWarnings).toEqual([]);
    } finally {
      await h.teardown();
    }
  });

  it('archives previous versions, including mcp.json (new with the wizard)', async () => {
    const h = await setup();
    try {
      const state = await getState(h.base);
      const answers = {
        ...state.prefill,
        mcp: { servers: { probe: { type: 'stdio' as const, command: 'mcp-x', args: [], env: {}, tools: {} } } },
      };
      const res = await postJson(h.base, '/api/onboarding/apply', {
        answers,
        steps: ['team', 'mcp'],
      } satisfies OnboardingApplyRequest);
      expect(res.status).toBe(200);
      const archived = fs.readdirSync(h.ctx.env.configArchiveDir);
      expect(archived.some((f) => f.startsWith('team-'))).toBe(true);
      expect(archived.some((f) => f.startsWith('mcp-') && f.endsWith('.json'))).toBe(true);
      expect(h.ctx.config.mcp().servers.probe?.command).toBe('mcp-x');
    } finally {
      await h.teardown();
    }
  });

  it('flags a mid-wizard on-disk edit as a staleness warning (last write wins + archive)', async () => {
    const h = await setup();
    try {
      const state = await getState(h.base);
      // simulate a hand edit after prefill was served
      const teamPath = path.join(h.configDir, 'team.md');
      fs.writeFileSync(teamPath, '## People\n- **Edited** — weight: HIGH\n', 'utf8');
      const newMtime = Date.now() + 5_000;
      fs.utimesSync(teamPath, new Date(newMtime), new Date(newMtime));
      const res = await postJson(h.base, '/api/onboarding/apply', {
        answers: state.prefill,
        steps: ['team'],
        mtimes: state.mtimes,
      } satisfies OnboardingApplyRequest);
      const out = (await res.json()) as { warnings: Record<string, string[]> };
      expect(out.warnings.team?.[0]).toContain('changed on disk');
    } finally {
      await h.teardown();
    }
  });

  it('writes llm.models routing, dropping entries equal to the defaults', async () => {
    const h = await setup();
    try {
      const state = await getState(h.base);
      const res = await postJson(h.base, '/api/onboarding/apply', {
        answers: {
          ...state.prefill,
          directives: {
            ...state.prefill.directives!,
            advanced: {
              ...state.prefill.directives!.advanced,
              models: { chat: 'claude-opus-4-8', judgment: 'claude-sonnet-5', bogusTask: 'x' },
            },
          },
        },
        steps: ['directives'],
      } satisfies OnboardingApplyRequest);
      expect(res.status).toBe(200);
      // judgment matched the default and bogusTask isn't an LlmTask — both dropped
      expect(h.ctx.db.getSetting('llm.models')).toEqual({ chat: 'claude-opus-4-8' });
    } finally {
      await h.teardown();
    }
  });

  it('onboarding.completedAt is not settable via PUT /api/settings', async () => {
    const h = await setup();
    try {
      const res = await fetch(`${h.base}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: { 'onboarding.completedAt': '2026-01-01T00:00:00Z' } }),
      });
      expect(res.status).toBe(400);
      expect(h.ctx.db.getSetting('onboarding.completedAt')).toBeUndefined();
    } finally {
      await h.teardown();
    }
  });

  it('is origin-guarded like every other mutating route', async () => {
    const h = await setup();
    try {
      const res = await fetch(`${h.base}/api/onboarding/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ answers: {}, steps: ['team'] }),
      });
      expect(res.status).toBe(403);
    } finally {
      await h.teardown();
    }
  });
});

describe('POST /api/onboarding/preview', () => {
  it('renders without writing and reports changed flags', async () => {
    const h = await setup();
    try {
      const state = await getState(h.base);
      const before = fs.readFileSync(path.join(h.configDir, 'team.md'), 'utf8');
      const res = await postJson(h.base, '/api/onboarding/preview', {
        answers: {
          ...state.prefill,
          team: { people: [{ name: 'New Person', weight: 'HIGH' as const }] },
        },
        steps: ['team', 'schedule'],
      } satisfies OnboardingApplyRequest);
      expect(res.status).toBe(200);
      const out = (await res.json()) as {
        files: Record<string, { content: string; current: string | null; changed: boolean }>;
      };
      expect(Object.keys(out.files).sort()).toEqual(['heartbeat', 'team']);
      expect(out.files.team!.changed).toBe(true);
      expect(out.files.team!.content).toContain('New Person');
      expect(out.files.team!.current).toBe(before);
      // nothing written
      expect(fs.readFileSync(path.join(h.configDir, 'team.md'), 'utf8')).toBe(before);
      const after = await getState(h.base);
      expect(after.onboarded).toBe(false);
    } finally {
      await h.teardown();
    }
  });
});

describe('POST /api/onboarding/mcp-probe', () => {
  it('returns ok:false with an error for an unreachable server, without failing the request', async () => {
    const h = await setup();
    try {
      const res = await postJson(h.base, '/api/onboarding/mcp-probe', {
        server: { type: 'stdio', command: 'definitely-not-a-real-command-xyz', args: [], env: {}, tools: {} },
      });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { ok: boolean; tools: string[]; error?: string };
      expect(out.ok).toBe(false);
      expect(out.tools).toEqual([]);
      expect(out.error).toBeTruthy();
    } finally {
      await h.teardown();
    }
  });

  it('rejects a malformed server config with 400', async () => {
    const h = await setup();
    try {
      const res = await postJson(h.base, '/api/onboarding/mcp-probe', { server: { command: '' } });
      expect(res.status).toBe(400);
    } finally {
      await h.teardown();
    }
  });
});
