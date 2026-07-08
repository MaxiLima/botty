import { describe, expect, it } from 'vitest';
import { isWithinWorkingHours } from '../../src/loop/time.js';

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
