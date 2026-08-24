import { beforeEach, describe, expect, it } from 'vitest';
import type { ProactiveLogRow } from '@botty/shared';
import { defaultTimeZone, localCalendarDate } from '../../src/chat/commitments.js';
import {
  applyRulesFilter,
  resetJudgmentMemoForTests,
  type RulesConfig,
} from '../../src/loop/rules-filter.js';
import type { ProactiveCandidate } from '../../src/memory/index.js';

// The sticky-skip gate (finding 2) is backed by a module-level memo — reset
// it between tests so one test's "presented to judgment" bookkeeping can
// never leak into another's assertions.
beforeEach(() => {
  resetJudgmentMemoForTests();
});

const NOW = '2026-07-03T15:00:00.000Z';
const nowMs = Date.parse(NOW);

const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
const HOUR = 3_600_000;
const MIN = 60_000;

/** Local "HH:MM" at NOW + offsetMinutes (quiet hours are evaluated in local time). */
function localHHMM(offsetMinutes: number): string {
  const d = new Date(nowMs + offsetMinutes * MIN);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// start === end disables quiet hours entirely.
const config: RulesConfig = {
  quietHours: { start: '00:00', end: '00:00' },
  maxSurfacesPerTask: 3,
  maxProactivePerHour: 2,
  minGapBetweenNudgesMin: 30,
};

let seq = 0;
function candidate(overrides: Partial<ProactiveCandidate> = {}): ProactiveCandidate {
  seq += 1;
  return {
    id: `task-${seq}`,
    description: 'a task',
    rawText: null,
    source: 'manual',
    sourceRef: null,
    status: 'open',
    priority: 2,
    requestedBy: null,
    projectId: null,
    dueDate: null,
    snoozeUntil: null,
    doneAt: null,
    surfaceCount: 0,
    lastSurfacedAt: null,
    createdAt: iso(-6 * HOUR),
    updatedAt: iso(-6 * HOUR),
    reminderReason: 'NEVER_SURFACED',
    ...overrides,
  };
}

function surface(overrides: Partial<ProactiveLogRow> = {}): ProactiveLogRow {
  seq += 1;
  return {
    id: `surface-${seq}`,
    taskId: 'other-task',
    surfaceKind: 'nudge',
    message: 'nudge',
    score: 8,
    trigger: 'schedule',
    surfacedAt: iso(-2 * HOUR),
    responseType: null,
    responseReason: null,
    responseAt: null,
    ...overrides,
  };
}

function run(
  candidates: ProactiveCandidate[],
  opts: {
    config?: RulesConfig;
    surfaces?: ProactiveLogRow[];
    lastUserChatAt?: string | null;
    mutedUntil?: Record<string, string | null>;
    runNow?: boolean;
  } = {},
) {
  return applyRulesFilter(candidates, opts.config ?? config, NOW, opts.surfaces ?? [], {
    lastUserChatAt: opts.lastUserChatAt ?? null,
    mutedUntil: opts.mutedUntil ?? {},
    runNow: opts.runNow,
  });
}

describe('rules filter — gate 1: cooldown', () => {
  it('rejects a task surfaced once within 48h', () => {
    const t = candidate({ surfaceCount: 1, lastSurfacedAt: iso(-24 * HOUR) });
    expect(run([t]).rejections).toEqual([{ taskId: t.id, gate: 'cooldown' }]);
  });
  it('passes once the 48h cooldown elapsed', () => {
    const t = candidate({ surfaceCount: 1, lastSurfacedAt: iso(-49 * HOUR) });
    expect(run([t]).survivors).toHaveLength(1);
  });
  it('escalates: 2 surfaces ⇒ 96h, 3+ ⇒ 7d', () => {
    const twice = candidate({ surfaceCount: 2, lastSurfacedAt: iso(-72 * HOUR) });
    expect(run([twice]).rejections[0]?.gate).toBe('cooldown');
    const thrice = candidate({
      surfaceCount: 3,
      lastSurfacedAt: iso(-100 * HOUR),
      dueDate: iso(24 * HOUR), // avoid the hard cap so cooldown is the failing gate
    });
    expect(run([thrice]).rejections[0]?.gate).toBe('cooldown');
  });

  // H3: a snooze coming due is the user's own explicit "remind me then" — the
  // cooldown that damps organic re-nagging about the SAME unaddressed task
  // doesn't apply to a request the user scheduled themselves.
  it('waives the cooldown for reminderReason SNOOZE_EXPIRED', () => {
    const t = candidate({
      surfaceCount: 1,
      lastSurfacedAt: iso(-24 * HOUR), // well inside the normal 48h cooldown
      reminderReason: 'SNOOZE_EXPIRED',
    });
    expect(run([t]).survivors).toHaveLength(1);
  });

  // Finding 3 (2026-08-21 report, Appendix A): a task nudged yesterday as
  // NEVER_SURFACED and now due in 2h shouldn't stay blocked until the 48h
  // cooldown lapses — the user's own timeline should override our pacing.
  describe('urgency exemption (finding 3)', () => {
    it('waives the cooldown when the task becomes due inside the 24h notify window', () => {
      const t = candidate({
        surfaceCount: 1,
        lastSurfacedAt: iso(-1 * HOUR), // deep inside the 48h cooldown
        dueDate: iso(2 * HOUR), // due in 2h
        reminderReason: 'NEVER_SURFACED',
      });
      expect(run([t]).survivors).toHaveLength(1);
    });

    it('still applies the cooldown when the due date is beyond the notify window', () => {
      const t = candidate({
        surfaceCount: 1,
        lastSurfacedAt: iso(-1 * HOUR),
        dueDate: iso(48 * HOUR), // due in 2 days — not urgent
        reminderReason: 'NEVER_SURFACED',
      });
      expect(run([t]).rejections).toEqual([{ taskId: t.id, gate: 'cooldown' }]);
    });

    it('still applies the cooldown when there is no due date at all', () => {
      const t = candidate({
        surfaceCount: 1,
        lastSurfacedAt: iso(-1 * HOUR),
        dueDate: null,
        reminderReason: 'NEVER_SURFACED',
      });
      expect(run([t]).rejections).toEqual([{ taskId: t.id, gate: 'cooldown' }]);
    });
  });
});

describe('rules filter — sticky skip / judgment economy (finding 2)', () => {
  it('withholds a candidate re-presented with the same reason and unchanged state', () => {
    const t = candidate({ reminderReason: 'STALE' });
    const first = run([t]);
    expect(first.survivors).toHaveLength(1);

    // Same task object (same id, reason, and mutable state) reappears next tick.
    const second = run([t]);
    expect(second.rejections).toEqual([{ taskId: t.id, gate: 'judgment_skip_cooldown' }]);
  });

  it('runs LAST: never masks the real reason a candidate was held back', () => {
    // Regression (caught by `npm run e2e --only gates`): the economy gate used
    // to sit at position 1.5 and shadowed quiet_hours / user_active / muted, so
    // the tick log and the Inspector reported "judgment_skip_cooldown" for a
    // task that was actually being held back by quiet hours. The gate exists to
    // save an LLM call, not to explain anything to the user — so it goes last.
    const t = candidate({ reminderReason: 'STALE', requestedBy: 'person-diego' });
    expect(run([t]).survivors).toHaveLength(1); // memoized

    const quietConfig: RulesConfig = { ...config, quietHours: { start: '00:00', end: '23:59' } };
    expect(run([t], { config: quietConfig }).rejections).toEqual([
      { taskId: t.id, gate: 'quiet_hours' },
    ]);
    expect(
      run([t], { mutedUntil: { 'person-diego': iso(4 * HOUR) } }).rejections,
    ).toEqual([{ taskId: t.id, gate: 'muted' }]);
    expect(run([t], { lastUserChatAt: iso(-1 * 60_000) }).rejections).toEqual([
      { taskId: t.id, gate: 'user_active' },
    ]);

    // …and with nothing else blocking it, the economy gate still applies.
    expect(run([t]).rejections).toEqual([{ taskId: t.id, gate: 'judgment_skip_cooldown' }]);
  });

  it('never suppresses a user-triggered run-now (explicit request for a fresh pass)', () => {
    const t = candidate({ reminderReason: 'STALE' });
    run([t]);
    expect(run([t], { runNow: true }).survivors).toHaveLength(1);
  });

  it('lets the candidate through again once its reason changes', () => {
    const t = candidate({ reminderReason: 'STALE' });
    run([t]);
    const changed = { ...t, reminderReason: 'DUE_SOON' as const };
    expect(run([changed]).survivors).toHaveLength(1);
  });

  it('lets the candidate through again once its proactive state changes (e.g. surfaceCount bumped by a real notify)', () => {
    const t = candidate({ reminderReason: 'STALE', surfaceCount: 0 });
    run([t]);
    const notified = { ...t, surfaceCount: 1, lastSurfacedAt: iso(0) };
    // surfaceCount>0 now means gate 1 (cooldown) evaluates too, so keep it
    // well clear of any cooldown window to isolate the sticky-skip behavior.
    expect(run([notified], { config: { ...config, surfaceCooldownHours: { 1: 0, 2: 0, 3: 0 } } }).survivors).toHaveLength(1);
  });

  it('never suppresses reminderReason SNOOZE_EXPIRED even with identical state', () => {
    const t = candidate({ reminderReason: 'SNOOZE_EXPIRED' });
    run([t]);
    expect(run([t]).survivors).toHaveLength(1);
  });

  it('never suppresses a candidate whose due date has moved inside the notify window', () => {
    const t = candidate({ reminderReason: 'DUE_SOON', dueDate: iso(30 * HOUR) });
    run([t]);
    const urgent = { ...t, dueDate: iso(2 * HOUR) };
    expect(run([urgent]).survivors).toHaveLength(1);
  });

  it('re-admits the candidate once the sticky-skip cooldown lapses', () => {
    const t = candidate({ reminderReason: 'STALE' });
    run([t]);
    // 7h later — past the 6h sticky-skip cooldown — same reason/state otherwise.
    const laterNow = iso(7 * HOUR);
    const res = applyRulesFilter([t], config, laterNow, [], {});
    expect(res.survivors).toHaveLength(1);
  });
});

describe('rules filter — run-now (finding 5)', () => {
  it('waives quiet hours for a run-now request', () => {
    const quietConfig = { ...config, quietHours: { start: localHHMM(-60), end: localHHMM(60) } };
    const t = candidate();
    expect(run([t], { config: quietConfig, runNow: true }).survivors).toHaveLength(1);
  });

  it('still applies quiet hours when runNow is not set (default preserves today\'s behavior)', () => {
    const quietConfig = { ...config, quietHours: { start: localHHMM(-60), end: localHHMM(60) } };
    const t = candidate();
    expect(run([t], { config: quietConfig }).rejections).toEqual([
      { taskId: t.id, gate: 'quiet_hours' },
    ]);
  });

  it('waives the user-active gate for a run-now request', () => {
    const t = candidate();
    const res = run([t], { lastUserChatAt: iso(-1 * MIN), runNow: true });
    expect(res.survivors).toHaveLength(1);
  });

  it('does not waive the hard cap for a run-now request', () => {
    const t = candidate({ surfaceCount: 3, lastSurfacedAt: iso(-200 * HOUR) });
    expect(run([t], { runNow: true }).rejections).toEqual([{ taskId: t.id, gate: 'hard_cap' }]);
  });

  it('does not waive mute for a run-now request', () => {
    const t = candidate({ requestedBy: 'person-1' });
    const res = run([t], { mutedUntil: { 'person-1': iso(24 * HOUR) }, runNow: true });
    expect(res.rejections).toEqual([{ taskId: t.id, gate: 'muted' }]);
  });
});

describe('rules filter — gate 2: hard cap', () => {
  it('rejects at max_surfaces_per_task', () => {
    const t = candidate({ surfaceCount: 3, lastSurfacedAt: iso(-200 * HOUR) });
    expect(run([t]).rejections).toEqual([{ taskId: t.id, gate: 'hard_cap' }]);
  });

  // H3: the cooldown waiver above must NOT also waive the hard cap — this is
  // the ceiling that keeps a repeatedly-snoozed task from becoming an
  // infinite nag; lifetime notifies still top out at maxSurfacesPerTask.
  it('still applies the hard cap to a SNOOZE_EXPIRED candidate (no cooldown waiver bypass)', () => {
    const t = candidate({
      surfaceCount: 3,
      lastSurfacedAt: iso(-200 * HOUR),
      reminderReason: 'SNOOZE_EXPIRED',
    });
    expect(run([t]).rejections).toEqual([{ taskId: t.id, gate: 'hard_cap' }]);
  });
  it('waives the cap when due within 48h', () => {
    const t = candidate({
      surfaceCount: 3,
      lastSurfacedAt: iso(-200 * HOUR),
      dueDate: iso(24 * HOUR),
    });
    expect(run([t]).survivors).toHaveLength(1);
  });

  // H2 (2026-08-21 investigation): Date.parse('YYYY-MM-DD') is UTC midnight, so
  // a date-only dueDate used to read as already-overdue hours before its local
  // calendar day even started for negative-offset users — see loop/time.ts
  // dueDateInstant. localCalendarDate keeps this test correct under any TZ the
  // suite runs in (the "process zone is the user's zone" assumption).
  it('waives the cap for a date-only due date that is LOCAL tomorrow, not a UTC-midnight read', () => {
    const t = candidate({
      surfaceCount: 3,
      lastSurfacedAt: iso(-200 * HOUR),
      dueDate: localCalendarDate(iso(24 * HOUR), defaultTimeZone()),
    });
    expect(run([t]).survivors).toHaveLength(1);
  });

  it('still applies the cap for a date-only due date several local days out', () => {
    const t = candidate({
      surfaceCount: 3,
      lastSurfacedAt: iso(-200 * HOUR),
      dueDate: localCalendarDate(iso(5 * 24 * HOUR), defaultTimeZone()),
    });
    expect(run([t]).rejections).toEqual([{ taskId: t.id, gate: 'hard_cap' }]);
  });
});

describe('rules filter — gate 3: snoozed', () => {
  it('rejects while snooze_until is in the future', () => {
    const t = candidate({ snoozeUntil: iso(1 * HOUR) });
    expect(run([t]).rejections).toEqual([{ taskId: t.id, gate: 'snoozed' }]);
  });
  it('passes after the snooze expired', () => {
    const t = candidate({ snoozeUntil: iso(-1 * HOUR) });
    expect(run([t]).survivors).toHaveLength(1);
  });
});

describe('rules filter — gate 4: closed status', () => {
  it('rejects non-open tasks', () => {
    const t = candidate({ status: 'done' });
    expect(run([t]).rejections).toEqual([{ taskId: t.id, gate: 'closed' }]);
  });
  it('passes open tasks', () => {
    expect(run([candidate()]).survivors).toHaveLength(1);
  });
});

describe('rules filter — gate 5: quiet hours', () => {
  it('rejects everything inside the quiet window (wraps candidates individually)', () => {
    const quietConfig = { ...config, quietHours: { start: localHHMM(-60), end: localHHMM(60) } };
    const t = candidate();
    expect(run([t], { config: quietConfig }).rejections).toEqual([
      { taskId: t.id, gate: 'quiet_hours' },
    ]);
  });
  it('passes outside the quiet window', () => {
    const quietConfig = { ...config, quietHours: { start: localHHMM(120), end: localHHMM(180) } };
    expect(run([candidate()], { config: quietConfig }).survivors).toHaveLength(1);
  });
});

describe('rules filter — gate 6: global min gap', () => {
  it('rejects when any nudge surfaced within min_gap', () => {
    const t = candidate();
    const res = run([t], { surfaces: [surface({ surfacedAt: iso(-10 * MIN) })] });
    expect(res.rejections).toEqual([{ taskId: t.id, gate: 'min_gap' }]);
  });
  it('passes once the gap elapsed', () => {
    const res = run([candidate()], { surfaces: [surface({ surfacedAt: iso(-31 * MIN) })] });
    expect(res.survivors).toHaveLength(1);
  });
  it('ignores briefings (they are not nudges)', () => {
    const res = run([candidate()], {
      surfaces: [surface({ surfaceKind: 'morning_brief', surfacedAt: iso(-5 * MIN) })],
    });
    expect(res.survivors).toHaveLength(1);
  });
});

describe('rules filter — gate 7: user active in chat', () => {
  it('rejects when the user chatted within 2 min', () => {
    const t = candidate();
    const res = run([t], { lastUserChatAt: iso(-1 * MIN) });
    expect(res.rejections).toEqual([{ taskId: t.id, gate: 'user_active' }]);
  });
  it('passes when the last chat message is older', () => {
    const res = run([candidate()], { lastUserChatAt: iso(-3 * MIN) });
    expect(res.survivors).toHaveLength(1);
  });
});

describe('rules filter — gate 8: hourly cap', () => {
  it('rejects when max_proactive_per_hour nudges already fired', () => {
    const t = candidate();
    const res = run([t], {
      surfaces: [surface({ surfacedAt: iso(-40 * MIN) }), surface({ surfacedAt: iso(-45 * MIN) })],
    });
    expect(res.rejections).toEqual([{ taskId: t.id, gate: 'hourly_cap' }]);
  });
  it('passes below the cap', () => {
    const res = run([candidate()], { surfaces: [surface({ surfacedAt: iso(-40 * MIN) })] });
    expect(res.survivors).toHaveLength(1);
  });
});

describe('rules filter — gate 9: requester muted', () => {
  it('rejects tasks from a muted requester', () => {
    const t = candidate({ requestedBy: 'person-1' });
    const res = run([t], { mutedUntil: { 'person-1': iso(24 * HOUR) } });
    expect(res.rejections).toEqual([{ taskId: t.id, gate: 'muted' }]);
  });
  it('passes once the mute expired', () => {
    const t = candidate({ requestedBy: 'person-1' });
    const res = run([t], { mutedUntil: { 'person-1': iso(-1 * HOUR) } });
    expect(res.survivors).toHaveLength(1);
  });
});

describe('rules filter — ordering & aggregate', () => {
  it('reports the FIRST failing gate in spec order', () => {
    // Both snoozed and closed — cooldown/hard-cap clean — snoozed (gate 3) must win over closed (4).
    const t = candidate({ snoozeUntil: iso(1 * HOUR), status: 'done' });
    expect(run([t]).rejections).toEqual([{ taskId: t.id, gate: 'snoozed' }]);
  });
  it('splits a mixed batch into survivors and rejections', () => {
    const ok = candidate();
    const bad = candidate({ status: 'cancelled' });
    const res = run([ok, bad]);
    expect(res.survivors.map((s) => s.id)).toEqual([ok.id]);
    expect(res.rejections).toEqual([{ taskId: bad.id, gate: 'closed' }]);
  });
});
