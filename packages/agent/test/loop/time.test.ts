import { describe, expect, it } from 'vitest';
import { isWithinWorkingHours, msUntilNextTime } from '../../src/loop/time.js';

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
    expect(isWithinWorkingHours('2026-07-01T19:00:00', std)).toBe(false); // end is exclusive
    expect(isWithinWorkingHours('2026-07-01T23:30:00', std)).toBe(false);
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
    expect(isWithinWorkingHours('2026-07-01T06:00:00', night)).toBe(false); // end exclusive
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
});
