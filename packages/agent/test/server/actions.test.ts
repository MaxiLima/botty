import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PendingAction, WsEvent } from '@botty/shared';
import type { AgentEnv } from '../../src/env.js';
import type { AgentContext } from '../../src/context.js';
import type { Ingest } from '../../src/ingest/index.js';
import type { Loop } from '../../src/loop/index.js';
import type { SourceId } from '@botty/shared';
import type { McpConfig } from '../../src/config/mcp.js';
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
import { createFixtureMcpServer } from '../mcp/fixture.js';

interface Harness {
  ctx: AgentContext;
  base: string;
  events: WsEvent[];
  fixture: ReturnType<typeof createFixtureMcpServer>;
  teardown(): Promise<void>;
}

async function setup(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-actions-test-'));
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

  const fixture = createFixtureMcpServer('demo');
  const mcpConfig: McpConfig = {
    servers: {
      demo: { type: 'stdio', command: 'node', args: [], env: {}, tools: { echo: 'read', send: 'action' } },
    },
  };
  const mcpConnections = createMcpConnections({ getConfig: () => mcpConfig, transportFactory: fixture.transportFactory });
  const pendingActions = createPendingActionQueue({ db, bus, connections: mcpConnections });
  const mcpTools = createMcpToolsFactory({ config: { mcp: () => mcpConfig }, connections: mcpConnections, pending: pendingActions });

  const memory = createMemory({ db, config });
  const chat = createChat({ db, bus, llm, memory, attachmentsDir: path.join(dataDir, 'attachments'), mcpTools });
  const ctx: AgentContext = { env, db, bus, config, llm, memory, chat, mcpConnections, pendingActions };

  const ingest: Ingest = {
    start() {},
    stop() {},
    async checkNow(source: SourceId) {
      return db.insertSourceCheck({ source }).id;
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

  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));

  const server = createServer(ctx, { ingest, loop });
  await server.start();
  const port = server.port();

  return {
    ctx,
    base: `http://127.0.0.1:${port}`,
    events,
    fixture,
    async teardown() {
      await server.stop();
      await config.stop();
      await mcpConnections.closeAll();
      await fixture.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function enqueue(h: Harness, overrides: Partial<{ tool: string; args: Record<string, unknown> }> = {}): PendingAction {
  const outcome = h.ctx.pendingActions.enqueue({
    server: 'demo',
    tool: overrides.tool ?? 'send',
    args: overrides.args ?? { to: 'ana', text: 'hi' },
    summary: 'demo.send(to=ana)',
  });
  if (!('action' in outcome)) throw new Error(`enqueue failed: ${outcome.error}`);
  return outcome.action;
}

describe('server: GET /api/config exposes issues.mcp', () => {
  it('mcp issues is null when there is no mcp.json parse problem', async () => {
    const h = await setup();
    try {
      const res = await fetch(`${h.base}/api/config`);
      const body = (await res.json()) as { issues: { heartbeat: unknown; mcp: unknown } };
      expect(body.issues.mcp).toBeNull();
    } finally {
      await h.teardown();
    }
  });
});

describe('server: GET /api/actions', () => {
  it('defaults to status=pending and lists enqueued actions', async () => {
    const h = await setup();
    try {
      const action = enqueue(h);
      const res = await fetch(`${h.base}/api/actions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { actions: PendingAction[] };
      expect(body.actions.map((a) => a.id)).toEqual([action.id]);
    } finally {
      await h.teardown();
    }
  });

  it('filters by ?status= and rejects a bogus status', async () => {
    const h = await setup();
    try {
      const action = enqueue(h);
      await h.ctx.pendingActions.dismiss(action.id);

      const dismissed = await fetch(`${h.base}/api/actions?status=dismissed`);
      const dismissedBody = (await dismissed.json()) as { actions: PendingAction[] };
      expect(dismissedBody.actions.map((a) => a.id)).toEqual([action.id]);

      const pending = await fetch(`${h.base}/api/actions?status=pending`);
      const pendingBody = (await pending.json()) as { actions: PendingAction[] };
      expect(pendingBody.actions).toHaveLength(0);

      const bad = await fetch(`${h.base}/api/actions?status=bogus`);
      expect(bad.status).toBe(400);
    } finally {
      await h.teardown();
    }
  });
});

describe('server: POST /api/actions/:id/approve', () => {
  it('executes via the fixture, resolves to executed, and broadcasts action.resolved', async () => {
    const h = await setup();
    try {
      const action = enqueue(h);
      const res = await fetch(`${h.base}/api/actions/${action.id}/approve`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { action: PendingAction };
      expect(body.action.status).toBe('executed');
      expect(h.fixture.calls).toEqual([{ tool: 'send', args: { to: 'ana', text: 'hi' } }]);
      expect(
        h.events.some(
          (e) => e.type === 'action.resolved' && e.payload.action.id === action.id && e.payload.action.status === 'executed',
        ),
      ).toBe(true);
    } finally {
      await h.teardown();
    }
  });

  it('a failing tool resolves to failed (still 200, resultJson carries the error)', async () => {
    const h = await setup();
    try {
      const action = enqueue(h, { tool: 'fail', args: {} });
      const res = await fetch(`${h.base}/api/actions/${action.id}/approve`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { action: PendingAction };
      expect(body.action.status).toBe('failed');
      expect(body.action.resultJson).toContain('boom');
    } finally {
      await h.teardown();
    }
  });

  it('unknown id → 404; non-pending id → 409', async () => {
    const h = await setup();
    try {
      const missing = await fetch(`${h.base}/api/actions/nope/approve`, { method: 'POST' });
      expect(missing.status).toBe(404);

      const action = enqueue(h);
      await fetch(`${h.base}/api/actions/${action.id}/dismiss`, { method: 'POST' });
      const again = await fetch(`${h.base}/api/actions/${action.id}/approve`, { method: 'POST' });
      expect(again.status).toBe(409);
    } finally {
      await h.teardown();
    }
  });
});

describe('server: POST /api/actions/:id/dismiss', () => {
  it('flips a pending action to dismissed without calling the tool', async () => {
    const h = await setup();
    try {
      const action = enqueue(h);
      const res = await fetch(`${h.base}/api/actions/${action.id}/dismiss`, { method: 'POST' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { action: PendingAction };
      expect(body.action.status).toBe('dismissed');
      expect(h.fixture.calls).toHaveLength(0);
    } finally {
      await h.teardown();
    }
  });

  it('unknown id → 404; already-dismissed id → 409', async () => {
    const h = await setup();
    try {
      const missing = await fetch(`${h.base}/api/actions/nope/dismiss`, { method: 'POST' });
      expect(missing.status).toBe(404);

      const action = enqueue(h);
      await fetch(`${h.base}/api/actions/${action.id}/dismiss`, { method: 'POST' });
      const again = await fetch(`${h.base}/api/actions/${action.id}/dismiss`, { method: 'POST' });
      expect(again.status).toBe(409);
    } finally {
      await h.teardown();
    }
  });
});
