import { describe, expect, it } from 'vitest';
import type { ScheduleInfo } from '../src/api.js';
import { byPriorityThenAge, priorityColor, priorityLabel, scheduleHint, summarizeGates, timeAgo } from '../src/format.js';

describe('priority semantics (must match web/lib/format.ts: 1 = HIGH, 2 = NORMAL, 3 = LOW)', () => {
  it('labels like the web app', () => {
    expect(priorityLabel(1)).toBe('P1');
    expect(priorityLabel(2)).toBe('P2');
    expect(priorityLabel(3)).toBe('P3');
  });

  it('clamps out-of-range values and falls back to NORMAL for garbage', () => {
    expect(priorityLabel(0)).toBe('P1');
    expect(priorityLabel(-5)).toBe('P1');
    expect(priorityLabel(9)).toBe('P3');
    expect(priorityLabel(NaN)).toBe('P2');
  });

  it('colors by urgency: high red, normal yellow, low cyan', () => {
    expect(priorityColor(1)).toBe('red');
    expect(priorityColor(2)).toBe('yellow');
    expect(priorityColor(3)).toBe('cyan');
  });

  it('sorts most urgent (lowest number) first, then oldest (same as TasksPage/briefings)', () => {
    const a = { priority: 3, createdAt: '2026-07-01' };
    const b = { priority: 1, createdAt: '2026-07-05' };
    const c = { priority: 1, createdAt: '2026-07-02' };
    expect([a, b, c].sort(byPriorityThenAge)).toEqual([c, b, a]);
  });
});

describe('timeAgo', () => {
  it('mirrors the web tiers', () => {
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    expect(timeAgo(at(30_000))).toBe('30s');
    expect(timeAgo(at(5 * 60_000))).toBe('5m');
    expect(timeAgo(at(89 * 60_000))).toBe('1h'); // floor, not round
    expect(timeAgo(null)).toBe('–');
  });
});

describe('scheduleHint', () => {
  const base: ScheduleInfo = {
    withinWorkingHours: true,
    quietHours: false,
    workingHours: '09:00-18:00',
    quietHoursRange: '22:00-08:00',
    activeToday: true,
  };

  it('degrades gracefully when the field is absent (older agents)', () => {
    expect(scheduleHint(undefined)).toBeNull();
    expect(scheduleHint(null)).toBeNull();
  });

  it('says nothing during ordinary working hours', () => {
    expect(scheduleHint(base)).toBeNull();
  });

  it('flags an inactive day first, regardless of the other flags', () => {
    expect(scheduleHint({ ...base, activeToday: false, quietHours: true })).toBe('inactive today');
  });

  it('flags quiet hours with the configured range', () => {
    expect(scheduleHint({ ...base, quietHours: true, withinWorkingHours: false })).toBe('quiet 22:00-08:00');
  });

  it('flags plain off-hours outside working hours', () => {
    expect(scheduleHint({ ...base, withinWorkingHours: false })).toBe('off-hours');
  });
});

describe('summarizeGates', () => {
  it('is null for absent or unparsable input', () => {
    expect(summarizeGates(null)).toBeNull();
    expect(summarizeGates(undefined)).toBeNull();
    expect(summarizeGates('')).toBeNull();
    expect(summarizeGates('not json')).toBeNull();
    expect(summarizeGates('42')).toBeNull();
  });

  it('counts a whole-tick timing skip', () => {
    expect(summarizeGates(JSON.stringify({ timing: 'quiet_hours' }))).toBe('(quiet_hours×1)');
  });

  it('aggregates per-candidate gate rejections, most-frequent first', () => {
    const rules = [
      { taskId: 't1', gate: 'quiet_hours' },
      { taskId: 't2', gate: 'cooldown' },
      { taskId: 't3', gate: 'quiet_hours' },
    ];
    expect(summarizeGates(JSON.stringify({ rules }))).toBe('(quiet_hours×2, cooldown×1)');
  });

  it('ignores malformed rule entries without throwing', () => {
    expect(summarizeGates(JSON.stringify({ rules: [null, { taskId: 't1' }, 'x'] }))).toBeNull();
  });
});
