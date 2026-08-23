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

/**
 * createServer() installs process-level `unhandledRejection`/
 * `uncaughtException` handlers so a stray rejection can't take the agent down
 * with no log line (finding #4, docs/reports/2026-08-21-full-test-run.md).
 * We can't safely fire a real unhandledRejection/uncaughtException in this
 * shared test process — vitest has its own rejection tracking for test
 * failures, and Node's uncaughtException handling is process-wide, so poking
 * it here risks destabilizing every other test file sharing this worker.
 * Instead this pins the property that actually matters for a long-running
 * daemon: repeated createServer() calls (every test file does many) install
 * the handlers exactly once rather than leaking a listener per call.
 */
async function bootOnce(): Promise<() => Promise<void>> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-process-handlers-test-'));
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

  return async () => {
    await server.stop();
    await config.stop();
    await mcpConnections.closeAll();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
}

describe('server: process-level error handlers', () => {
  it('installs unhandledRejection/uncaughtException handlers, and repeated createServer() calls never add more', async () => {
    // Don't assume this is the first test file in the worker to call
    // createServer() — the install guard is process-global (Symbol.for), so
    // an earlier file sharing this worker may have already installed the
    // handlers. Assert the property that actually matters: the count is
    // stable (>=1, never growing) across further createServer() calls, not
    // that it's exactly 1 in absolute terms.
    const teardownA = await bootOnce();
    const afterFirst = {
      rejection: process.listenerCount('unhandledRejection'),
      exception: process.listenerCount('uncaughtException'),
    };
    expect(afterFirst.rejection).toBeGreaterThanOrEqual(1);
    expect(afterFirst.exception).toBeGreaterThanOrEqual(1);

    const teardownB = await bootOnce();
    const teardownC = await bootOnce();

    // Two more createServer() calls (every test file does many) must not
    // leak a listener per call and eventually trip Node's
    // MaxListenersExceededWarning on a long-running process.
    expect(process.listenerCount('unhandledRejection')).toBe(afterFirst.rejection);
    expect(process.listenerCount('uncaughtException')).toBe(afterFirst.exception);

    await teardownA();
    await teardownB();
    await teardownC();

    // Handlers are process-lifetime, not tied to any one server instance —
    // stopping servers doesn't (and shouldn't) remove them.
    expect(process.listenerCount('unhandledRejection')).toBe(afterFirst.rejection);
    expect(process.listenerCount('uncaughtException')).toBe(afterFirst.exception);
  });
});
