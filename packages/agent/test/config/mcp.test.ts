import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { createBus } from '../../src/bus/index.js';
import { createConfig } from '../../src/config/index.js';
import { parseMcpConfig } from '../../src/config/mcp.js';
import { Db } from '../../src/db/index.js';
import { loadEnv } from '../../src/env.js';

/**
 * mcp.json: unit tests for the parser (valid / invalid JSON / bad shape / bad
 * mode value) plus the ConfigManager's last-known-good + hot-reload wiring —
 * same discipline as heartbeat.md (test/config/last-known-good.test.ts).
 */

const GOOD = JSON.stringify({
  servers: { slack: { type: 'stdio', command: 'npx', args: ['-y', 'x'], tools: { search: 'read' } } },
});
const GOOD_OTHER = JSON.stringify({
  servers: { jira: { type: 'stdio', command: 'npx', tools: { create_issue: 'action' } } },
});

function makeFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-mcp-test-'));
  const env = loadEnv({ dataDir, dbPath: path.join(dataDir, 'data', 'botty.db') });
  const db = new Db(':memory:');
  const bus = createBus();
  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));
  return { env, db, bus, events, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

describe('parseMcpConfig', () => {
  it('parses a valid config', () => {
    const { config, warnings } = parseMcpConfig(GOOD);
    expect(warnings).toEqual([]);
    expect(config.servers.slack).toBeDefined();
    expect(config.servers.slack!.tools).toEqual({ search: 'read' });
  });

  it('empty/missing content parses as the empty config with no warnings', () => {
    expect(parseMcpConfig('')).toEqual({ config: { servers: {} }, warnings: [] });
    expect(parseMcpConfig('   \n  ')).toEqual({ config: { servers: {} }, warnings: [] });
  });

  it('invalid JSON → warning + empty config', () => {
    const { config, warnings } = parseMcpConfig('{ not json');
    expect(config).toEqual({ servers: {} });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/invalid JSON/);
  });

  it('bad shape (missing command) → warning + empty config', () => {
    const { config, warnings } = parseMcpConfig(JSON.stringify({ servers: { slack: { type: 'stdio' } } }));
    expect(config).toEqual({ servers: {} });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('bad server/tool name (fails [a-zA-Z0-9_-]+) → warning + empty config', () => {
    const { warnings } = parseMcpConfig(
      JSON.stringify({ servers: { 'bad name!': { type: 'stdio', command: 'x', tools: {} } } }),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('bad tool mode value → warning + empty config', () => {
    const { warnings } = parseMcpConfig(
      JSON.stringify({ servers: { s: { type: 'stdio', command: 'x', tools: { t: 'delete' } } } }),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('rejects a non-stdio type', () => {
    const { warnings } = parseMcpConfig(
      JSON.stringify({ servers: { s: { type: 'http', command: 'x', tools: {} } } }),
    );
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('ConfigManager — mcp.json last-known-good + hot reload', () => {
  it('boot with no mcp.json serves the empty config with no issues', () => {
    const f = makeFixture();
    try {
      const config = createConfig(f.env, f.db, f.bus);
      expect(config.mcp()).toEqual({ servers: {} });
      expect(config.mcpIssues()).toBeNull();
    } finally {
      f.cleanup();
    }
  });

  it('boot with a broken mcp.json serves the empty config and exposes warnings', () => {
    const f = makeFixture();
    try {
      fs.writeFileSync(path.join(f.env.configDir, 'mcp.json'), '{ broken', 'utf8');
      const config = createConfig(f.env, f.db, f.bus);
      expect(config.mcp()).toEqual({ servers: {} });
      const issues = config.mcpIssues();
      expect(issues).not.toBeNull();
      expect(issues!.warnings.length).toBeGreaterThan(0);
    } finally {
      f.cleanup();
    }
  });

  it('hot reload: a valid edit is adopted and broadcasts config.changed(name: mcp)', async () => {
    const f = makeFixture();
    const config = createConfig(f.env, f.db, f.bus);
    try {
      config.startWatching();
      // chokidar's native watcher attaches asynchronously — give it a moment
      // before the first write, or the write can race ahead of 'ready'.
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(path.join(f.env.configDir, 'mcp.json'), GOOD, 'utf8');

      await waitFor(() => config.mcp().servers.slack !== undefined);
      expect(config.mcp().servers.slack!.command).toBe('npx');
      expect(
        f.events.some((e) => e.type === 'config.changed' && e.payload.name === 'mcp' && !e.payload.warnings),
      ).toBe(true);
    } finally {
      await config.stop();
      f.cleanup();
    }
  });

  it('a warning-producing hot reload keeps serving the last-known-good config and surfaces warnings', async () => {
    const f = makeFixture();
    const config = createConfig(f.env, f.db, f.bus);
    try {
      config.startWatching();
      // chokidar's native watcher attaches asynchronously — give it a moment
      // before the first write, or the write can race ahead of 'ready'.
      await new Promise((r) => setTimeout(r, 300));
      fs.writeFileSync(path.join(f.env.configDir, 'mcp.json'), GOOD, 'utf8');
      await waitFor(() => config.mcp().servers.slack !== undefined);

      fs.writeFileSync(path.join(f.env.configDir, 'mcp.json'), '{ broken', 'utf8');
      await waitFor(() => (config.mcpIssues()?.warnings.length ?? 0) > 0);

      // still serving the last-good (slack) config, not the empty fallback
      expect(config.mcp().servers.slack).toBeDefined();
      const changed = f.events.filter((e) => e.type === 'config.changed' && e.payload.name === 'mcp');
      expect(changed.at(-1)!.payload.warnings?.length).toBeGreaterThan(0);

      // recovery: a clean revision is adopted and clears the issues
      fs.writeFileSync(path.join(f.env.configDir, 'mcp.json'), GOOD_OTHER, 'utf8');
      await waitFor(() => config.mcp().servers.jira !== undefined);
      expect(config.mcpIssues()).toBeNull();
    } finally {
      await config.stop();
      f.cleanup();
    }
  });
});

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
