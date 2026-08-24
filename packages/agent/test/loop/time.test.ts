import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultTimeZone } from '../../src/chat/commitments.js';
import {
  dueDateInstant,
  isQuietHours,
  isWithinWorkingHours,
  msUntilNextTime,
} from '../../src/loop/time.js';

// Local-time ISO strings (no Z) so results don't depend on the machine's TZ.
// 2026-07-01 = Wednesday · 2026-07-04 = Saturday · 2026-07-05 = Sunday.
const WEEKDAYS = [1, 2, 3, 4, 5];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

describe('isWithinWorkingHours', () => {
  const std = { workingHours: { start: '08:00', end: '19:00' }, activeDays: WEEKDAYS };

  it('true inside the window on an active day', () => {
    expect(isWithinWorkingHours('2026-07-01T08:00:00', std)).toBe(true);
    expect(isWithinWorkingHours('2026-07-01T12:30:00', std)).toBe(true);
    expect(isWithinWorkingHours('2026-07-01T18:59:00', std)).toBe(true);
  });

  it('false outside the window on an active day', () => {
    expect(isWithinWorkingHours('2026-07-01T07:59:00', std)).toBe(false);
    expect(isWithinWorkingHours('2026-07-01T23:30:00', std)).toBe(false);
  });

  // Loop timers finding #1: a briefing (or tick) scheduled for exactly
  // working_hours.end must still fire — the gate is re-checked at fire time
  // (loop/index.ts), so an exclusive end dropped it in the very minute it was
  // computed for. The boundary minute is IN; the minute after is OUT.
  it('the end boundary minute is inclusive; the minute after is not', () => {
    expect(isWithinWorkingHours('2026-07-01T19:00:00', std)).toBe(true);
    expect(isWithinWorkingHours('2026-07-01T19:00:59', std)).toBe(true);
    expect(isWithinWorkingHours('2026-07-01T19:01:00', std)).toBe(false);
  });

  it('false on inactive days even inside the time window', () => {
    expect(isWithinWorkingHours('2026-07-04T12:00:00', std)).toBe(false); // Saturday
    expect(isWithinWorkingHours('2026-07-05T12:00:00', std)).toBe(false); // Sunday
  });

  it('handles windows that cross midnight', () => {
    const night = { workingHours: { start: '22:00', end: '06:00' }, activeDays: ALL_DAYS };
    expect(isWithinWorkingHours('2026-07-01T23:00:00', night)).toBe(true);
    expect(isWithinWorkingHours('2026-07-01T02:00:00', night)).toBe(true);
    expect(isWithinWorkingHours('2026-07-01T12:00:00', night)).toBe(false);
    expect(isWithinWorkingHours('2026-07-01T06:00:00', night)).toBe(true); // end inclusive
    expect(isWithinWorkingHours('2026-07-01T06:01:00', night)).toBe(false);
    // the active-day check applies to the calendar day of `now` itself
    const nightWeekdays = { ...night, activeDays: WEEKDAYS };
    expect(isWithinWorkingHours('2026-07-04T02:00:00', nightWeekdays)).toBe(false); // Sat early AM
  });

  it('degenerate or malformed windows disable the gate (always within)', () => {
    expect(
      isWithinWorkingHours('2026-07-01T03:00:00', {
        workingHours: { start: '00:00', end: '00:00' },
        activeDays: ALL_DAYS,
      }),
    ).toBe(true);
    expect(
      isWithinWorkingHours('2026-07-01T03:00:00', {
        workingHours: { start: 'nope', end: '19:00' },
        activeDays: ALL_DAYS,
      }),
    ).toBe(true);
    // ... but inactive days still gate
    expect(
      isWithinWorkingHours('2026-07-04T03:00:00', {
        workingHours: { start: '00:00', end: '00:00' },
        activeDays: WEEKDAYS,
      }),
    ).toBe(false);
  });
});

// Direct coverage for isQuietHours — previously only exercised indirectly
// through rules-filter.ts. Same start/end/wrap semantics as isWithinWorkingHours
// EXCEPT the end boundary here stays exclusive: quiet hours are a "should we
// suppress a nudge" gate, not a "did the scheduled event's minute arrive" gate,
// so there's no fire-time boundary-drop bug to fix for it (see finding #1,
// scoped to isWithinWorkingHours only).
describe('isQuietHours', () => {
  it('true inside a same-day quiet window, false at/after the end', () => {
    const quiet = { start: '22:00', end: '23:00' };
    expect(isQuietHours('2026-07-01T21:59:00', quiet)).toBe(false);
    expect(isQuietHours('2026-07-01T22:00:00', quiet)).toBe(true);
    expect(isQuietHours('2026-07-01T22:30:00', quiet)).toBe(true);
    expect(isQuietHours('2026-07-01T23:00:00', quiet)).toBe(false); // end exclusive
  });

  it('wraps midnight', () => {
    const quiet = { start: '22:00', end: '08:00' };
    expect(isQuietHours('2026-07-01T23:30:00', quiet)).toBe(true);
    expect(isQuietHours('2026-07-01T02:00:00', quiet)).toBe(true);
    expect(isQuietHours('2026-07-01T08:00:00', quiet)).toBe(false); // end exclusive
    expect(isQuietHours('2026-07-01T12:00:00', quiet)).toBe(false);
  });

  it('degenerate or malformed windows disable the gate (never quiet)', () => {
    expect(isQuietHours('2026-07-01T23:00:00', { start: '00:00', end: '00:00' })).toBe(false);
    expect(isQuietHours('2026-07-01T23:00:00', { start: 'nope', end: '08:00' })).toBe(false);
  });
});

describe('msUntilNextTime', () => {
  it('returns ms until the next occurrence today when later the same day', () => {
    const from = new Date('2026-07-01T08:00:00');
    expect(msUntilNextTime(from, '08:30')).toBe(30 * 60_000);
  });

  it('rolls over to tomorrow when the time already passed (or is now)', () => {
    const from = new Date('2026-07-01T08:00:00');
    expect(msUntilNextTime(from, '08:00')).toBe(24 * 60 * 60_000); // "strictly after"
    expect(msUntilNextTime(from, '07:59')).toBe((23 * 60 + 59) * 60_000);
  });

  // Regression: an unparseable/out-of-range time used to fall back to
  // `parseHHMM(hhmm) ?? 0` (midnight) via the nullish-coalescing default,
  // silently arming a real timer for 00:00 instead of not arming at all.
  it.each(['25:00', '09:75', 'nope', '', '24:00'])(
    'returns null for garbage input "%s" instead of arming for midnight',
    (bad) => {
      const from = new Date('2026-07-01T08:00:00');
      expect(msUntilNextTime(from, bad)).toBeNull();
    },
  );

  // Loop timers finding #5 (test gap): msUntilNextTime builds its result from
  // local wall-clock fields (setHours/getTime), so a DST transition inside the
  // gap between `from` and the target changes the real elapsed ms even though
  // "HH:MM" didn't change. America/Argentina/Buenos_Aires has no DST, so these
  // exercise a zone that does: America/New_York, 2026 transitions verified
  // against the actual V8/ICU Date resolution (ground truth captured by
  // running the same setHours logic under TZ=America/New_York — see
  // packages/agent — not hand-derived, since nonexistent/ambiguous local times
  // resolve per engine-specific rules).
  describe('DST transitions (America/New_York)', () => {
    let originalTz: string | undefined;
    beforeEach(() => {
      originalTz = process.env.TZ;
      process.env.TZ = 'America/New_York';
    });
    afterEach(() => {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    });

    it('spring-forward gap: 2026-03-08, 02:00-02:59 local does not exist (EST -> EDT)', () => {
      const from = new Date(2026, 2, 8, 0, 0, 0); // March 8 00:00 EST (UTC-5)
      // Normal pre-gap target: still EST, ordinary 90-minute gap.
      expect(msUntilNextTime(from, '01:30')).toBe(90 * 60_000);
      // Targets that fall inside/after the gap land on the EDT (UTC-4) side —
      // the "missing hour" shows up as a smaller ms delta than the naive
      // HH:MM arithmetic would predict, because clocks skip forward 05:00Z.
      expect(new Date(from.getTime() + msUntilNextTime(from, '02:30')!).toISOString()).toBe(
        '2026-03-08T07:30:00.000Z', // 02:30 local doesn't exist; resolves to 03:30 EDT
      );
      expect(new Date(from.getTime() + msUntilNextTime(from, '03:00')!).toISOString()).toBe(
        '2026-03-08T07:00:00.000Z', // 03:00 EDT, the first real local time after the gap
      );
    });

    it('fall-back repeat: 2026-11-01, 01:00-01:59 local occurs twice (EDT -> EST)', () => {
      const from = new Date(2026, 10, 1, 0, 0, 0); // Nov 1 00:00 EDT (UTC-4)
      // 01:xx is ambiguous (happens once at EDT, once at EST); setHours-based
      // construction deterministically resolves to the FIRST (EDT) occurrence.
      expect(new Date(from.getTime() + msUntilNextTime(from, '01:30')!).toISOString()).toBe(
        '2026-11-01T05:30:00.000Z',
      );
      // Once past the ambiguous hour, targets land on the EST (UTC-5) side —
      // the "repeated hour" shows up as a LARGER ms delta than naive HH:MM
      // arithmetic would predict, because clocks fall back at 06:00Z.
      expect(new Date(from.getTime() + msUntilNextTime(from, '02:00')!).toISOString()).toBe(
        '2026-11-01T07:00:00.000Z',
      );
      expect(msUntilNextTime(from, '02:00')).toBe(10_800_000); // 3h, not the usual 2h
    });
  });
});

// H2 (2026-08-21 investigation): Date.parse('YYYY-MM-DD') is UTC MIDNIGHT, so a
// date-only due value read hours "early" for negative-offset users — a task due
// tomorrow was already "due within 48h"/overdue at 21:00 tonight in UTC-3.
describe('dueDateInstant — date-only due dates compare as end of LOCAL day, not UTC midnight', () => {
  it('negative offset: end of the local day, not UTC midnight of that date', () => {
    // 23:59:59 local in Buenos Aires (UTC-3) == 02:59:59Z the NEXT day.
    expect(dueDateInstant('2026-08-22', 'America/Argentina/Buenos_Aires')).toBe(
      Date.parse('2026-08-23T02:59:59.000Z'),
    );
  });

  it('positive offset: end of the local day rolls back into the SAME UTC date', () => {
    // 23:59:59 local in Tokyo (UTC+9) == 14:59:59Z the SAME date.
    expect(dueDateInstant('2026-08-22', 'Asia/Tokyo')).toBe(Date.parse('2026-08-22T14:59:59.000Z'));
  });

  it('half-hour offset', () => {
    // 23:59:59 local in Kolkata (UTC+5:30) == 18:29:59Z the same date.
    expect(dueDateInstant('2026-08-22', 'Asia/Kolkata')).toBe(
      Date.parse('2026-08-22T18:29:59.000Z'),
    );
  });

  it('a full instant (has a time component) is trusted and used as-is', () => {
    expect(dueDateInstant('2026-08-22T10:00:00.000Z', 'America/Argentina/Buenos_Aires')).toBe(
      Date.parse('2026-08-22T10:00:00.000Z'),
    );
    // Naive local wall-clock (no zone suffix) is also left alone — only the
    // bare-date form gets the end-of-day treatment.
    expect(dueDateInstant('2026-08-22T10:00:00', 'America/Argentina/Buenos_Aires')).toBe(
      Date.parse('2026-08-22T10:00:00'),
    );
  });

  it('demonstrates the bug: plain Date.parse reads a date-only due value hours early for UTC-3', () => {
    const tz = 'America/Argentina/Buenos_Aires';
    const naive = Date.parse('2026-08-22'); // UTC midnight == 2026-08-21T21:00:00 local
    const fixed = dueDateInstant('2026-08-22', tz); // 2026-08-22T23:59:59 local
    expect(fixed).toBeGreaterThan(naive);
    expect(fixed - naive).toBe(26 * 3_600_000 + 59 * 60_000 + 59_000); // ~27h later
  });

  it('defaults to the process time zone when none is given', () => {
    expect(dueDateInstant('2026-08-22')).toBe(dueDateInstant('2026-08-22', defaultTimeZone()));
  });
});
