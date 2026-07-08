import { describe, expect, it } from 'vitest';
import { byPriorityThenAge, priorityColor, priorityLabel, timeAgo } from '../src/format.js';

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
