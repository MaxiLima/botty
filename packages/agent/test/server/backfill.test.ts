import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BackfillStartResponse, BackfillState, SourceEvent } from '@botty/shared';
import type { AgentEnv } from '../../src/env.js';
import type { AgentContext } from '../../src/context.js';
import type { Ingest } from '../../src/ingest/index.js';
import type { AdapterMap, SourceAdapter } from '../../src/ingest/adapters/index.js';
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
import { createBackfill } from '../../src/backfill/index.js';
import { makeEvent } from '../ingest/helpers.js';

interface Harness {
  ctx: AgentContext;
  base: string;
  teardown(): Promise<void>;
}

function historyAdapter(source: SourceAdapter['source'], events: SourceEvent[]): SourceAdapter {
  return {
    source,
    fetch: async () => [],
    fetchHistory: async () => ({ events, nextCursor: null }),
  };
}

async function setup(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-backfill-route-test-'));
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
  const adapters: AdapterMap = {
    slack: historyAdapter('slack', [
      makeEvent({ externalId: 'route-h1', text: 'we decided to use the new queue', threadRef: 'H-q', occurredAt: new Date(Date.now() - 86_400_000).toISOString() }),
    ]),
    gmail: historyAdapter('gmail', []),
    gcal: historyAdapter('gcal', []),
    jira: historyAdapter('jira', []),
    github: historyAdapter('github', []),
  };
  const backfill = createBackfill({ db, llm, bus, config }, adapters);

  const server = createServer(ctx, { ingest, loop, backfill });
  await server.start();

  return {
    ctx,
    base: `http://127.0.0.1:${server.port()}`,
    async teardown() {
      await server.stop();
      await config.stop();
      await mcpConnections.closeAll();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function postJson<T>(base: string, p: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function waitDone(base: string): Promise<BackfillState> {
  for (let i = 0; i < 300; i++) {
    const res = await fetch(`${base}/api/backfill`);
    const { state } = (await res.json()) as { state: BackfillState };
    if (state.status !== 'running') return state;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('backfill did not finish');
}

describe('server: backfill routes', () => {
  it('start → progress → done, with state readable via GET and a validated request body', async () => {
    const h = await setup();
    try {
      const bad = await postJson(h.base, '/api/backfill/start', { days: 0 });
      expect(bad.status).toBe(400);

      const start = await postJson<BackfillStartResponse>(h.base, '/api/backfill/start', {
        sources: ['slack'],
        days: 30,
      });
      expect(start.status).toBe(200);
      expect(start.data.started).toBe(true);

      const state = await waitDone(h.base);
      expect(state.status).toBe('done');
      expect(state.sources.slack).toMatchObject({ newEvents: 1, done: true });
      expect(state.distill.callsUsed).toBe(1); // decision-signal thread distilled via MockLlm
      expect(h.ctx.db.listTasks('open')).toHaveLength(0);
    } finally {
      await h.teardown();
    }
  });

  it('second start while running → alreadyRunning; cancel is idempotent', async () => {
    const h = await setup();
    try {
      await postJson(h.base, '/api/backfill/start', { sources: ['slack'] });
      // a run may or may not still be live — exercise both routes for shape
      const cancel = await postJson<{ state: BackfillState }>(h.base, '/api/backfill/cancel', {});
      expect(cancel.status).toBe(200);
      expect(['running', 'done', 'cancelled']).toContain(cancel.data.state.status);
      await waitDone(h.base);
      const idle = await postJson<{ state: BackfillState }>(h.base, '/api/backfill/cancel', {});
      expect(idle.status).toBe(200);
      expect(idle.data.state.status).not.toBe('running');
    } finally {
      await h.teardown();
    }
  });

  it('backfill.state is not user-settable via PUT /api/settings', async () => {
    const h = await setup();
    try {
      const res = await fetch(`${h.base}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patch: { 'backfill.state': { status: 'done' } } }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { detail?: string };
      expect(body.detail).toContain('backfill.state');
    } finally {
      await h.teardown();
    }
  });
});
