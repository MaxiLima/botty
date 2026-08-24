import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { HEARTBEAT_DEFAULTS } from '@botty/shared';
import { createBus } from '../../src/bus/index.js';
import { createConfig } from '../../src/config/index.js';
import { Db } from '../../src/db/index.js';
import { loadEnv } from '../../src/env.js';

/**
 * Config fail-fast + last-known-good: a heartbeat.md revision that parses with
 * warnings never replaces a previously clean config — the last-known-good keeps
 * being served, and the rejected revision's warnings surface via
 * heartbeatIssues() and the config.changed broadcast payload.
 */

const GOOD_33 = '## Schedule\ntick_interval_min: 33\n';
const GOOD_44 = '## Schedule\ntick_interval_min: 44\n';
const BROKEN = '## Schedule\ntick_interval_min: soon\nquiet_hours: night\n';

function makeFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-test-'));
  const env = loadEnv({ dataDir, dbPath: path.join(dataDir, 'data', 'botty.db') });
  const db = new Db(':memory:');
  const bus = createBus();
  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));
  return { env, db, bus, events, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

describe('ConfigManager — heartbeat last-known-good', () => {
  it('a warning-producing reload keeps serving the last-known-good config', () => {
    const f = makeFixture();
    try {
      const config = createConfig(f.env, f.db, f.bus);
      config.save('heartbeat', GOOD_33);
      expect(config.heartbeat().tickIntervalMin).toBe(33);
      expect(config.heartbeatIssues()).toBeNull();

      const { warnings } = config.save('heartbeat', BROKEN);
      expect(warnings.length).toBeGreaterThan(0);
      // Served config is still the good one (a broken parse would fall back to
      // the default 20, not 33), and the issues are exposed.
      expect(config.heartbeat().tickIntervalMin).toBe(33);
      const issues = config.heartbeatIssues();
      expect(issues).not.toBeNull();
      expect(issues!.warnings.length).toBe(2);
      expect(Date.parse(issues!.since)).not.toBeNaN();
      // The raw content is what's on disk — the user still sees their edit.
      expect(config.raw('heartbeat')).toBe(BROKEN);
    } finally {
      f.cleanup();
    }
  });

  it('config.changed broadcasts carry the pending warnings; a clean save recovers', () => {
    const f = makeFixture();
    try {
      const config = createConfig(f.env, f.db, f.bus);
      config.save('heartbeat', GOOD_33);
      config.save('heartbeat', BROKEN);

      const changed = f.events.filter(
        (e): e is Extract<WsEvent, { type: 'config.changed' }> => e.type === 'config.changed',
      );
      const last = changed[changed.length - 1]!;
      expect(last.payload.name).toBe('heartbeat');
      expect(last.payload.warnings?.length).toBe(2);
      // The clean save before it had no warnings in the payload.
      const first = changed[0]!;
      expect(first.payload.warnings).toBeUndefined();

      // Recovery: a clean revision is adopted and clears the issues.
      config.save('heartbeat', GOOD_44);
      expect(config.heartbeat().tickIntervalMin).toBe(44);
      expect(config.heartbeatIssues()).toBeNull();
      const afterFix = f.events.filter(
        (e): e is Extract<WsEvent, { type: 'config.changed' }> => e.type === 'config.changed',
      );
      expect(afterFix[afterFix.length - 1]!.payload.warnings).toBeUndefined();
    } finally {
      f.cleanup();
    }
  });

  it('an out-of-range HH:MM (e.g. working_hours: 08:00-25:00) is rejected, not silently accepted', () => {
    // Regression: parseHeartbeat used to validate working_hours with a
    // format-only regex, so "25:00" and "09:75" produced zero warnings and
    // were adopted as last-known-good — which then disabled the hard
    // working-hours gate at runtime (loop/time.ts parseHHMM returns null for
    // them, and isWithinWorkingHours treats a null bound as "always within").
    const f = makeFixture();
    try {
      const config = createConfig(f.env, f.db, f.bus);
      config.save('heartbeat', GOOD_33);
      expect(config.heartbeat().workingHours).toEqual(HEARTBEAT_DEFAULTS.workingHours);

      const { warnings } = config.save('heartbeat', '## Schedule\ntick_interval_min: 33\nworking_hours: 08:00-25:00\n');
      expect(warnings.some((w) => w.includes('working_hours'))).toBe(true);
      // Last-known-good (the default working_hours from GOOD_33) keeps being served.
      expect(config.heartbeat().workingHours).toEqual(HEARTBEAT_DEFAULTS.workingHours);
      expect(config.heartbeatIssues()).not.toBeNull();
    } finally {
      f.cleanup();
    }
  });

  it('boot with a broken file: serves per-field defaults and exposes the warnings', () => {
    const f = makeFixture();
    try {
      // Overwrite the seeded template BEFORE the manager reads it.
      fs.writeFileSync(path.join(f.env.configDir, 'heartbeat.md'), BROKEN, 'utf8');
      const config = createConfig(f.env, f.db, f.bus);
      expect(config.heartbeat().tickIntervalMin).toBe(HEARTBEAT_DEFAULTS.tickIntervalMin);
      const issues = config.heartbeatIssues();
      expect(issues).not.toBeNull();
      expect(issues!.warnings.length).toBe(2);
    } finally {
      f.cleanup();
    }
  });
});

/**
 * Finding 7: "team.md has no last-known-good — a truncated write demotes
 * everyone to departed." team() now gets the same treatment as heartbeat()/
 * mcp() above, EXCEPT the single "TEAM.md defines no people" warning, which
 * is expected on a legitimately empty/fresh-install file (render.ts already
 * filters that same warning out of the combined config-issues banner) and
 * must not block adoption.
 */
describe('ConfigManager — team.md last-known-good', () => {
  const TEAM_DIEGO = '## People\n- **Diego** — weight: CRITICAL | slack: @diego\n';
  const TEAM_DIEGO_AND_SOFI =
    '## People\n- **Diego** — weight: CRITICAL | slack: @diego\n- **Sofi** — weight: HIGH | slack: @sofi\n';
  // Simulates a write truncated mid-entry: Diego's line survives intact, but
  // Sofi's is cut before it becomes parseable (no closing "**", no separator) —
  // parseTeam skips it with a warning instead of silently keeping partial junk.
  const TEAM_TRUNCATED_MID_WRITE = '## People\n- **Diego** — weight: CRITICAL | slack: @diego\n- **Sofi\n';

  it('a truncated write does not demote a previously tier-1 person to departed', () => {
    const f = makeFixture();
    try {
      const config = createConfig(f.env, f.db, f.bus);
      config.save('team', TEAM_DIEGO_AND_SOFI);
      config.materializePeople();
      const sofiBefore = f.db.getPersonByName('Sofi');
      expect(sofiBefore?.tier).toBe(1);
      expect(config.teamIssues()).toBeNull();

      const { warnings } = config.save('team', TEAM_TRUNCATED_MID_WRITE);
      expect(warnings.length).toBeGreaterThan(0);
      config.materializePeople();

      // Last-known-good (both Diego AND Sofi) keeps being served/materialized —
      // Sofi must NOT have been silently demoted to tier-2/'departed'.
      const sofiAfter = f.db.getPersonByName('Sofi');
      expect(sofiAfter?.tier).toBe(1);
      expect(sofiAfter?.source).not.toBe('departed');
      expect(config.team().people.map((p) => p.name).sort()).toEqual(['Diego', 'Sofi']);
      const issues = config.teamIssues();
      expect(issues).not.toBeNull();
      expect(issues!.warnings.some((w) => w.includes('Sofi'))).toBe(true);

      // The raw content on disk is still the user's (truncated) edit.
      expect(config.raw('team')).toBe(TEAM_TRUNCATED_MID_WRITE);
    } finally {
      f.cleanup();
    }
  });

  it('a genuinely empty team.md ("defines no people") is NOT treated as blocking', () => {
    const f = makeFixture();
    try {
      const config = createConfig(f.env, f.db, f.bus);
      config.save('team', TEAM_DIEGO);
      expect(config.teamIssues()).toBeNull();

      // Deliberately clearing the roster back to empty must take effect (this
      // is a real edit, not a truncation) — the single "no people" warning is
      // exempt from blocking, same as render.ts's combined-issues filter.
      const { warnings } = config.save('team', '## People\n');
      expect(warnings).toEqual(['TEAM.md defines no people']);
      expect(config.team().people).toEqual([]);
      expect(config.teamIssues()).toBeNull();
    } finally {
      f.cleanup();
    }
  });

  it('a clean recovery save is adopted and clears the issues', () => {
    const f = makeFixture();
    try {
      const config = createConfig(f.env, f.db, f.bus);
      config.save('team', TEAM_DIEGO_AND_SOFI);
      config.save('team', TEAM_TRUNCATED_MID_WRITE);
      expect(config.teamIssues()).not.toBeNull();

      config.save('team', TEAM_DIEGO_AND_SOFI);
      expect(config.teamIssues()).toBeNull();
      expect(config.team().people.map((p) => p.name).sort()).toEqual(['Diego', 'Sofi']);
    } finally {
      f.cleanup();
    }
  });

  it('config.changed broadcasts carry the pending team warnings', () => {
    const f = makeFixture();
    try {
      const config = createConfig(f.env, f.db, f.bus);
      config.save('team', TEAM_DIEGO_AND_SOFI);
      config.save('team', TEAM_TRUNCATED_MID_WRITE);

      const changed = f.events.filter(
        (e): e is Extract<WsEvent, { type: 'config.changed' }> => e.type === 'config.changed',
      );
      const last = changed[changed.length - 1]!;
      expect(last.payload.name).toBe('team');
      expect(last.payload.warnings?.length).toBeGreaterThan(0);
    } finally {
      f.cleanup();
    }
  });
});
