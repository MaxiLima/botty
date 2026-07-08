import { describe, expect, it } from 'vitest';
import type { ProactiveLogRow } from '@botty/shared';
import { applyRulesFilter, type RulesConfig } from '../../src/loop/rules-filter.js';
import type { ProactiveCandidate } from '../../src/memory/index.js';

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
  } = {},
) {
  return applyRulesFilter(candidates, opts.config ?? config, NOW, opts.surfaces ?? [], {
    lastUserChatAt: opts.lastUserChatAt ?? null,
    mutedUntil: opts.mutedUntil ?? {},
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
});

describe('rules filter — gate 2: hard cap', () => {
  it('rejects at max_surfaces_per_task', () => {
    const t = candidate({ surfaceCount: 3, lastSurfacedAt: iso(-200 * HOUR) });
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
