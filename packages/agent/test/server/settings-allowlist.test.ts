import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentEnv } from '../../src/env.js';
import type { AgentContext } from '../../src/context.js';
import type { Ingest } from '../../src/ingest/index.js';
import type { Loop } from '../../src/loop/index.js';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { createConfig } from '../../src/config/index.js';
import { createLlm } from '../../src/llm/index.js';
import { createMemory } from '../../src/memory/index.js';
import { createChat } from '../../src/chat/index.js';
import { createServer } from '../../src/server/index.js';
import { createMcpConnections } from '../../src/mcp/connections.js';
import { createPendingActionQueue } from '../../src/mcp/pending.js';
import { createMcpToolsFactory } from '../../src/mcp/tools.js';

interface Harness {
  ctx: AgentContext;
  base: string;
  teardown(): Promise<void>;
}

async function setup(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-settings-allowlist-test-'));
  const env: AgentEnv = {
    dataDir,
    dbPath: ':memory:',
    configDir: path.join(dataDir, 'config'),
    configArchiveDir: path.join(dataDir, 'config', 'archive'),
    logsDir: path.join(dataDir, 'logs'),
    mode: 'sim',
    simUrl: 'http://localhost:4821',
    mockLlm: true,
    port: 0,
  };
  fs.mkdirSync(env.configArchiveDir, { recursive: true });
  fs.writeFileSync(path.join(env.configDir, 'persona.md'), '# PERSONA\nYou are botty.', 'utf8');
  fs.writeFileSync(path.join(env.configDir, 'team.md'), '', 'utf8');
  fs.writeFileSync(path.join(env.configDir, 'heartbeat.md'), '# HEARTBEAT\n', 'utf8');

  const db = new Db(':memory:');
  const bus = createBus();
  const config = createConfig(env, db, bus);
  const llm = await createLlm({ env, db, bus });
  const mcpConnections = createMcpConnections({ getConfig: () => config.mcp() });
  const pendingActions = createPendingActionQueue({ db, bus, connections: mcpConnections });
  const mcpTools = createMcpToolsFactory({ config, connections: mcpConnections, pending: pendingActions });
  const memory = createMemory({ db, config });
  const chat = createChat({ db, bus, llm, memory, attachmentsDir: path.join(dataDir, 'attachments'), mcpTools });
  const ctx: AgentContext = { env, db, bus, config, llm, memory, chat, mcpConnections, pendingActions };

  const ingest: Ingest = {
    start() {},
    stop() {},
    async checkNow() {
      return db.insertSourceCheck({ source: 'slack' }).id;
    },
  };
  const loop: Loop = {
    start() {},
    stop() {},
    async runNow() {
      return db.insertTickLog('manual').id;
    },
    async sweepNow() {
      return { resolved: 0, checked: 0 };
    },
  };

  const server = createServer(ctx, { ingest, loop });
  await server.start();
  const port = server.port();

  return {
    ctx,
    base: `http://127.0.0.1:${port}`,
    async teardown() {
      await server.stop();
      await config.stop();
      await mcpConnections.closeAll();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function putSettings(base: string, patch: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch }),
  });
}

describe('server: PUT /api/settings allowlist', () => {
  it('allows known user-settable keys (llm.models, llm.pricing)', async () => {
    const h = await setup();
    try {
      const res = await putSettings(h.base, {
        'llm.models': { chat: 'claude-opus-4-8' },
        'llm.pricing': { 'claude-opus-4-8': { inputPerMTok: 1, outputPerMTok: 2 } },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { settings: Record<string, unknown> };
      expect(body.settings['llm.models']).toEqual({ chat: 'claude-opus-4-8' });
      expect(body.settings['llm.pricing']).toEqual({ 'claude-opus-4-8': { inputPerMTok: 1, outputPerMTok: 2 } });
    } finally {
      await h.teardown();
    }
  });

  it('rejects an internal ingest.lastCheck.* key with 400 naming the offending key', async () => {
    const h = await setup();
    try {
      const res = await putSettings(h.base, { 'ingest.lastCheck.slack': '2026-01-01T00:00:00.000Z' });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; detail?: string };
      expect(body.error).toBe('validation_error');
      expect(body.detail).toContain('ingest.lastCheck.slack');

      // the internal key was never written
      expect(h.ctx.db.getSetting('ingest.lastCheck.slack')).toBeUndefined();
    } finally {
      await h.teardown();
    }
  });

  it('rejects heartbeat.checklistState (internal bookkeeping) with 400', async () => {
    const h = await setup();
    try {
      const res = await putSettings(h.base, { 'heartbeat.checklistState': {} });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; detail?: string };
      expect(body.detail).toContain('heartbeat.checklistState');
    } finally {
      await h.teardown();
    }
  });

  it('rejects the whole patch (no partial writes) when one key among several is not allowlisted', async () => {
    const h = await setup();
    try {
      const res = await putSettings(h.base, {
        'llm.models': { chat: 'claude-opus-4-8' },
        'ingest.lastCheck.gmail': '2026-01-01T00:00:00.000Z',
      });
      expect(res.status).toBe(400);
      expect(h.ctx.db.getSetting('llm.models')).toBeUndefined();
    } finally {
      await h.teardown();
    }
  });
});
