import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceId, Task, WsEvent } from '@botty/shared';
import type { AgentEnv } from '../../src/env.js';
import type { AgentContext } from '../../src/context.js';
import type { Ingest } from '../../src/ingest/index.js';
import type { Loop } from '../../src/loop/index.js';
import type { LlmClient } from '../../src/llm/types.js';
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

/**
 * Regression tests for two LOW-severity bugs, both localized to
 * packages/agent/src/server/routes.ts:
 *
 *  A) POST /api/tasks/:id/action didn't bound `priority`/`snoozeDays` — a
 *     non-integer or out-of-range priority violated the app-wide 1=HIGH..3=LOW
 *     invariant, and an absurd snoozeDays could bury a task for centuries.
 *     Fixed by tightening TaskActionRequestSchema in packages/shared/src/api.ts.
 *
 *  B) POST /api/chat/seal awaited the LLM summarization call inline, so the
 *     web "fresh context" button could hang up to the stream-inactivity
 *     timeout on a slow/failing LLM. Fixed by deferring the summary through
 *     the turn queue, the same mechanism the idle-seal path already used.
 */

interface Harness {
  ctx: AgentContext;
  base: string;
  events: WsEvent[];
  teardown(): Promise<void>;
}

async function setup(llmOverride?: (base: LlmClient) => LlmClient): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-server-regressions-'));
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
  fs.writeFileSync(
    path.join(env.configDir, 'team.md'),
    '## People\n- **Ana** — weight: HIGH | slack: @ana\n',
    'utf8',
  );
  fs.writeFileSync(path.join(env.configDir, 'heartbeat.md'), '# HEARTBEAT\n', 'utf8');

  const db = new Db(':memory:');
  const bus = createBus();
  const config = createConfig(env, db, bus);
  config.materializePeople();
  const baseLlm = await createLlm({ env, db, bus });
  const llm = llmOverride ? llmOverride(baseLlm) : baseLlm;
  const mcpConnections = createMcpConnections({ getConfig: () => config.mcp() });
  const pendingActions = createPendingActionQueue({ db, bus, connections: mcpConnections });
  const mcpTools = createMcpToolsFactory({ config, connections: mcpConnections, pending: pendingActions });
  const memory = createMemory({ db, config });
  const chat = createChat({
    db,
    bus,
    llm,
    memory,
    attachmentsDir: path.join(dataDir, 'attachments'),
    mcpTools,
  });
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
    async teardown() {
      await server.stop();
      await config.stop();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function seedTask(h: Harness, description = 'ship the report'): Task {
  const task = h.ctx.db.insertTask(
    { description, source: 'slack', sourceRef: `msg-${Math.random()}` },
    'test',
  );
  if (!task) throw new Error('seed insert deduped');
  return task;
}

async function postAction(h: Harness, id: string, body: unknown): Promise<Response> {
  return fetch(`${h.base}/api/tasks/${id}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('bug A: POST /api/tasks/:id/action bounds priority + snoozeDays', () => {
  it.each([0, 42, 2.7, -1])('rejects priority=%s with 400 validation_error', async (priority) => {
    const h = await setup();
    try {
      const t = seedTask(h);
      const res = await postAction(h, t.id, { action: 'priority', priority });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('validation_error');

      // task untouched
      const after = h.ctx.db.getTask(t.id)!;
      expect(after.priority).toBe(t.priority);
    } finally {
      await h.teardown();
    }
  });

  it('accepts valid integer priorities 1, 2, 3', async () => {
    const h = await setup();
    try {
      const t = seedTask(h);
      for (const priority of [1, 2, 3]) {
        const res = await postAction(h, t.id, { action: 'priority', priority });
        expect(res.status).toBe(200);
        const { task } = (await res.json()) as { task: Task };
        expect(task.priority).toBe(priority);
      }
    } finally {
      await h.teardown();
    }
  });

  it.each([100_000, 366, -3, 2.5])(
    'rejects snoozeDays=%s with 400 validation_error',
    async (snoozeDays) => {
      const h = await setup();
      try {
        const t = seedTask(h);
        const res = await postAction(h, t.id, { action: 'snooze', snoozeDays });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('validation_error');

        // task never snoozed
        const after = h.ctx.db.getTask(t.id)!;
        expect(after.status).toBe('open');
      } finally {
        await h.teardown();
      }
    },
  );

  it('accepts a sane snoozeDays (within the 1-365 bound)', async () => {
    const h = await setup();
    try {
      const t = seedTask(h);
      const res = await postAction(h, t.id, { action: 'snooze', snoozeDays: 30 });
      expect(res.status).toBe(200);
      const { task } = (await res.json()) as { task: Task };
      expect(task.status).toBe('snoozed');
    } finally {
      await h.teardown();
    }
  });
});

describe('bug B: POST /api/chat/seal responds without waiting on the LLM summary', () => {
  it('returns promptly even when the summarizer LLM call hangs', async () => {
    // Structured calls never resolve — if the route awaited the summary inline,
    // this request would hang until the test times out.
    const llmOverride = (base: LlmClient): LlmClient => ({
      chatTurn: (req) => base.chatTurn(req),
      structured: () => new Promise(() => {}),
      interrupt: (key) => base.interrupt(key),
    });
    const h = await setup(llmOverride);
    try {
      const msg = await fetch(`${h.base}/api/chat/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello botty' }),
      });
      expect(msg.status).toBe(200);
      // Wait for the assistant turn to land so there's an active session to seal.
      const deadline = Date.now() + 2_000;
      while (!h.events.some((e) => e.type === 'chat.done')) {
        if (Date.now() > deadline) throw new Error('waitFor chat.done timed out');
        await new Promise((r) => setTimeout(r, 10));
      }

      const before = Date.now();
      const res = await fetch(`${h.base}/api/chat/seal`, { method: 'POST' });
      const elapsed = Date.now() - before;
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      // Generous ceiling — well under the never-resolving structured() promise,
      // proves the route isn't blocked on it.
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      await h.teardown();
    }
  });
});
