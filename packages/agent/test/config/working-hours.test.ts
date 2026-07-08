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
});
