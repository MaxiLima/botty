import { describe, expect, it } from 'vitest';
import { HEARTBEAT_DEFAULTS } from '@botty/shared';
import { parseHeartbeat } from '../../src/config/parse.js';

describe('parseHeartbeat working_hours', () => {
  it('defaults to HEARTBEAT_DEFAULTS.workingHours when absent', () => {
    const cfg = parseHeartbeat('', 'sim');
    expect(cfg.workingHours).toEqual(HEARTBEAT_DEFAULTS.workingHours);
    expect(cfg.workingHours).toEqual({ start: '08:00', end: '19:00' });
  });

  it("parses 'working_hours: HH:MM-HH:MM' from '## Schedule'", () => {
    const cfg = parseHeartbeat('## Schedule\nworking_hours: 09:30-17:45\n', 'sim');
    expect(cfg.workingHours).toEqual({ start: '09:30', end: '17:45' });
    expect(cfg.warnings).toEqual([]);
    // quiet_hours untouched
    expect(cfg.quietHours).toEqual(HEARTBEAT_DEFAULTS.quietHours);
  });

  it('accepts en/em dash separators', () => {
    expect(parseHeartbeat('## Schedule\nworking_hours: 08:00–19:00\n', 'sim').workingHours).toEqual(
      { start: '08:00', end: '19:00' },
    );
  });

  it('warns on malformed values and keeps the default', () => {
    const cfg = parseHeartbeat('## Schedule\nworking_hours: nine to five\n', 'sim');
    expect(cfg.workingHours).toEqual(HEARTBEAT_DEFAULTS.workingHours);
    expect(cfg.warnings.some((w) => w.includes('working_hours'))).toBe(true);
  });

  // Regression: the regex `\d{1,2}:\d{2}` matches "25:00" and "09:75" — an
  // out-of-range hour/minute must still warn and fall back to the default,
  // not silently pass through to disable the hard working-hours gate at
  // runtime (loop/time.ts parseHHMM would return null for these at tick time).
  it.each(['25:00-19:00', '08:00-24:30', '09:75-17:00', '08:00-17:99'])(
    'warns on out-of-range working_hours "%s" and keeps the default',
    (value) => {
      const cfg = parseHeartbeat(`## Schedule\nworking_hours: ${value}\n`, 'sim');
      expect(cfg.workingHours).toEqual(HEARTBEAT_DEFAULTS.workingHours);
      expect(cfg.warnings.some((w) => w.includes('working_hours'))).toBe(true);
    },
  );

  it('warns on out-of-range quiet_hours and keeps the default', () => {
    const cfg = parseHeartbeat('## Schedule\nquiet_hours: 23:00-25:15\n', 'sim');
    expect(cfg.quietHours).toEqual(HEARTBEAT_DEFAULTS.quietHours);
    expect(cfg.warnings.some((w) => w.includes('quiet_hours'))).toBe(true);
  });

  it.each(['morning_brief_at', 'evening_brief_at'])(
    'warns on out-of-range %s and keeps the default',
    (key) => {
      const cfg = parseHeartbeat(`## Schedule\n${key}: 25:00\n`, 'sim');
      const field = key === 'morning_brief_at' ? 'morningBriefAt' : 'eveningBriefAt';
      expect(cfg[field]).toBe(HEARTBEAT_DEFAULTS[field]);
      expect(cfg.warnings.some((w) => w.includes(key))).toBe(true);
    },
  );

  it('accepts boundary-valid HH:MM (23:59, 00:00)', () => {
    const cfg = parseHeartbeat('## Schedule\nworking_hours: 00:00-23:59\n', 'sim');
    expect(cfg.workingHours).toEqual({ start: '00:00', end: '23:59' });
    expect(cfg.warnings).toEqual([]);
  });
});
