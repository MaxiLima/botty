import { describe, expect, it } from 'vitest';
import { ONBOARDING_STEPS } from '@botty/shared';
import type { DirectivesAnswers, TeamAnswers } from '@botty/shared';
import {
  buildOnboardingRequest,
  stripBlankChecklistRows,
  stripBlankTeamRows,
  type OnboardingRequestAnswers,
} from '../src/pages/OnboardingPage/buildRequest.js';

const emptyPersona = { kind: 'raw' as const, content: '' };
const emptySources = {
  slack: { enabled: true },
  gmail: { enabled: true },
  gcal: { enabled: true },
  jira: { enabled: true },
  github: { enabled: true },
};
const emptySchedule = {
  workingHours: { start: '08:00', end: '19:00' },
  quietHours: { start: '22:00', end: '08:00' },
  activeDays: [1, 2, 3, 4, 5],
  tickIntervalMin: 20,
  morningBriefAt: '08:45',
  eveningBriefAt: '18:00',
};

function answers(overrides: Partial<OnboardingRequestAnswers> = {}): OnboardingRequestAnswers {
  return {
    persona: emptyPersona,
    team: { people: [] },
    sources: emptySources,
    mcp: { servers: {} },
    schedule: emptySchedule,
    directives: { instructions: '', thisWeek: '', checklist: [], advanced: {} },
    ...overrides,
  };
}

describe('stripBlankTeamRows', () => {
  it('drops rows with a blank (or whitespace-only) name', () => {
    const team: TeamAnswers = {
      people: [
        { name: 'Diego', weight: 'HIGH' },
        { name: '', weight: 'NORMAL' },
        { name: '   ', weight: 'NORMAL' },
        { name: 'Sofi', weight: 'CRITICAL' },
      ],
    };
    expect(stripBlankTeamRows(team).people.map((p) => p.name)).toEqual(['Diego', 'Sofi']);
  });

  it('leaves a fully populated roster untouched', () => {
    const team: TeamAnswers = { people: [{ name: 'Diego', weight: 'HIGH' }] };
    expect(stripBlankTeamRows(team)).toEqual(team);
  });

  it('an all-blank roster (every row left empty) becomes an empty roster, not a 400', () => {
    const team: TeamAnswers = { people: [{ name: '', weight: 'NORMAL' }] };
    expect(stripBlankTeamRows(team)).toEqual({ people: [] });
  });
});

describe('stripBlankChecklistRows', () => {
  it('drops checklist rows with blank text, keeps the rest of the directives intact', () => {
    const directives: DirectivesAnswers = {
      instructions: 'be terse',
      thisWeek: 'ship the release',
      checklist: [
        { every: 1, unit: 'd', text: 'stand-up notes' },
        { every: 1, unit: 'd', text: '' },
        { every: 2, unit: 'h', text: '  ' },
      ],
      advanced: {},
    };
    const cleaned = stripBlankChecklistRows(directives);
    expect(cleaned.checklist).toEqual([{ every: 1, unit: 'd', text: 'stand-up notes' }]);
    expect(cleaned.instructions).toBe('be terse');
    expect(cleaned.thisWeek).toBe('ship the release');
  });
});

describe('buildOnboardingRequest', () => {
  it('returns null when no step was confirmed (every step skipped)', () => {
    expect(buildOnboardingRequest(answers(), new Set(), ONBOARDING_STEPS, null)).toBeNull();
  });

  it('only includes confirmed steps', () => {
    const req = buildOnboardingRequest(answers(), new Set(['persona', 'schedule']), ONBOARDING_STEPS, null);
    expect(req?.steps).toEqual(['persona', 'schedule']);
  });

  it('strips a blank "+ add" row left behind on a confirmed team step, so preview/apply does not 400', () => {
    const req = buildOnboardingRequest(
      answers({ team: { people: [{ name: 'Diego', weight: 'HIGH' }, { name: '', weight: 'NORMAL' }] } }),
      new Set(['team']),
      ONBOARDING_STEPS,
      null,
    );
    expect(req?.answers.team.people).toEqual([{ name: 'Diego', weight: 'HIGH' }]);
  });

  it('strips a blank checklist row on a confirmed directives step', () => {
    const req = buildOnboardingRequest(
      answers({
        directives: {
          instructions: '',
          thisWeek: '',
          checklist: [{ every: 1, unit: 'd', text: '' }],
          advanced: {},
        },
      }),
      new Set(['directives']),
      ONBOARDING_STEPS,
      null,
    );
    expect(req?.answers.directives.checklist).toEqual([]);
  });

  it('leaves an unconfirmed (skipped) step\'s blank rows alone — its file is never written anyway', () => {
    const req = buildOnboardingRequest(
      answers({ team: { people: [{ name: '', weight: 'NORMAL' }] } }),
      new Set(['schedule']),
      ONBOARDING_STEPS,
      null,
    );
    // team wasn't confirmed, so it's not in `steps` — but the answers blob is
    // still stripped uniformly (cheap and never wrong: an unconfirmed step's
    // answers are never applied server-side regardless of their content).
    expect(req?.steps).toEqual(['schedule']);
    expect(req?.answers.team.people).toEqual([]);
  });

  it('passes mtimes through unchanged', () => {
    const mtimes = { persona: 1, team: 2, heartbeat: 3, mcp: null };
    const req = buildOnboardingRequest(answers(), new Set(['persona']), ONBOARDING_STEPS, mtimes);
    expect(req?.mtimes).toBe(mtimes);
  });
});
