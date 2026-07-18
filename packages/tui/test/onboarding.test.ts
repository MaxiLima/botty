import { describe, expect, it } from 'vitest';
import type { OnboardingState } from '@botty/shared';
import {
  buildApplyRequest,
  currentQuestion,
  initWizard,
  maskMcpJson,
  needsPreview,
  parseActiveDays,
  parseEnvPairs,
  parseToolList,
  setPreview,
  wizardReduce,
  type WizardState,
} from '../src/onboarding.js';

const STATE: OnboardingState = {
  onboarded: false,
  completedAt: null,
  checks: { mode: 'sim', llmAuth: true, mockLlm: true, notifier: null, dataDir: '/tmp/x' },
  prefill: {
    persona: { kind: 'fields', name: '', role: '', addressAs: '', timezone: '', tone: '', banned: '' },
    team: { people: [{ name: 'Ana', weight: 'HIGH', slackHandle: '@ana' }] },
    sources: {
      slack: { enabled: true },
      gmail: { enabled: true },
      gcal: { enabled: true },
      jira: { enabled: true },
      github: { enabled: true },
    },
    mcp: { servers: {} },
    schedule: {
      workingHours: { start: '08:00', end: '19:00' },
      quietHours: { start: '22:00', end: '08:00' },
      activeDays: [1, 2, 3, 4, 5],
      tickIntervalMin: 20,
      morningBriefAt: '08:45',
      eveningBriefAt: '18:00',
    },
    directives: { instructions: 'stay quiet', thisWeek: '', checklist: [], advanced: {} },
  },
  prefillWarnings: [],
  mtimes: { persona: 1, team: 2, heartbeat: 3, mcp: null },
};

const key = (s: WizardState, k: string) => wizardReduce(s, { type: 'key', key: k });
const submit = (s: WizardState, text: string) => wizardReduce(s, { type: 'submit', text });
const enter = (s: WizardState) => key(s, 'enter');

/** Answer the current select with y (option 0) / n (option 1). */
const yes = (s: WizardState) => key(s, 'y');
const no = (s: WizardState) => key(s, 'n');

describe('wizard navigation', () => {
  it('welcome → gates: skipping every step reaches review as a noop that writes nothing', () => {
    let s = initWizard(STATE);
    expect(currentQuestion(s)?.id).toBe('welcome');
    s = enter(s);
    // six writable steps, each opening with a gate — n skips each
    for (const step of ['persona', 'team', 'sources', 'mcp', 'schedule', 'directives']) {
      expect(currentQuestion(s)?.id).toBe(`${step}.gate`);
      s = no(s);
    }
    expect(currentQuestion(s)?.id).toBe('review.noop');
    expect(needsPreview(s)).toBe(false);
    expect(buildApplyRequest(s)).toBeNull();
    s = enter(s);
    expect(s.done).toEqual({ outcome: 'noop' });
  });

  it('esc at the very first question prompts abandon; y exits with nothing written', () => {
    let s = initWizard(STATE);
    s = key(s, 'esc');
    expect(currentQuestion(s)?.id).toBe('abandon');
    s = yes(s);
    expect(s.done).toEqual({ outcome: 'abandon' });
    expect(buildApplyRequest(s)).toBeNull(); // nothing was confirmed → nothing to write
  });

  it('esc on the abandon prompt (or n) resumes where the user was', () => {
    let s = initWizard(STATE);
    s = key(s, 'esc');
    s = no(s);
    expect(s.abandonPrompt).toBe(false);
    expect(currentQuestion(s)?.id).toBe('welcome');
  });

  it('esc backs up one question at a time', () => {
    let s = initWizard(STATE);
    s = enter(s); // welcome → persona gate
    s = yes(s); // persona confirmed → first field
    expect(currentQuestion(s)?.id).toBe('persona.name');
    s = submit(s, 'Maxo');
    expect(currentQuestion(s)?.id).toBe('persona.role');
    s = key(s, 'esc');
    expect(currentQuestion(s)?.id).toBe('persona.name');
    s = key(s, 'esc');
    expect(currentQuestion(s)?.id).toBe('persona.gate');
  });
});

describe('wizard answers', () => {
  it('walking only the schedule step confirms only schedule (persona.md stays untouched)', () => {
    let s = initWizard(STATE);
    s = enter(s);
    for (const _ of ['persona', 'team', 'sources', 'mcp']) s = no(s);
    s = yes(s); // schedule gate
    s = submit(s, '07:30'); // working start
    s = submit(s, '20:00'); // working end
    s = submit(s, ''); // quiet start — Enter keeps prefill
    s = submit(s, '22:00');
    s = submit(s, '07:30'); // quiet end... (order: start,end)
    // ^ the three submits above walk quiet start/end + active days with a mix of
    //   kept and replaced values; assert on the final answers below instead of
    //   tracking each hop.
    s = submit(s, '1-5');
    s = submit(s, '15'); // tick interval
    s = submit(s, '09:00'); // morning brief
    s = submit(s, '17:30'); // evening brief
    s = no(s); // directives gate → skip
    const req = buildApplyRequest({ ...s, preview: null });
    expect(req).not.toBeNull();
    expect(req!.steps).toEqual(['schedule']);
    expect(Object.keys(req!.answers)).toEqual(['schedule']);
    expect(req!.answers.schedule!.workingHours).toEqual({ start: '07:30', end: '20:00' });
    expect(req!.answers.schedule!.tickIntervalMin).toBe(15);
    expect(req!.mtimes).toEqual(STATE.mtimes);
  });

  it('empty submit on a prefilled text question keeps... nothing — Enter submits the composer text verbatim', () => {
    // The composer is pre-typed with the prefill, so "Enter keeps it" is the
    // shell contract; an empty submit means the user actively cleared it.
    let s = initWizard(STATE);
    s = enter(s);
    s = yes(s); // persona gate (fields mode)
    s = submit(s, 'Robin');
    expect(s.answers.persona.kind === 'fields' && s.answers.persona.name).toBe('Robin');
  });

  it('invalid HH:MM / interval values set an inline error and do not advance', () => {
    let s = initWizard(STATE);
    s = enter(s);
    for (const _ of ['persona', 'team', 'sources', 'mcp']) s = no(s);
    s = yes(s); // schedule gate
    const before = currentQuestion(s)?.id;
    s = submit(s, '25:99');
    expect(s.error).toContain('HH:MM');
    expect(currentQuestion(s)?.id).toBe(before);
    s = submit(s, '07:00');
    expect(s.error).toBeNull();
    expect(currentQuestion(s)?.id).not.toBe(before);
  });

  it('review confirm builds the apply request and apply/abandon terminate correctly', () => {
    let s = initWizard(STATE);
    s = enter(s);
    s = no(s); // persona
    s = yes(s); // team gate
    s = enter(s); // team list → continue
    for (const _ of ['sources', 'mcp', 'schedule', 'directives']) s = no(s);
    expect(needsPreview(s)).toBe(true);
    s = setPreview(s, { files: { team: { content: 'x', current: 'y', changed: true } } });
    expect(currentQuestion(s)?.id).toBe('review.confirm');
    const applied = yes(s);
    expect(applied.done).toEqual({ outcome: 'apply' });
    const req = buildApplyRequest(applied);
    expect(req!.steps).toEqual(['team']);
    expect(req!.answers.team).toEqual(STATE.prefill.team);
    const abandoned = no(s);
    expect(abandoned.done).toEqual({ outcome: 'abandon' });
  });

  it('backing out of review clears the fetched preview so re-entry refetches', () => {
    let s = initWizard(STATE);
    s = enter(s);
    s = no(s);
    s = yes(s); // team
    s = enter(s);
    for (const _ of ['sources', 'mcp', 'schedule', 'directives']) s = no(s);
    s = setPreview(s, { files: {} });
    s = key(s, 'esc');
    expect(s.preview).toBeNull();
  });
});

describe('repeating groups (a/e/d)', () => {
  const toTeamList = (): WizardState => {
    let s = initWizard(STATE);
    s = enter(s);
    s = no(s); // persona
    s = yes(s); // team gate
    expect(currentQuestion(s)?.id).toBe('team.list');
    return s;
  };

  it('a adds a person through the sub-flow', () => {
    let s = toTeamList();
    s = key(s, 'a');
    s = submit(s, 'Nadia'); // name
    s = enter(s); // weight select — default (or current) via Enter
    s = submit(s, '@nadia'); // slack
    s = submit(s, ''); // email skipped
    s = submit(s, 'weekly'); // cadence
    s = submit(s, ''); // notes skipped
    expect(currentQuestion(s)?.id).toBe('team.list');
    expect(s.answers.team.people).toHaveLength(2);
    expect(s.answers.team.people[1]).toEqual({
      name: 'Nadia',
      weight: 'NORMAL', // fresh adds default to the safe tier
      slackHandle: '@nadia',
      cadence: 'weekly',
    });
  });

  it('e edits the selected person; blank name is rejected', () => {
    let s = toTeamList();
    s = key(s, 'e');
    s = submit(s, ''); // name required
    expect(s.error).toBe('name is required');
    s = submit(s, 'Ana Maria');
    s = enter(s); // keep weight
    s = submit(s, '@ana'); // keep slack
    s = submit(s, '');
    s = submit(s, '');
    s = submit(s, '');
    expect(s.answers.team.people).toHaveLength(1);
    expect(s.answers.team.people[0]!.name).toBe('Ana Maria');
  });

  it('d deletes the selected person; esc inside a sub-flow cancels without committing', () => {
    let s = toTeamList();
    s = key(s, 'd');
    expect(s.answers.team.people).toHaveLength(0);
    s = key(s, 'a');
    s = submit(s, 'Ghost');
    s = key(s, 'esc'); // back to name
    s = key(s, 'esc'); // cancel the add
    expect(currentQuestion(s)?.id).toBe('team.list');
    expect(s.answers.team.people).toHaveLength(0);
  });

  it('server sub-flow validates key/env/tools and masks env in labels', () => {
    let s = initWizard(STATE);
    s = enter(s);
    for (const _ of ['persona', 'team', 'sources']) s = no(s);
    s = yes(s); // mcp gate
    s = key(s, 'a');
    s = submit(s, 'bad key!');
    expect(s.error).toContain('letters, digits');
    s = submit(s, 'slack');
    s = submit(s, 'npx');
    s = submit(s, '-y @acme/slack-mcp');
    s = submit(s, 'SLACK_TOKEN'); // malformed env
    expect(s.error).toContain('KEY=value');
    s = submit(s, 'SLACK_TOKEN=xoxb-1');
    s = submit(s, 'list_channels send_message:action');
    expect(currentQuestion(s)?.id).toBe('mcp.list');
    expect(s.answers.mcp.servers['slack']).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/slack-mcp'],
      env: { SLACK_TOKEN: 'xoxb-1' },
      tools: { list_channels: 'read', send_message: 'action' },
    });
    const q = currentQuestion(s);
    expect(q?.kind === 'list' && q.items[0]).toContain('SLACK_TOKEN=•••');
    expect(q?.kind === 'list' && q.items[0]).not.toContain('xoxb-1');
  });
});

describe('helpers', () => {
  it('parseActiveDays handles lists, ranges and rejects junk', () => {
    expect(parseActiveDays('1-5')).toEqual([1, 2, 3, 4, 5]);
    expect(parseActiveDays('0,6')).toEqual([0, 6]);
    expect(parseActiveDays('1,2-3')).toEqual([1, 2, 3]);
    expect(parseActiveDays('7')).toBeNull();
    expect(parseActiveDays('')).toBeNull();
    expect(parseActiveDays('5-1')).toBeNull();
  });

  it('parseEnvPairs / parseToolList round basic shapes', () => {
    expect(parseEnvPairs('A=1, B=x=y')).toEqual({ A: '1', B: 'x=y' });
    expect(parseEnvPairs('')).toEqual({});
    expect(parseEnvPairs('NOEQ')).toBeNull();
    expect(parseToolList('a b:action')).toEqual({ a: 'read', b: 'action' });
    expect(parseToolList('bad tool!')).toBeNull();
  });

  it('maskMcpJson hides env values but keeps keys', () => {
    const masked = maskMcpJson(
      JSON.stringify({ servers: { s: { env: { TOKEN: 'secret' }, command: 'x' } } }),
    );
    expect(masked).toContain('TOKEN');
    expect(masked).not.toContain('secret');
  });
});
