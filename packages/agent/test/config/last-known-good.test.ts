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
