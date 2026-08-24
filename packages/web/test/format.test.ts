import { afterEach, describe, expect, it, vi } from 'vitest';
import { clock, daysUntil, priorityLabel, scheduleHint, shortDate, shortDateTime } from '../src/lib/format.js';

describe('priorityLabel (1 = HIGH, 2 = NORMAL, 3 = LOW — must match tui/src/format.ts)', () => {
  it('maps the unified 1..3 scale', () => {
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
});

// H2: date-only (`YYYY-MM-DD`) due dates must render/compare in the
// *viewer's local* calendar, not UTC. Run each assertion under an explicit
// zone so the suite is deterministic regardless of the host TZ.
function withTz<T>(tz: string, fn: () => T): T {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

describe('shortDate — date-only values render the local calendar day (H2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the day the string names, in any zone (UTC-3, UTC+9, UTC)', () => {
    withTz('America/Argentina/Buenos_Aires', () => {
      expect(shortDate('2026-08-21')).toBe('Aug 21');
    });
    withTz('Asia/Tokyo', () => {
      expect(shortDate('2026-08-21')).toBe('Aug 21');
    });
    withTz('UTC', () => {
      expect(shortDate('2026-08-21')).toBe('Aug 21');
    });
  });

  it('leaves full ISO instants exactly as before (still viewer-local, not date-only special-cased)', () => {
    withTz('America/Argentina/Buenos_Aires', () => {
      // 2026-08-22T01:00:00Z is 2026-08-21 22:00 local at UTC-3.
      expect(shortDate('2026-08-22T01:00:00.000Z')).toBe('Aug 21');
    });
  });

  it('keeps the invalid-input contract', () => {
    expect(shortDate(null)).toBe('–');
    expect(shortDate(undefined)).toBe('–');
    expect(shortDate('not-a-date')).toBe('not-a-date');
  });
});

describe('daysUntil — date-only due dates compare by local calendar day (H2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a date-only due date "today" is not overdue late in the local day', () => {
    withTz('America/Argentina/Buenos_Aires', () => {
      vi.setSystemTime(new Date(2026, 7, 21, 22, 36));
      expect(daysUntil('2026-08-21')).toBe(0);
    });
  });

  it('a date-only due date "tomorrow" is 1 day out, not 0 or -1', () => {
    withTz('America/Argentina/Buenos_Aires', () => {
      vi.setSystemTime(new Date(2026, 7, 21, 22, 36));
      expect(daysUntil('2026-08-22')).toBe(1);
    });
  });

  it('a date-only due date "yesterday" is overdue', () => {
    withTz('America/Argentina/Buenos_Aires', () => {
      vi.setSystemTime(new Date(2026, 7, 21, 22, 36));
      expect(daysUntil('2026-08-20')).toBe(-1);
    });
  });

  it('holds under a positive offset (Tokyo) and under UTC', () => {
    withTz('Asia/Tokyo', () => {
      vi.setSystemTime(new Date(2026, 7, 21, 22, 36));
      expect(daysUntil('2026-08-21')).toBe(0);
      expect(daysUntil('2026-08-22')).toBe(1);
    });
    withTz('UTC', () => {
      vi.setSystemTime(new Date(2026, 7, 21, 22, 36));
      expect(daysUntil('2026-08-21')).toBe(0);
      expect(daysUntil('2026-08-22')).toBe(1);
    });
  });

  it('leaves full ISO instants on the existing fractional-day math (unchanged)', () => {
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
    expect(daysUntil('2026-08-22T12:00:00.000Z')).toBe(1);
    expect(daysUntil('2026-08-20T12:00:00.000Z')).toBe(-1);
  });

  it('keeps the invalid-input contract', () => {
    expect(daysUntil(null)).toBeNull();
    expect(daysUntil(undefined)).toBeNull();
    expect(daysUntil('not-a-date')).toBeNull();
  });
});

// LOW: "until 22 ago" on the snoozed card — shortDate/shortDateTime/clock used
// `undefined` as the Intl locale, which inherits the *viewer's OS/browser*
// locale. On an es-* system that renders the month abbreviation in Spanish
// ("ago" for agosto) right next to this app's all-English labels ("until",
// "loaded"), reading as a typo. Pin to 'en-US' regardless of host locale —
// verify by spying on the underlying Intl call rather than actually flipping
// the process locale (Node's bundled ICU mostly ignores LANG/LC_ALL anyway,
// so that wouldn't reliably reproduce the bug in CI).
describe('date formatters always request en-US, never the viewer OS locale (LOW)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shortDate', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleDateString');
    shortDate('2026-08-22');
    expect(spy.mock.calls[0]?.[0]).toBe('en-US');
  });

  it('shortDateTime', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleString');
    shortDateTime('2026-08-22T10:00:00.000Z');
    expect(spy.mock.calls[0]?.[0]).toBe('en-US');
  });

  it('clock', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleTimeString');
    clock('2026-08-22T10:00:00.000Z');
    expect(spy.mock.calls[0]?.[0]).toBe('en-US');
  });
});

describe('shortDateTime / clock under a non-UTC TZ (test gap: format.ts was only TZ-tested via shortDate/daysUntil)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shortDateTime renders the viewer-local wall clock, not UTC', () => {
    withTz('America/Argentina/Buenos_Aires', () => {
      // 2026-08-22T01:00:00Z is 2026-08-21 22:00 local at UTC-3.
      expect(shortDateTime('2026-08-22T01:00:00.000Z')).toBe('Aug 21, 22:00');
    });
    withTz('Asia/Tokyo', () => {
      // 2026-08-22T01:00:00Z is 2026-08-22 10:00 local at UTC+9.
      expect(shortDateTime('2026-08-22T01:00:00.000Z')).toBe('Aug 22, 10:00');
    });
  });

  it('clock renders the viewer-local time only, in any zone', () => {
    withTz('America/Argentina/Buenos_Aires', () => {
      expect(clock('2026-08-22T01:00:00.000Z')).toBe('22:00');
    });
    withTz('Asia/Tokyo', () => {
      expect(clock('2026-08-22T01:00:00.000Z')).toBe('10:00');
    });
  });

  it('keeps the invalid-input contract', () => {
    expect(shortDateTime(null)).toBe('–');
    expect(clock(undefined)).toBe('–');
    expect(clock('not-a-date')).toBe('–');
  });
});

// Appendix E / §5.6: web had no off-hours/quiet-hours indicator (the TUI's
// `◔ quiet 22:00-08:00`). scheduleHint mirrors packages/tui/src/format.ts's
// function of the same name — keep the two in sync.
describe('scheduleHint', () => {
  const base = {
    withinWorkingHours: true,
    quietHours: false,
    workingHours: '08:00-19:00',
    quietHoursRange: '22:00-08:00',
    activeToday: true,
  };

  it('says nothing when the schedule is absent (older agent, or not fetched yet)', () => {
    expect(scheduleHint(null)).toBeNull();
    expect(scheduleHint(undefined)).toBeNull();
  });

  it('says nothing during ordinary working hours', () => {
    expect(scheduleHint(base)).toBeNull();
  });

  it('reports an inactive day first, regardless of the hour', () => {
    expect(scheduleHint({ ...base, activeToday: false, quietHours: true })).toBe('inactive today');
  });

  it('reports quiet hours with the configured range', () => {
    expect(scheduleHint({ ...base, quietHours: true })).toBe('quiet 22:00-08:00');
  });

  it('reports off-hours when outside working hours but not quiet', () => {
    expect(scheduleHint({ ...base, withinWorkingHours: false })).toBe('off-hours');
  });
});
