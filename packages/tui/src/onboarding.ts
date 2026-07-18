// Pure state machine for the /onboarding wizard (docs/specs/onboarding.md §TUI).
// No ink imports — App.tsx is a thin shell that feeds key/submit events in and
// renders `currentQuestion(state)` out; every transition lives here so the whole
// flow is unit-testable (test/onboarding.test.ts).
//
// Interaction grammar (per spec):
// - one question at a time; text questions answer via the composer (Enter keeps
//   the prefilled value), selects/toggles via ↑↓ or y/n + Enter;
// - repeating groups (people / servers / checklist) are list views: a=add,
//   e=edit, d=delete, Enter continues;
// - Esc backs up one question; Esc at the very first question asks
//   "abandon setup?" — abandoning writes nothing;
// - each writing step opens with a confirm/skip gate: only gated-in steps land
//   in the apply `steps` array, so a run that only walks Schedule never touches
//   persona.md.
import {
  ONBOARDING_STEPS,
  type McpServerAnswer,
  type OnboardingAnswers,
  type OnboardingApplyRequest,
  type OnboardingMtimes,
  type OnboardingPreviewResponse,
  type OnboardingState,
  type OnboardingStepName,
  type TeamMemberAnswer,
} from '@botty/shared';

export type WizardStep = 'welcome' | OnboardingStepName | 'review';
export const WIZARD_STEPS: readonly WizardStep[] = ['welcome', ...ONBOARDING_STEPS, 'review'];

const SOURCES = ['slack', 'gmail', 'gcal', 'jira', 'github'] as const;
type SourceKey = (typeof SOURCES)[number];

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEY_RE = /^[a-zA-Z0-9_-]+$/;
const EVERY_RE = /^(\d+)\s*([mhd])$/;

const LIST_HINT = 'a add · e edit · d delete · ↑↓ move · enter continue · esc back';

export type WizardKey = 'up' | 'down' | 'enter' | 'esc' | string;
export type WizardEvent = { type: 'submit'; text: string } | { type: 'key'; key: WizardKey };

export type Question =
  | { id: string; kind: 'info'; title: string; lines: string[]; hint: string }
  | { id: string; kind: 'text'; prompt: string; prefill: string; hint?: string }
  | {
      id: string;
      kind: 'select';
      prompt: string;
      options: string[];
      defaultIndex: number;
      /** y/n shortcut keys map to option 0 / option 1. */
      yn?: boolean;
      hint?: string;
    }
  | { id: string; kind: 'list'; prompt: string; items: string[]; hint: string };

/** In-flight repeating-group entry (add or edit) — raw text per field until commit. */
interface SubFlow {
  kind: 'person' | 'server' | 'checklist';
  /** Index being edited in the backing array (people / checklist), null when adding. */
  editIndex: number | null;
  /** Original server key when editing a server — a rename must delete it. */
  editKey: string | null;
  qIndex: number;
  draft: Record<string, string>;
}

/** All sections present — normalized at init so step code never null-checks. */
export interface WizardAnswers {
  persona: NonNullable<OnboardingAnswers['persona']>;
  team: NonNullable<OnboardingAnswers['team']>;
  sources: NonNullable<OnboardingAnswers['sources']>;
  mcp: NonNullable<OnboardingAnswers['mcp']>;
  schedule: NonNullable<OnboardingAnswers['schedule']>;
  directives: NonNullable<OnboardingAnswers['directives']>;
}

export interface WizardDone {
  outcome: 'apply' | 'abandon' | 'noop';
}

export interface WizardState {
  stepIndex: number;
  qIndex: number;
  answers: WizardAnswers;
  /** Steps the user gated in — the only ones apply may write. */
  confirmed: OnboardingStepName[];
  /** Whether the directives "advanced" sub-section was opened. */
  advancedOpen: boolean;
  mtimes: OnboardingMtimes;
  checks: OnboardingState['checks'];
  prefillWarnings: string[];
  abandonPrompt: boolean;
  sub: SubFlow | null;
  listCursor: number;
  selIndex: number;
  error: string | null;
  /** Set by the shell after POST /api/onboarding/preview succeeds. */
  preview: OnboardingPreviewResponse | null;
  done: WizardDone | null;
}

// ---------- init ----------

export function initWizard(st: OnboardingState): WizardState {
  const p = st.prefill;
  const sources =
    p.sources ??
    (Object.fromEntries(SOURCES.map((s) => [s, { enabled: false }])) as WizardAnswers['sources']);
  return resetQ({
    stepIndex: 0,
    qIndex: 0,
    answers: {
      persona:
        p.persona ?? { kind: 'fields', name: '', role: '', addressAs: '', timezone: '', tone: '', banned: '' },
      team: p.team ?? { people: [] },
      sources,
      mcp: p.mcp ?? { servers: {} },
      schedule: p.schedule ?? {
        workingHours: { start: '09:00', end: '18:00' },
        quietHours: { start: '22:00', end: '08:00' },
        activeDays: [1, 2, 3, 4, 5],
        tickIntervalMin: 30,
        morningBriefAt: '09:00',
        eveningBriefAt: '17:30',
      },
      directives: p.directives ?? { instructions: '', thisWeek: '', checklist: [], advanced: {} },
    },
    confirmed: [],
    advancedOpen: false,
    mtimes: st.mtimes,
    checks: st.checks,
    prefillWarnings: st.prefillWarnings,
    abandonPrompt: false,
    sub: null,
    listCursor: 0,
    selIndex: 0,
    error: null,
    preview: null,
    done: null,
  });
}

// ---------- labels ----------

export function personLabel(p: TeamMemberAnswer): string {
  const contact = p.slackHandle ?? p.email ?? '';
  return `${p.name} — ${p.weight}${contact ? ` · ${contact}` : ''}`;
}

export function serverLabel(key: string, s: McpServerAnswer): string {
  const toolCount = Object.keys(s.tools).length;
  const envKeys = Object.keys(s.env);
  const env = envKeys.length > 0 ? ` · env ${envKeys.map((k) => `${k}=•••`).join(' ')}` : '';
  return `${key} — ${[s.command, ...s.args].join(' ')} · ${toolCount} tool${toolCount === 1 ? '' : 's'}${env}`;
}

export function checklistLabel(c: WizardAnswers['directives']['checklist'][number]): string {
  return `every ${c.every}${c.unit}: ${c.text}`;
}

// ---------- questions ----------

function text(id: string, prompt: string, prefill: string, hint?: string): Question {
  return { id, kind: 'text', prompt, prefill, ...(hint !== undefined ? { hint } : {}) };
}

const STEP_BLURBS: Record<OnboardingStepName, string> = {
  persona: 'persona — who you are & how botty talks (persona.md)',
  team: 'team — the roster botty watches (team.md)',
  sources: 'sources — which feeds to poll & how often (heartbeat.md)',
  mcp: 'mcp — external MCP servers & tool allowlists (mcp.json)',
  schedule: 'schedule — working hours, quiet hours, briefs (heartbeat.md)',
  directives: 'directives — standing instructions & recurring checklist (heartbeat.md)',
};

function gateQuestion(step: OnboardingStepName): Question {
  return {
    id: `${step}.gate`,
    kind: 'select',
    prompt: `configure ${STEP_BLURBS[step]}?`,
    options: ['yes — walk this step', 'skip — leave it untouched'],
    defaultIndex: 0,
    yn: true,
    hint: 'y/n or ↑↓ + enter · skipped steps are never written',
  };
}

function advancedBoolSelect(id: string, prompt: string, value: boolean | undefined): Question {
  return {
    id,
    kind: 'select',
    prompt,
    options: ['leave as is', 'on', 'off'],
    defaultIndex: value === undefined ? 0 : value ? 1 : 2,
  };
}

function stepQuestions(state: WizardState, step: WizardStep): Question[] {
  const a = state.answers;
  switch (step) {
    case 'welcome': {
      const c = state.checks;
      const lines = [
        `mode      ${c.mode}${c.mockLlm ? ' · mock LLM (deterministic stub — judgment always skips)' : ''}`,
        c.llmAuth ? 'llm auth  ok' : 'llm auth  MISSING — set ANTHROPIC_API_KEY (README §LLM auth)',
        ...(c.notifier === null
          ? []
          : [
              c.notifier
                ? 'notifier  installed'
                : 'notifier  not installed — run `npm run setup:notifier` for branded notifications',
            ]),
        `data dir  ${c.dataDir}`,
        ...state.prefillWarnings.map((w) => `⚠ ${w}`),
      ];
      return [{ id: 'welcome', kind: 'info', title: 'welcome — environment checks', lines, hint: 'enter starts · esc abandons' }];
    }
    case 'persona': {
      const gate = gateQuestion('persona');
      if (!state.confirmed.includes('persona')) return [gate];
      const p = a.persona;
      if (p.kind === 'fields') {
        return [
          gate,
          text('persona.name', 'your name', p.name),
          text('persona.role', 'role / company', p.role),
          text('persona.addressAs', 'how should botty address you?', p.addressAs),
          text('persona.timezone', 'timezone (e.g. America/Argentina/Buenos_Aires)', p.timezone),
          text('persona.tone', 'voice & tone notes', p.tone),
          text('persona.banned', 'banned behaviors', p.banned),
        ];
      }
      if (p.kind === 'sections') {
        const hint = 'current section text is prefilled — enter keeps it';
        return [
          gate,
          text('persona.identity', 'persona ## Identity — edit the section text', p.identity, hint),
          text('persona.about', 'persona ## About — edit the section text', p.about, hint),
          text('persona.voice', 'persona ## Voice & tone — edit the section text', p.voice, hint),
          text('persona.banned.section', 'persona ## Banned — edit the section text', p.banned, hint),
        ];
      }
      return [
        gate,
        text(
          'persona.raw',
          'persona.md no longer matches the template headings — edit the full file text',
          p.content,
        ),
      ];
    }
    case 'team': {
      const gate = gateQuestion('team');
      if (!state.confirmed.includes('team')) return [gate];
      return [
        gate,
        {
          id: 'team.list',
          kind: 'list',
          prompt: 'team roster — CRITICAL/HIGH get full task extraction; empty means interactions-only',
          items: a.team.people.map(personLabel),
          hint: LIST_HINT,
        },
      ];
    }
    case 'sources': {
      const gate = gateQuestion('sources');
      if (!state.confirmed.includes('sources')) return [gate];
      const qs: Question[] = [gate];
      for (const s of SOURCES) {
        const t = a.sources[s];
        qs.push({
          id: `sources.${s}.enabled`,
          kind: 'select',
          prompt: `poll ${s}?`,
          options: ['on', 'off'],
          defaultIndex: t.enabled ? 0 : 1,
          yn: true,
        });
        if (t.enabled) {
          qs.push(
            text(
              `sources.${s}.interval`,
              `${s} poll interval (minutes)`,
              t.intervalMin !== undefined ? String(t.intervalMin) : '',
              'empty keeps the mode default',
            ),
          );
        }
      }
      return qs;
    }
    case 'mcp': {
      const gate = gateQuestion('mcp');
      if (!state.confirmed.includes('mcp')) return [gate];
      return [
        gate,
        {
          id: 'mcp.list',
          kind: 'list',
          prompt: 'MCP servers — action-mode tools queue for your approval, never run mid-turn',
          items: Object.entries(a.mcp.servers).map(([k, s]) => serverLabel(k, s)),
          hint: LIST_HINT,
        },
      ];
    }
    case 'schedule': {
      const gate = gateQuestion('schedule');
      if (!state.confirmed.includes('schedule')) return [gate];
      const sch = a.schedule;
      return [
        gate,
        text('schedule.workingHours.start', 'working hours start (HH:MM) — outside them botty is hard-off', sch.workingHours.start),
        text('schedule.workingHours.end', 'working hours end (HH:MM)', sch.workingHours.end),
        text('schedule.quietHours.start', 'quiet hours start (HH:MM)', sch.quietHours.start),
        text('schedule.quietHours.end', 'quiet hours end (HH:MM)', sch.quietHours.end),
        text('schedule.activeDays', 'active days (0=Sun … 6=Sat, e.g. 1-5 or 1,2,3,4,5)', sch.activeDays.join(',')),
        text('schedule.tickIntervalMin', 'tick interval (minutes)', String(sch.tickIntervalMin)),
        text('schedule.morningBriefAt', 'morning brief at (HH:MM)', sch.morningBriefAt),
        text('schedule.eveningBriefAt', 'evening brief at (HH:MM)', sch.eveningBriefAt),
      ];
    }
    case 'directives': {
      const gate = gateQuestion('directives');
      if (!state.confirmed.includes('directives')) return [gate];
      const d = a.directives;
      const qs: Question[] = [
        gate,
        text('directives.instructions', 'standing instructions (## Instructions)', d.instructions),
        text('directives.thisWeek', 'this week (## This week) — optional', d.thisWeek),
        {
          id: 'directives.checklist',
          kind: 'list',
          prompt: 'recurring checklist (## Tasks) — "every <N><m|h|d>: <instruction>" bullets',
          items: d.checklist.map(checklistLabel),
          hint: LIST_HINT,
        },
        {
          id: 'directives.advanced.gate',
          kind: 'select',
          prompt: 'tune advanced behavior knobs? (everything else carries through untouched)',
          options: ['skip — keep current values', 'yes — walk them'],
          defaultIndex: 0,
        },
      ];
      if (state.advancedOpen) {
        const adv = d.advanced;
        qs.push(
          text(
            'directives.advanced.surfacingThreshold',
            'surfacing threshold (1-10)',
            adv.surfacingThreshold !== undefined ? String(adv.surfacingThreshold) : '',
            'empty leaves it as is',
          ),
          text(
            'directives.advanced.maxProactivePerHour',
            'max proactive nudges per hour',
            adv.maxProactivePerHour !== undefined ? String(adv.maxProactivePerHour) : '',
            'empty leaves it as is',
          ),
          text(
            'directives.advanced.minGapBetweenNudgesMin',
            'min gap between nudges (minutes)',
            adv.minGapBetweenNudgesMin !== undefined ? String(adv.minGapBetweenNudgesMin) : '',
            'empty leaves it as is',
          ),
          advancedBoolSelect('directives.advanced.autoResolveTasks', 'auto-resolve tasks?', adv.autoResolveTasks),
          advancedBoolSelect('directives.advanced.inferCommitments', 'infer commitments?', adv.inferCommitments),
          text(
            'directives.advanced.commitmentsMaxPerDay',
            'max inferred commitments per day',
            adv.commitmentsMaxPerDay !== undefined ? String(adv.commitmentsMaxPerDay) : '',
            'empty leaves it as is',
          ),
        );
      }
      return qs;
    }
    case 'review':
      return []; // review questions are synthesized in currentQuestion
  }
}

function subQuestions(sub: SubFlow): Question[] {
  const d = sub.draft;
  if (sub.kind === 'person') {
    const weights = ['CRITICAL', 'HIGH', 'NORMAL'];
    const cur = weights.indexOf(d['weight'] ?? 'NORMAL');
    return [
      text('sub.person.name', 'name (required)', d['name'] ?? ''),
      {
        id: 'sub.person.weight',
        kind: 'select',
        prompt: 'weight — CRITICAL/HIGH are Tier-1 (full task extraction)',
        options: weights,
        defaultIndex: cur === -1 ? 2 : cur,
      },
      text('sub.person.slackHandle', 'slack handle — optional', d['slackHandle'] ?? ''),
      text('sub.person.email', 'email — optional', d['email'] ?? ''),
      text('sub.person.cadence', 'cadence (e.g. daily standup) — optional', d['cadence'] ?? ''),
      text('sub.person.notes', 'notes — optional', d['notes'] ?? ''),
    ];
  }
  if (sub.kind === 'server') {
    return [
      text('sub.server.key', 'server key (letters, digits, - _)', d['key'] ?? ''),
      text('sub.server.command', 'command (required)', d['command'] ?? ''),
      text('sub.server.args', 'args (space-separated) — optional', d['args'] ?? ''),
      text(
        'sub.server.env',
        'env vars (KEY=value, comma-separated) — optional',
        d['env'] ?? '',
        'values are masked everywhere outside this prompt',
      ),
      text(
        'sub.server.tools',
        'tool allowlist (name or name:action, space-separated) — optional',
        d['tools'] ?? '',
        'read runs freely · action queues for your approval',
      ),
    ];
  }
  return [
    text('sub.checklist.every', 'how often? (e.g. 30m, 2h, 1d)', d['every'] ?? ''),
    text('sub.checklist.text', 'instruction (required)', d['text'] ?? ''),
  ];
}

export function currentQuestion(state: WizardState): Question | null {
  if (state.done) return null;
  if (state.abandonPrompt) {
    return {
      id: 'abandon',
      kind: 'select',
      prompt: 'abandon setup? nothing has been written',
      options: ['yes — abandon', 'no — keep going'],
      defaultIndex: 1,
      yn: true,
      hint: 'y abandons · n continues',
    };
  }
  if (state.sub) return subQuestions(state.sub)[state.sub.qIndex] ?? null;
  const step = WIZARD_STEPS[state.stepIndex];
  if (step === undefined) return null;
  if (step === 'review') {
    if (state.confirmed.length === 0) {
      return {
        id: 'review.noop',
        kind: 'select',
        prompt: 'review — no steps confirmed, nothing to write',
        options: ['exit setup'],
        defaultIndex: 0,
        hint: 'enter exits · esc backs up',
      };
    }
    if (!state.preview) {
      return { id: 'review.loading', kind: 'info', title: 'review', lines: ['building preview…'], hint: 'esc backs up' };
    }
    const changed = Object.values(state.preview.files).filter((f) => f.changed).length;
    return {
      id: 'review.confirm',
      kind: 'select',
      prompt: `apply these changes? (${changed} file${changed === 1 ? '' : 's'} will change — preview above)`,
      options: ['apply', 'abandon'],
      defaultIndex: 0,
      yn: true,
      hint: 'config hot-reloads · previous versions land in config/archive/',
    };
  }
  const qs = stepQuestions(state, step);
  return qs[Math.min(state.qIndex, Math.max(0, qs.length - 1))] ?? null;
}

export function progressLabel(state: WizardState): string {
  const step = WIZARD_STEPS[state.stepIndex] ?? 'review';
  return `[${state.stepIndex + 1}/${WIZARD_STEPS.length} ${step}]`;
}

// ---------- shell helpers ----------

/** True when the shell should fetch POST /api/onboarding/preview for the review step. */
export function needsPreview(state: WizardState): boolean {
  return (
    !state.done &&
    !state.abandonPrompt &&
    WIZARD_STEPS[state.stepIndex] === 'review' &&
    state.confirmed.length > 0 &&
    state.preview === null
  );
}

export function setPreview(state: WizardState, preview: OnboardingPreviewResponse): WizardState {
  return resetQ({ ...state, preview });
}

/** Apply failed server-side — reopen the review confirm so the user can retry. */
export function reopenReview(state: WizardState): WizardState {
  return resetQ({ ...state, done: null });
}

/** null when no step was confirmed — the shell must then write nothing. */
export function buildApplyRequest(state: WizardState): OnboardingApplyRequest | null {
  const steps = ONBOARDING_STEPS.filter((s) => state.confirmed.includes(s));
  if (steps.length === 0) return null;
  const answers: OnboardingAnswers = {};
  if (steps.includes('persona')) answers.persona = state.answers.persona;
  if (steps.includes('team')) answers.team = state.answers.team;
  if (steps.includes('sources')) answers.sources = state.answers.sources;
  if (steps.includes('mcp')) answers.mcp = state.answers.mcp;
  if (steps.includes('schedule')) answers.schedule = state.answers.schedule;
  if (steps.includes('directives')) answers.directives = state.answers.directives;
  return { answers, steps, mtimes: state.mtimes };
}

/** Mask env values in a rendered mcp.json before showing it in the review panel. */
export function maskMcpJson(content: string): string {
  try {
    return JSON.stringify(maskEnvDeep(JSON.parse(content)), null, 2);
  } catch {
    return content;
  }
}

function maskEnvDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskEnvDeep);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (k === 'env' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        out[k] = Object.fromEntries(Object.keys(val).map((ek) => [ek, '•••']));
      } else {
        out[k] = maskEnvDeep(val);
      }
    }
    return out;
  }
  return v;
}

// ---------- navigation ----------

/** Clear per-question scratch state after any navigation: validation error,
 * select cursor (snapped to the new question's default), list cursor clamp. */
function resetQ(s: WizardState): WizardState {
  const q = currentQuestion(s);
  return {
    ...s,
    error: null,
    selIndex: q?.kind === 'select' ? q.defaultIndex : s.selIndex,
    listCursor: q?.kind === 'list' ? Math.min(s.listCursor, Math.max(0, q.items.length - 1)) : s.listCursor,
  };
}

function advance(state: WizardState): WizardState {
  const step = WIZARD_STEPS[state.stepIndex];
  if (step === undefined || step === 'review') return state;
  const qs = stepQuestions(state, step);
  if (state.qIndex + 1 < qs.length) return resetQ({ ...state, qIndex: state.qIndex + 1 });
  return resetQ({ ...state, stepIndex: state.stepIndex + 1, qIndex: 0, listCursor: 0 });
}

function back(state: WizardState): WizardState {
  const step = WIZARD_STEPS[state.stepIndex];
  if (step !== 'review' && state.qIndex > 0) return resetQ({ ...state, qIndex: state.qIndex - 1 });
  if (state.stepIndex === 0) return { ...state, abandonPrompt: true, selIndex: 1 };
  // Backing out of review invalidates the fetched preview — re-entering refetches.
  const cleared = { ...state, preview: step === 'review' ? null : state.preview };
  const prevIndex = state.stepIndex - 1;
  const prevStep = WIZARD_STEPS[prevIndex];
  const qs = prevStep === undefined ? [] : stepQuestions(cleared, prevStep);
  return resetQ({ ...cleared, stepIndex: prevIndex, qIndex: Math.max(0, qs.length - 1) });
}

// ---------- reducer ----------

export function wizardReduce(state: WizardState, ev: WizardEvent): WizardState {
  if (state.done) return state;
  const q = currentQuestion(state);
  if (!q) return state;

  if (ev.type === 'key' && ev.key === 'esc') {
    if (state.abandonPrompt) return resetQ({ ...state, abandonPrompt: false });
    if (state.sub) return subBack(state);
    return back(state);
  }

  if (state.abandonPrompt && q.kind === 'select') {
    return reduceSelect(state, q, ev, (choice) =>
      choice === 0 ? { ...state, done: { outcome: 'abandon' } } : resetQ({ ...state, abandonPrompt: false }),
    );
  }

  switch (q.kind) {
    case 'info':
      if (ev.type === 'key' && ev.key === 'enter' && q.id === 'welcome') return advance(state);
      return state; // review.loading: Enter is inert until the preview lands
    case 'text':
      if (ev.type === 'submit') return answerText(state, q.id, ev.text);
      return state;
    case 'select':
      return reduceSelect(state, q, ev, (choice) => answerSelect(state, q.id, choice));
    case 'list':
      return reduceList(state, q, ev);
  }
}

function reduceSelect(
  state: WizardState,
  q: Extract<Question, { kind: 'select' }>,
  ev: WizardEvent,
  commit: (choice: number) => WizardState,
): WizardState {
  if (ev.type !== 'key') return state;
  const n = q.options.length;
  if (ev.key === 'up') return { ...state, selIndex: (state.selIndex + n - 1) % n };
  if (ev.key === 'down') return { ...state, selIndex: (state.selIndex + 1) % n };
  if (ev.key === 'enter') return commit(Math.min(state.selIndex, n - 1));
  if (q.yn && ev.key === 'y') return commit(0);
  if (q.yn && ev.key === 'n') return commit(Math.min(1, n - 1));
  return state;
}

function reduceList(
  state: WizardState,
  q: Extract<Question, { kind: 'list' }>,
  ev: WizardEvent,
): WizardState {
  if (ev.type !== 'key') return state;
  const n = q.items.length;
  if (ev.key === 'up' && n > 0) return { ...state, listCursor: (state.listCursor + n - 1) % n };
  if (ev.key === 'down' && n > 0) return { ...state, listCursor: (state.listCursor + 1) % n };
  if (ev.key === 'enter') return advance(state);
  if (ev.key === 'a') return startSub(state, q.id, null);
  if (ev.key === 'e' && n > 0) return startSub(state, q.id, state.listCursor);
  if (ev.key === 'd' && n > 0) return deleteAt(state, q.id, state.listCursor);
  return state;
}

// ---------- select answers ----------

function answerSelect(state: WizardState, id: string, choice: number): WizardState {
  const gate = /^(persona|team|sources|mcp|schedule|directives)\.gate$/.exec(id);
  if (gate) {
    const step = gate[1] as OnboardingStepName;
    const confirmed =
      choice === 0
        ? state.confirmed.includes(step)
          ? state.confirmed
          : [...state.confirmed, step]
        : state.confirmed.filter((s) => s !== step);
    return advance({ ...state, confirmed });
  }

  const src = /^sources\.(\w+)\.enabled$/.exec(id);
  if (src) {
    const s = src[1] as SourceKey;
    const t = state.answers.sources[s];
    const sources = { ...state.answers.sources, [s]: { ...t, enabled: choice === 0 } };
    return advance({ ...state, answers: { ...state.answers, sources } });
  }

  if (id === 'sub.person.weight' && state.sub) {
    const weights: TeamMemberAnswer['weight'][] = ['CRITICAL', 'HIGH', 'NORMAL'];
    return subAdvance(state, { ...state.sub.draft, weight: weights[choice] ?? 'NORMAL' });
  }

  if (id === 'directives.advanced.gate') {
    return advance({ ...state, advancedOpen: choice === 1 });
  }

  if (id === 'directives.advanced.autoResolveTasks' || id === 'directives.advanced.inferCommitments') {
    const field = id === 'directives.advanced.autoResolveTasks' ? 'autoResolveTasks' : 'inferCommitments';
    const value = choice === 0 ? undefined : choice === 1;
    const advanced = { ...state.answers.directives.advanced, [field]: value };
    if (value === undefined) delete advanced[field];
    return advance({
      ...state,
      answers: { ...state.answers, directives: { ...state.answers.directives, advanced } },
    });
  }

  if (id === 'review.confirm') {
    return { ...state, done: { outcome: choice === 0 ? 'apply' : 'abandon' } };
  }
  if (id === 'review.noop') {
    return { ...state, done: { outcome: 'noop' } };
  }
  return state;
}

// ---------- text answers ----------

function fail(state: WizardState, error: string): WizardState {
  return { ...state, error };
}

function answerText(state: WizardState, id: string, raw: string): WizardState {
  const text = raw.trim();
  if (id.startsWith('sub.')) return answerSubText(state, id, text);

  if (id.startsWith('persona.')) {
    const p = state.answers.persona;
    const set = (persona: WizardAnswers['persona']): WizardState =>
      advance({ ...state, answers: { ...state.answers, persona } });
    if (p.kind === 'fields') {
      const field = id.slice('persona.'.length);
      if (field === 'name' || field === 'role' || field === 'addressAs' || field === 'timezone' || field === 'tone' || field === 'banned') {
        return set({ ...p, [field]: text });
      }
    }
    if (p.kind === 'sections') {
      if (id === 'persona.identity') return set({ ...p, identity: raw });
      if (id === 'persona.about') return set({ ...p, about: raw });
      if (id === 'persona.voice') return set({ ...p, voice: raw });
      if (id === 'persona.banned.section') return set({ ...p, banned: raw });
    }
    if (p.kind === 'raw' && id === 'persona.raw') return set({ ...p, content: raw });
    return state;
  }

  const interval = /^sources\.(\w+)\.interval$/.exec(id);
  if (interval) {
    const s = interval[1] as SourceKey;
    const t = state.answers.sources[s];
    let next: WizardAnswers['sources'][SourceKey];
    if (text === '') {
      next = { enabled: t.enabled };
    } else {
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1) {
        return fail(state, 'enter a whole number of minutes ≥ 1, or leave empty for the mode default');
      }
      next = { ...t, intervalMin: n };
    }
    const sources = { ...state.answers.sources, [s]: next };
    return advance({ ...state, answers: { ...state.answers, sources } });
  }

  if (id.startsWith('schedule.')) {
    const sch = state.answers.schedule;
    const set = (schedule: WizardAnswers['schedule']): WizardState =>
      advance({ ...state, answers: { ...state.answers, schedule } });
    const hhmm = (apply: (v: string) => WizardAnswers['schedule']): WizardState =>
      HHMM_RE.test(text) ? set(apply(text)) : fail(state, 'expected HH:MM (e.g. 09:00)');
    switch (id) {
      case 'schedule.workingHours.start':
        return hhmm((v) => ({ ...sch, workingHours: { ...sch.workingHours, start: v } }));
      case 'schedule.workingHours.end':
        return hhmm((v) => ({ ...sch, workingHours: { ...sch.workingHours, end: v } }));
      case 'schedule.quietHours.start':
        return hhmm((v) => ({ ...sch, quietHours: { ...sch.quietHours, start: v } }));
      case 'schedule.quietHours.end':
        return hhmm((v) => ({ ...sch, quietHours: { ...sch.quietHours, end: v } }));
      case 'schedule.morningBriefAt':
        return hhmm((v) => ({ ...sch, morningBriefAt: v }));
      case 'schedule.eveningBriefAt':
        return hhmm((v) => ({ ...sch, eveningBriefAt: v }));
      case 'schedule.activeDays': {
        const days = parseActiveDays(text);
        if (!days) return fail(state, 'expected days 0-6 as a list or range, e.g. 1-5 or 1,2,3,4,5');
        return set({ ...sch, activeDays: days });
      }
      case 'schedule.tickIntervalMin': {
        const n = Number(text);
        if (!Number.isInteger(n) || n < 1) return fail(state, 'enter a whole number of minutes ≥ 1');
        return set({ ...sch, tickIntervalMin: n });
      }
    }
    return state;
  }

  if (id.startsWith('directives.')) {
    const d = state.answers.directives;
    const set = (directives: WizardAnswers['directives']): WizardState =>
      advance({ ...state, answers: { ...state.answers, directives } });
    if (id === 'directives.instructions') return set({ ...d, instructions: raw });
    if (id === 'directives.thisWeek') return set({ ...d, thisWeek: raw });
    const advField = /^directives\.advanced\.(surfacingThreshold|maxProactivePerHour|minGapBetweenNudgesMin|commitmentsMaxPerDay)$/.exec(id);
    if (advField) {
      const field = advField[1] as
        | 'surfacingThreshold'
        | 'maxProactivePerHour'
        | 'minGapBetweenNudgesMin'
        | 'commitmentsMaxPerDay';
      const advanced = { ...d.advanced };
      if (text === '') {
        delete advanced[field];
        return set({ ...d, advanced });
      }
      const n = Number(text);
      const min = field === 'surfacingThreshold' ? 1 : 0;
      if (!Number.isInteger(n) || n < min || (field === 'surfacingThreshold' && n > 10)) {
        return fail(state, field === 'surfacingThreshold' ? 'enter a whole number 1-10, or leave empty' : `enter a whole number ≥ ${min}, or leave empty`);
      }
      advanced[field] = n;
      return set({ ...d, advanced });
    }
    return state;
  }

  return state;
}

/** "1-5" / "1,2,3" / mixes → sorted unique day numbers, or null when invalid. */
export function parseActiveDays(text: string): number[] | null {
  const out = new Set<number>();
  for (const tok of text.split(',').map((t) => t.trim()).filter((t) => t !== '')) {
    const range = /^([0-6])\s*-\s*([0-6])$/.exec(tok);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a > b) return null;
      for (let d = a; d <= b; d++) out.add(d);
      continue;
    }
    if (/^[0-6]$/.test(tok)) {
      out.add(Number(tok));
      continue;
    }
    return null;
  }
  if (out.size === 0) return null;
  return [...out].sort((a, b) => a - b);
}

// ---------- repeating groups ----------

function startSub(state: WizardState, listId: string, index: number | null): WizardState {
  let sub: SubFlow;
  if (listId === 'team.list') {
    const p = index !== null ? state.answers.team.people[index] : undefined;
    sub = {
      kind: 'person',
      editIndex: index,
      editKey: null,
      qIndex: 0,
      draft: p
        ? {
            name: p.name,
            weight: p.weight,
            slackHandle: p.slackHandle ?? '',
            email: p.email ?? '',
            cadence: p.cadence ?? '',
            notes: p.notes ?? '',
          }
        : {},
    };
  } else if (listId === 'mcp.list') {
    const keys = Object.keys(state.answers.mcp.servers);
    const key = index !== null ? keys[index] : undefined;
    const s = key !== undefined ? state.answers.mcp.servers[key] : undefined;
    sub = {
      kind: 'server',
      editIndex: index,
      editKey: key ?? null,
      qIndex: 0,
      draft:
        s && key !== undefined
          ? {
              key,
              command: s.command,
              args: s.args.join(' '),
              env: Object.entries(s.env)
                .map(([k, v]) => `${k}=${v}`)
                .join(', '),
              tools: Object.entries(s.tools)
                .map(([k, m]) => `${k}:${m}`)
                .join(' '),
            }
          : {},
    };
  } else {
    const c = index !== null ? state.answers.directives.checklist[index] : undefined;
    sub = {
      kind: 'checklist',
      editIndex: index,
      editKey: null,
      qIndex: 0,
      draft: c ? { every: `${c.every}${c.unit}`, text: c.text } : {},
    };
  }
  return resetQ({ ...state, sub, error: null });
}

function deleteAt(state: WizardState, listId: string, index: number): WizardState {
  let answers = state.answers;
  if (listId === 'team.list') {
    const people = state.answers.team.people.filter((_, i) => i !== index);
    answers = { ...answers, team: { people } };
  } else if (listId === 'mcp.list') {
    const keys = Object.keys(state.answers.mcp.servers);
    const key = keys[index];
    if (key === undefined) return state;
    const servers = { ...state.answers.mcp.servers };
    delete servers[key];
    answers = { ...answers, mcp: { servers } };
  } else {
    const checklist = state.answers.directives.checklist.filter((_, i) => i !== index);
    answers = { ...answers, directives: { ...answers.directives, checklist } };
  }
  return resetQ({ ...state, answers, listCursor: Math.max(0, index - 1) });
}

function subBack(state: WizardState): WizardState {
  const sub = state.sub;
  if (!sub) return state;
  if (sub.qIndex > 0) return resetQ({ ...state, sub: { ...sub, qIndex: sub.qIndex - 1 } });
  return resetQ({ ...state, sub: null }); // cancel the add/edit — nothing committed
}

function answerSubText(state: WizardState, id: string, text: string): WizardState {
  const sub = state.sub;
  if (!sub) return state;
  switch (id) {
    case 'sub.person.name':
      if (text === '') return fail(state, 'name is required');
      return subAdvance(state, { ...sub.draft, name: text });
    case 'sub.person.slackHandle':
      return subAdvance(state, { ...sub.draft, slackHandle: text });
    case 'sub.person.email':
      return subAdvance(state, { ...sub.draft, email: text });
    case 'sub.person.cadence':
      return subAdvance(state, { ...sub.draft, cadence: text });
    case 'sub.person.notes':
      return subAdvance(state, { ...sub.draft, notes: text });
    case 'sub.server.key': {
      if (!KEY_RE.test(text)) return fail(state, 'key must be letters, digits, - or _');
      const taken = Object.keys(state.answers.mcp.servers).some((k) => k === text && k !== sub.editKey);
      if (taken) return fail(state, `a server named "${text}" already exists`);
      return subAdvance(state, { ...sub.draft, key: text });
    }
    case 'sub.server.command':
      if (text === '') return fail(state, 'command is required');
      return subAdvance(state, { ...sub.draft, command: text });
    case 'sub.server.args':
      return subAdvance(state, { ...sub.draft, args: text });
    case 'sub.server.env':
      if (parseEnvPairs(text) === null) return fail(state, 'expected KEY=value pairs separated by commas');
      return subAdvance(state, { ...sub.draft, env: text });
    case 'sub.server.tools':
      if (parseToolList(text) === null) {
        return fail(state, 'expected tool names (letters, digits, - _), optionally :read or :action');
      }
      return subAdvance(state, { ...sub.draft, tools: text });
    case 'sub.checklist.every':
      if (!EVERY_RE.test(text)) return fail(state, 'expected <N><m|h|d>, e.g. 30m, 2h or 1d');
      return subAdvance(state, { ...sub.draft, every: text });
    case 'sub.checklist.text':
      if (text === '') return fail(state, 'instruction is required');
      return subAdvance(state, { ...sub.draft, text });
    default:
      return state;
  }
}

function subAdvance(state: WizardState, draft: Record<string, string>): WizardState {
  const cur = state.sub;
  if (!cur) return state;
  const sub: SubFlow = { ...cur, draft };
  if (sub.qIndex + 1 < subQuestions(sub).length) {
    return resetQ({ ...state, sub: { ...sub, qIndex: sub.qIndex + 1 } });
  }
  return commitSub({ ...state, sub });
}

function commitSub(state: WizardState): WizardState {
  const sub = state.sub;
  if (!sub) return state;
  const d = sub.draft;
  let answers = state.answers;
  let cursor = state.listCursor;

  if (sub.kind === 'person') {
    const weight = (d['weight'] ?? 'NORMAL') as TeamMemberAnswer['weight'];
    const person: TeamMemberAnswer = {
      name: d['name'] ?? '',
      weight,
      ...(d['slackHandle'] ? { slackHandle: d['slackHandle'] } : {}),
      ...(d['email'] ? { email: d['email'] } : {}),
      ...(d['cadence'] ? { cadence: d['cadence'] } : {}),
      ...(d['notes'] ? { notes: d['notes'] } : {}),
    };
    const people = [...answers.team.people];
    if (sub.editIndex === null) {
      people.push(person);
      cursor = people.length - 1;
    } else {
      people[sub.editIndex] = person;
      cursor = sub.editIndex;
    }
    answers = { ...answers, team: { people } };
  } else if (sub.kind === 'server') {
    const key = d['key'] ?? '';
    const server: McpServerAnswer = {
      type: 'stdio',
      command: d['command'] ?? '',
      args: (d['args'] ?? '').split(/\s+/).filter((t) => t !== ''),
      env: parseEnvPairs(d['env'] ?? '') ?? {},
      tools: parseToolList(d['tools'] ?? '') ?? {},
    };
    const servers = { ...answers.mcp.servers };
    if (sub.editKey !== null && sub.editKey !== key) delete servers[sub.editKey];
    servers[key] = server;
    answers = { ...answers, mcp: { servers } };
    cursor = Math.max(0, Object.keys(servers).indexOf(key));
  } else {
    const m = EVERY_RE.exec((d['every'] ?? '').trim());
    if (!m) return resetQ({ ...state, sub: null }); // can't happen — validated on entry
    const item = { every: Number(m[1]), unit: m[2] as 'm' | 'h' | 'd', text: d['text'] ?? '' };
    const checklist = [...answers.directives.checklist];
    if (sub.editIndex === null) {
      checklist.push(item);
      cursor = checklist.length - 1;
    } else {
      checklist[sub.editIndex] = item;
      cursor = sub.editIndex;
    }
    answers = { ...answers, directives: { ...answers.directives, checklist } };
  }
  return resetQ({ ...state, answers, sub: null, listCursor: cursor });
}

/** "K=V, K2=V2" → record (first = splits key from value). Empty → {}. null when malformed. */
export function parseEnvPairs(text: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const tok of text.split(',').map((t) => t.trim()).filter((t) => t !== '')) {
    const eq = tok.indexOf('=');
    if (eq <= 0) return null;
    out[tok.slice(0, eq).trim()] = tok.slice(eq + 1).trim();
  }
  return out;
}

/** "search send:action" → { search: 'read', send: 'action' }. Empty → {}. null when malformed. */
export function parseToolList(text: string): Record<string, 'read' | 'action'> | null {
  const out: Record<string, 'read' | 'action'> = {};
  for (const tok of text.split(/[\s,]+/).filter((t) => t !== '')) {
    const m = /^([a-zA-Z0-9_-]+)(?::(read|action))?$/.exec(tok);
    if (!m || m[1] === undefined) return null;
    out[m[1]] = (m[2] as 'read' | 'action' | undefined) ?? 'read';
  }
  return out;
}
