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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-origin-guard-test-'));
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

describe('server: REST Origin guard', () => {
  it('403s a request carrying a non-local Origin header', async () => {
    const h = await setup();
    try {
      const res = await fetch(`${h.base}/api/health`, { headers: { Origin: 'https://evil.example' } });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; detail?: string };
      expect(body.error).toBe('forbidden');
      expect(body.detail).toContain('Origin');
    } finally {
      await h.teardown();
    }
  });

  it('passes requests with no Origin header (TUI, curl)', async () => {
    const h = await setup();
    try {
      const res = await fetch(`${h.base}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await h.teardown();
    }
  });

  it('passes requests carrying a local Origin (web app served from the agent, vite dev on :5173)', async () => {
    const h = await setup();
    try {
      const same = await fetch(`${h.base}/api/health`, { headers: { Origin: h.base } });
      expect(same.status).toBe(200);

      const vite = await fetch(`${h.base}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
      expect(vite.status).toBe(200);
    } finally {
      await h.teardown();
    }
  });
});
