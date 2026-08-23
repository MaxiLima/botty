import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceEvent, WsEvent } from '@botty/shared';
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

/**
 * §6 "Test gaps worth closing next" (docs/reports/2026-08-21-full-test-run.md)
 * asks for "API contract test (routes vs docs/specs/api.md)". Most of the
 * shapes it names (check-now's {started,source} vs the doc's stale
 * {checkId}, snoozeUntil on task actions) already have dedicated pins
 * elsewhere (server.test.ts "control & inspector plumbing", regressions.test.ts
 * "snoozeUntil: exact wall-clock snooze") — this file covers what wasn't: the
 * `beforeId` cursor param actually threading through at the route layer (only
 * the DB layer had coverage), and the `backfill.progress` WS event, which
 * doesn't appear in api.md's WS table at all. See this pass's report for the
 * full drift list against docs/specs/api.md (docs are out of scope to edit).
 */

interface Harness {
  ctx: AgentContext;
  base: string;
  events: WsEvent[];
  teardown(): Promise<void>;
}

function historyAdapter(source: SourceAdapter['source'], events: SourceEvent[]): SourceAdapter {
  return { source, fetch: async () => [], fetchHistory: async () => ({ events, nextCursor: null }) };
}

async function setup(): Promise<Harness> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-api-contract-test-'));
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
    devOriginPorts: [5173],
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

  const ingest: Ingest = { start() {}, stop() {}, async checkNow() { return db.insertSourceCheck({ source: 'slack' }).id; } };
  const loop: Loop = {
    start() {},
    stop() {},
    async runNow() { return db.insertTickLog('manual').id; },
    async sweepNow() { return { resolved: 0, checked: 0 }; },
  };
  const adapters: AdapterMap = {
    slack: historyAdapter('slack', [
      makeEvent({
        externalId: 'contract-h1',
        text: 'we decided to use the new queue',
        threadRef: 'H-q',
        occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    ]),
    gmail: historyAdapter('gmail', []),
    gcal: historyAdapter('gcal', []),
    jira: historyAdapter('jira', []),
    github: historyAdapter('github', []),
  };
  const backfill = createBackfill({ db, llm, bus, config }, adapters);

  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));

  const server = createServer(ctx, { ingest, loop, backfill });
  await server.start();

  return {
    ctx,
    base: `http://127.0.0.1:${server.port()}`,
    events,
    async teardown() {
      await server.stop();
      await config.stop();
      await mcpConnections.closeAll();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('API contract: beforeId cursor threads through at the route layer', () => {
  it('GET /api/chat/history?before=&beforeId= forwards both params to the composite cursor', async () => {
    const h = await setup();
    try {
      const session = h.ctx.db.createSession();
      // Three turns tied on the same created_at millisecond, ids chosen so
      // DESC (created_at, id) order is deterministic — same technique as
      // db.test.ts's "does not skip rows tied on created_at" (DB-layer
      // correctness is already covered there per Appendix D "keyset cursors
      // correct"; what's new here is confirming the *route* forwards both
      // `before` and `beforeId` query params instead of dropping one).
      const sameCreatedAt = '2026-07-10T10:00:00.000Z';
      for (const id of ['c', 'b', 'a']) {
        h.ctx.db.raw
          .prepare(
            'INSERT INTO chat_turns (id, session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
          )
          .run(id, session.id, 'user', `turn-${id}`, sameCreatedAt);
      }

      const page1 = (await (
        await fetch(`${h.base}/api/chat/history?limit=2`)
      ).json()) as { turns: { id: string; createdAt: string }[] };
      expect(page1.turns.map((t) => t.id)).toEqual(['b', 'c']); // oldest-first

      const boundary = page1.turns[0]!; // 'b' — oldest on this page, i.e. the next cursor

      // `before` alone re-derives the pre-H-fix bug (ties permanently skipped)
      // — proves the two params aren't redundant, so dropping beforeId from
      // the route (or the docs) would be a real behavior difference, not
      // just a documentation nit.
      const beforeOnly = (await (
        await fetch(`${h.base}/api/chat/history?limit=2&before=${encodeURIComponent(boundary.createdAt)}`)
      ).json()) as { turns: { id: string }[] };
      expect(beforeOnly.turns.map((t) => t.id)).toEqual([]);

      const page2 = (await (
        await fetch(
          `${h.base}/api/chat/history?limit=2&before=${encodeURIComponent(boundary.createdAt)}&beforeId=${boundary.id}`,
        )
      ).json()) as { turns: { id: string }[] };
      expect(page2.turns.map((t) => t.id)).toEqual(['a']);
    } finally {
      await h.teardown();
    }
  });

  it('GET /api/decisions?beforeId= is accepted (passthrough to db.listAiDecisions)', async () => {
    const h = await setup();
    try {
      h.ctx.db.insertAiDecision({ kind: 'judgment', input: {}, model: 'mock' });
      const res = await fetch(`${h.base}/api/decisions?beforeId=some-id&before=2026-01-01T00:00:00.000Z`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { decisions: unknown[] };
      expect(Array.isArray(body.decisions)).toBe(true);
    } finally {
      await h.teardown();
    }
  });
});

describe('API contract: backfill.progress WS event (missing from api.md WS table)', () => {
  it('broadcasts backfill.progress at least once during a run, not just pollable via GET', async () => {
    const h = await setup();
    try {
      const res = await fetch(`${h.base}/api/backfill/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sources: ['slack'], days: 30 }),
      });
      expect(res.status).toBe(200);

      await waitFor(() => h.events.some((e) => e.type === 'backfill.progress'));
      const progress = h.events.find((e) => e.type === 'backfill.progress')!;
      if (progress.type === 'backfill.progress') {
        expect(progress.payload.state).toBeTruthy();
      }
    } finally {
      await h.teardown();
    }
  });
});

describe('API contract: GET /api/chat/history degrades instead of 500ing on corrupt turn.meta', () => {
  it('a turn with malformed meta JSON no longer takes the whole page down', async () => {
    const h = await setup();
    try {
      const session = h.ctx.db.createSession();
      // db.getChatTurn() JSON.parses `meta` unguarded (db/index.ts, out of
      // scope for this pass) — a corrupted row used to throw and 500 the
      // whole /api/chat/history response. Write one directly (insertChatTurn
      // always serializes valid JSON, so this has to go in via raw SQL).
      h.ctx.db.raw
        .prepare(
          'INSERT INTO chat_turns (id, session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('corrupt-1', session.id, 'user', 'hi', '{not valid json', new Date().toISOString());

      const res = await fetch(`${h.base}/api/chat/history`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { turns: unknown[]; sessions: unknown[] };
      expect(body.turns).toEqual([]);
      expect(Array.isArray(body.sessions)).toBe(true);
    } finally {
      await h.teardown();
    }
  });
});
