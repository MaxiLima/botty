import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { SourceId, Task, WsEvent } from '@botty/shared';
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
import { createServer, AGENT_VERSION } from '../../src/server/index.js';
import { createMcpConnections } from '../../src/mcp/connections.js';
import { createPendingActionQueue } from '../../src/mcp/pending.js';
import { createMcpToolsFactory } from '../../src/mcp/tools.js';

interface Harness {
  ctx: AgentContext;
  base: string;
  port: number;
  events: WsEvent[];
  teardown(): Promise<void>;
}

async function setup(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-server-test-'));
  const env: AgentEnv = {
    dataDir,
    dbPath: ':memory:',
    configDir: path.join(dataDir, 'config'),
    configArchiveDir: path.join(dataDir, 'config', 'archive'),
    logsDir: path.join(dataDir, 'logs'),
    mode: 'sim',
    simUrl: 'http://localhost:4821',
    mockLlm: true,
    port: 0, // ephemeral
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
  const llm = await createLlm({ env, db, bus });
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
    port,
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

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function seedTask(h: Harness, description = 'ship the report'): Task {
  const task = h.ctx.db.insertTask(
    { description, source: 'slack', sourceRef: `msg-${Math.random()}` },
    'test',
  );
  if (!task) throw new Error('seed insert deduped');
  return task;
}

describe('server: health', () => {
  it('GET /api/health returns ok, version, mode, dbPath', async () => {
    const h = await setup();
    try {
      const res = await fetch(`${h.base}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        version: AGENT_VERSION,
        mode: 'sim',
        dbPath: ':memory:',
      });
    } finally {
      await h.teardown();
    }
  });
});

describe('server: chat', () => {
  it('POST /api/chat/message returns turnId and history shows both turns', async () => {
    const h = await setup();
    try {
      const res = await fetch(`${h.base}/api/chat/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello botty' }),
      });
      expect(res.status).toBe(200);
      const { turnId } = (await res.json()) as { turnId: string };
      expect(typeof turnId).toBe('string');

      // mock llm streams then completes; wait for chat.done on the bus
      await waitFor(() => h.events.some((e) => e.type === 'chat.done'));

      const hist = await fetch(`${h.base}/api/chat/history?limit=10`);
      expect(hist.status).toBe(200);
      const body = (await hist.json()) as {
        turns: { role: string; content: string }[];
        sessions: unknown[];
      };
      expect(body.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
      expect(body.turns[1]!.content).toBe('[mock] hello botty');
      expect(body.sessions).toHaveLength(1);
    } finally {
      await h.teardown();
    }
  });

  it('accepts attachments + quoted reply, persists meta, and serves the bytes back', async () => {
    const h = await setup();
    try {
      // 1x1 transparent PNG
      const pngB64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

      // seed a turn to quote
      await fetch(`${h.base}/api/chat/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'the earlier message worth quoting' }),
      });
      await waitFor(() => h.events.some((e) => e.type === 'chat.done'));
      const first = h.ctx.db.chatHistory().find((t) => t.role === 'user')!;

      const res = await fetch(`${h.base}/api/chat/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'see attached',
          quotedTurnId: first.id,
          attachments: [{ mimeType: 'image/png', dataBase64: pngB64, name: 'pixel.png' }],
        }),
      });
      expect(res.status).toBe(200);
      await waitFor(() => h.events.filter((e) => e.type === 'chat.done').length >= 2);

      const reply = h.ctx.db
        .chatHistory()
        .filter((t) => t.role === 'user')
        .at(-1)!;
      const meta = reply.meta as {
        attachments: { id: string; mimeType: string; name?: string; ref: string }[];
        quotedTurnId: string;
        quotedPreview: string;
      };
      expect(meta.quotedTurnId).toBe(first.id);
      expect(meta.quotedPreview).toBe('the earlier message worth quoting');
      expect(meta.attachments).toHaveLength(1);
      expect(meta.attachments[0]!.ref).toBe(`/api/chat/attachments/${meta.attachments[0]!.id}`);

      // GET the binary back with the right content-type
      const got = await fetch(`${h.base}${meta.attachments[0]!.ref}`);
      expect(got.status).toBe(200);
      expect(got.headers.get('content-type')).toContain('image/png');
      const body = Buffer.from(await got.arrayBuffer());
      expect(body.equals(Buffer.from(pngB64, 'base64'))).toBe(true);

      // unknown id → 404 json
      const missing = await fetch(`${h.base}/api/chat/attachments/nope-unknown`);
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: string }).error).toBe('not_found');
    } finally {
      await h.teardown();
    }
  });

  it('rejects oversized attachments and more than 4 of them → 400', async () => {
    const h = await setup();
    try {
      const small = { mimeType: 'image/png', dataBase64: 'aGVsbG8=' };

      const tooMany = await fetch(`${h.base}/api/chat/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'x', attachments: [small, small, small, small, small] }),
      });
      expect(tooMany.status).toBe(400);
      const tooManyBody = (await tooMany.json()) as { error: string; detail?: string };
      expect(tooManyBody.error).toBe('validation_error');
      expect(tooManyBody.detail).toContain('attachments');

      const tooBig = await fetch(`${h.base}/api/chat/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: 'x',
          attachments: [{ mimeType: 'image/png', dataBase64: 'A'.repeat(7_000_001) }],
        }),
      });
      expect(tooBig.status).toBe(400);
      expect(((await tooBig.json()) as { error: string }).error).toBe('validation_error');
    } finally {
      await h.teardown();
    }
  });

  it('POST /api/chat/message with empty body → 400 {error, detail}', async () => {
    const h = await setup();
    try {
      const res = await fetch(`${h.base}/api/chat/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; detail?: string };
      expect(body.error).toBe('validation_error');
      expect(body.detail).toContain('text');
    } finally {
      await h.teardown();
    }
  });
});

describe('server: tasks', () => {
  it('GET /api/tasks lists tasks (enriched) and filters by status', async () => {
    const h = await setup();
    try {
      const ana = h.ctx.db.getPersonByName('Ana')!;
      const t = h.ctx.db.insertTask(
        { description: 'review PR', source: 'github', sourceRef: 'pr-1', requestedBy: ana.id },
        'test',
      )!;
      const res = await fetch(`${h.base}/api/tasks`);
      const body = (await res.json()) as { tasks: Task[] };
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0]!.id).toBe(t.id);
      expect(body.tasks[0]!.requesterName).toBe('Ana');

      const open = (await (await fetch(`${h.base}/api/tasks?status=open`)).json()) as {
        tasks: Task[];
      };
      expect(open.tasks).toHaveLength(1);
      const done = (await (await fetch(`${h.base}/api/tasks?status=done`)).json()) as {
        tasks: Task[];
      };
      expect(done.tasks).toHaveLength(0);

      const bad = await fetch(`${h.base}/api/tasks?status=bogus`);
      expect(bad.status).toBe(400);
    } finally {
      await h.teardown();
    }
  });

  it('POST /api/tasks/:id/action done → task flips, history recorded, tasks.updated broadcast', async () => {
    const h = await setup();
    try {
      const t = seedTask(h);
      const res = await fetch(`${h.base}/api/tasks/${t.id}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'done' }),
      });
      expect(res.status).toBe(200);
      const { task } = (await res.json()) as { task: Task };
      expect(task.status).toBe('done');
      expect(task.doneAt).not.toBeNull();

      // full open board broadcast (now empty)
      const updates = h.events.filter((e) => e.type === 'tasks.updated');
      expect(updates.length).toBeGreaterThan(0);
      expect(updates.at(-1)!.payload.tasks).toHaveLength(0);

      // detail endpoint shows the status-change history
      const detail = (await (await fetch(`${h.base}/api/tasks/${t.id}`)).json()) as {
        task: Task;
        history: { field: string; newValue: string | null }[];
        surfaces: unknown[];
      };
      expect(detail.task.status).toBe('done');
      expect(detail.history.some((row) => row.field === 'status' && row.newValue === 'done')).toBe(
        true,
      );
      expect(detail.surfaces).toEqual([]);
    } finally {
      await h.teardown();
    }
  });

  it('snooze uses snoozeDays; invalid action → 400; missing task → 404', async () => {
    const h = await setup();
    try {
      const t = seedTask(h);
      const res = await fetch(`${h.base}/api/tasks/${t.id}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'snooze', snoozeDays: 3, reason: 'busy week' }),
      });
      const { task } = (await res.json()) as { task: Task };
      expect(task.status).toBe('snoozed');
      expect(Date.parse(task.snoozeUntil!)).toBeGreaterThan(Date.now() + 2.5 * 86_400_000);

      const bad = await fetch(`${h.base}/api/tasks/${t.id}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'explode' }),
      });
      expect(bad.status).toBe(400);
      expect(((await bad.json()) as { error: string }).error).toBe('validation_error');

      const missing = await fetch(`${h.base}/api/tasks/nope/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'done' }),
      });
      expect(missing.status).toBe(404);
      expect(((await missing.json()) as { error: string }).error).toBe('not_found');
    } finally {
      await h.teardown();
    }
  });
});

describe('server: config', () => {
  it('GET /api/config returns raw markdown; PUT saves + hot-reloads + broadcasts', async () => {
    const h = await setup();
    try {
      const res = await fetch(`${h.base}/api/config`);
      const body = (await res.json()) as { files: Record<string, string> };
      expect(body.files.persona).toContain('You are botty');
      expect(Object.keys(body.files).sort()).toEqual(['heartbeat', 'persona', 'team']);

      const put = await fetch(`${h.base}/api/config/persona`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '# PERSONA\nBe terse.' }),
      });
      expect(put.status).toBe(200);
      const putBody = (await put.json()) as { ok: boolean; warnings: string[] };
      expect(putBody.ok).toBe(true);
      expect(Array.isArray(putBody.warnings)).toBe(true);

      const after = (await (await fetch(`${h.base}/api/config`)).json()) as {
        files: Record<string, string>;
      };
      expect(after.files.persona).toContain('Be terse.');
      expect(h.events.some((e) => e.type === 'config.changed' && e.payload.name === 'persona')).toBe(
        true,
      );

      const bad = await fetch(`${h.base}/api/config/bogus`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x' }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await h.teardown();
    }
  });
});

describe('server: websocket', () => {
  it('pushes a tasks.updated snapshot on connect and fans out bus broadcasts', async () => {
    const h = await setup();
    try {
      const t = seedTask(h, 'ws snapshot task');
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
      const received: WsEvent[] = [];
      ws.on('message', (data) => received.push(JSON.parse(data.toString()) as WsEvent));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      await waitFor(() => received.length >= 1);

      const snapshot = received[0]!;
      expect(snapshot.type).toBe('tasks.updated');
      if (snapshot.type === 'tasks.updated') {
        expect(snapshot.payload.tasks.map((x) => x.id)).toEqual([t.id]);
      }

      // subsequent bus broadcasts are fanned out as-is (e.g. notification)
      h.ctx.bus.broadcast({
        type: 'notification',
        payload: { id: 'n1', taskId: t.id, kind: 'nudge', message: 'poke', score: 8 },
      });
      await waitFor(() => received.some((e) => e.type === 'notification'));
      const notif = received.find((e) => e.type === 'notification')!;
      if (notif.type === 'notification') {
        expect(notif.payload).toEqual({ id: 'n1', taskId: t.id, kind: 'nudge', message: 'poke', score: 8 });
      }

      ws.close();
    } finally {
      await h.teardown();
    }
  });

  it('rejects upgrades from non-local Origins; allows local and absent ones', async () => {
    const h = await setup();
    try {
      const connect = (origin?: string) =>
        new Promise<'open' | 'rejected'>((resolve) => {
          const ws = new WebSocket(
            `ws://127.0.0.1:${h.port}/ws`,
            origin ? { headers: { origin } } : {},
          );
          ws.once('open', () => {
            ws.close();
            resolve('open');
          });
          ws.once('error', () => resolve('rejected'));
        });

      expect(await connect('http://evil.example.com')).toBe('rejected');
      expect(await connect(`http://localhost:5173`)).toBe('open'); // vite dev proxy
      expect(await connect(`http://127.0.0.1:${h.port}`)).toBe('open');
      expect(await connect()).toBe('open'); // non-browser client (TUI)
    } finally {
      await h.teardown();
    }
  });

  it('survives a malformed frame (invalid UTF-8 text) without crashing the process', async () => {
    const h = await setup();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      // Text frame carrying invalid UTF-8 → server receiver emits 'error';
      // without a per-socket listener this used to kill the whole agent.
      ws.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false });
      await new Promise<void>((resolve) => ws.once('close', () => resolve()));

      const res = await fetch(`${h.base}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await h.teardown();
    }
  });
});

describe('server: local-only guards', () => {
  it('403s requests whose Host header is not loopback (DNS rebinding)', async () => {
    const h = await setup();
    try {
      const request = (host: string) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = http.request(
            { host: '127.0.0.1', port: h.port, path: '/api/health', headers: { Host: host } },
            (res) => {
              let body = '';
              res.on('data', (c: Buffer) => (body += c.toString()));
              res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
            },
          );
          req.once('error', reject);
          req.end();
        });

      const rebound = await request('attacker.example.com');
      expect(rebound.status).toBe(403);
      expect((JSON.parse(rebound.body) as { error: string }).error).toBe('forbidden');

      expect((await request(`localhost:${h.port}`)).status).toBe(200);
      expect((await request(`127.0.0.1:${h.port}`)).status).toBe(200);
    } finally {
      await h.teardown();
    }
  });
});

describe('server: control & inspector plumbing', () => {
  it('run-now, check-now, settings round-trip, unknown api route → 404 json', async () => {
    const h = await setup();
    try {
      const tick = (await (
        await fetch(`${h.base}/api/loop/run-now`, { method: 'POST' })
      ).json()) as { tickId: string };
      expect(typeof tick.tickId).toBe('string');
      const ticks = (await (await fetch(`${h.base}/api/ticks`)).json()) as { ticks: unknown[] };
      expect(ticks.ticks).toHaveLength(1);

      const check = (await (
        await fetch(`${h.base}/api/sources/slack/check-now`, { method: 'POST' })
      ).json()) as { checkId: string };
      expect(typeof check.checkId).toBe('string');
      const badSource = await fetch(`${h.base}/api/sources/myspace/check-now`, { method: 'POST' });
      expect(badSource.status).toBe(400);

      const putSettings = await fetch(`${h.base}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patch: { 'llm.models': { chat: 'claude-opus-4-8' } } }),
      });
      const settings = (await putSettings.json()) as { settings: Record<string, unknown> };
      expect(settings.settings['llm.models']).toEqual({ chat: 'claude-opus-4-8' });

      const unknown = await fetch(`${h.base}/api/nope`);
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { error: string }).error).toBe('not_found');
    } finally {
      await h.teardown();
    }
  });
});
