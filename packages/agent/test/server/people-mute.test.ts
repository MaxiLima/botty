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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-people-mute-test-'));
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

  const server = createServer(ctx, { ingest, loop });
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

function mute(base: string, id: string, until: string | null): Promise<Response> {
  return fetch(`${base}/api/people/${id}/mute`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ until }),
  });
}

describe('POST /api/people/:id/mute', () => {
  it('mutes a person until a valid ISO instant', async () => {
    const h = await setup();
    try {
      const person = h.ctx.db.upsertDiscoveredPerson({ name: 'Diego', slackHandle: '@diego' });
      const until = new Date(Date.now() + 3_600_000).toISOString();
      const res = await mute(h.base, person.id, until);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { person: { mutedUntil: string | null } };
      expect(body.person.mutedUntil).toBe(until);
    } finally {
      await h.teardown();
    }
  });

  it('unmutes with until: null', async () => {
    const h = await setup();
    try {
      const person = h.ctx.db.upsertDiscoveredPerson({ name: 'Diego', slackHandle: '@diego' });
      await mute(h.base, person.id, new Date(Date.now() + 3_600_000).toISOString());
      const res = await mute(h.base, person.id, null);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { person: { mutedUntil: string | null } };
      expect(body.person.mutedUntil).toBeNull();
    } finally {
      await h.teardown();
    }
  });

  it('rejects an unparseable until with 400 and does not store it', async () => {
    const h = await setup();
    try {
      const person = h.ctx.db.upsertDiscoveredPerson({ name: 'Diego', slackHandle: '@diego' });
      const res = await mute(h.base, person.id, 'banana');
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; detail?: string };
      expect(body.error).toBe('validation_error');
      expect(body.detail).toContain('banana');

      const stillFresh = h.ctx.db.getPerson(person.id);
      expect(stillFresh?.mutedUntil ?? null).toBeNull();
    } finally {
      await h.teardown();
    }
  });

  it('404s for an unknown person id', async () => {
    const h = await setup();
    try {
      const res = await mute(h.base, 'no-such-person', new Date().toISOString());
      expect(res.status).toBe(404);
    } finally {
      await h.teardown();
    }
  });
});
