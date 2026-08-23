import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AgentContext } from '../../src/context.js';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { attachWsHub, type WsHub } from '../../src/server/ws.js';

// attachWsHub() only touches ctx.db and ctx.bus; everything else on
// AgentContext is irrelevant to the hub itself, so a minimal stand-in avoids
// standing up config/llm/chat just to exercise heartbeat/backpressure wiring.
function minimalCtx(): { ctx: AgentContext; db: Db; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-ws-hub-test-'));
  const db = new Db(':memory:');
  const bus = createBus();
  const ctx = { db, bus } as unknown as AgentContext;
  return { ctx, db, dataDir };
}

async function startRaw(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe('ws hub: heartbeat / dead-socket reaping', () => {
  it('terminates a client that stops responding to pings', async () => {
    const { ctx, db, dataDir } = minimalCtx();
    const { server, port } = await startRaw();
    // 50ms cadence: two missed pings reaps well within the test timeout, with
    // enough margin over loopback pong latency to not flake under CI load.
    const hub: WsHub = attachWsHub(server, ctx, () => ({ ownPort: port, devPorts: [] }), {
      heartbeatIntervalMs: 50,
    });
    cleanups.push(async () => {
      await hub.stop();
      server.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    // Disable the client's automatic pong response (ws.js autoresponds to
    // ping by calling `websocket.pong(...)` — overriding the instance method
    // simulates a frozen/stalled peer without needing real network games).
    (client as unknown as { pong: () => void }).pong = () => {};

    const closed = new Promise<void>((resolve) => client.once('close', resolve));
    await closed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
  });

  it('a live, responsive client is not disconnected by the heartbeat', async () => {
    const { ctx, db, dataDir } = minimalCtx();
    const { server, port } = await startRaw();
    // Generous interval + wait: this test only needs to prove the heartbeat
    // never *false-positively* reaps a healthy client, so there's no reason
    // to race a tight cadence — a cold first ping/pong round-trip in a fresh
    // process can occasionally take longer than a tiny interval would allow.
    const hub: WsHub = attachWsHub(server, ctx, () => ({ ownPort: port, devPorts: [] }), {
      heartbeatIntervalMs: 150,
    });
    cleanups.push(async () => {
      await hub.stop();
      server.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });

    // ws auto-responds to pings by default; give it several heartbeat cycles.
    await new Promise((r) => setTimeout(r, 900));
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });
});

describe('ws hub: backpressure', () => {
  it('disconnects a client whose bufferedAmount exceeds the configured cap on broadcast', async () => {
    const { ctx, db, dataDir } = minimalCtx();
    const { server, port } = await startRaw();
    let serverSocket: WebSocket | undefined;
    // Long heartbeat interval so it can't be the one that closes the socket —
    // isolates the assertion to the backpressure path in `send()`.
    const hub: WsHub = attachWsHub(server, ctx, () => ({ ownPort: port, devPorts: [] }), {
      heartbeatIntervalMs: 60_000,
      maxBufferedBytes: 1_000,
      onConnection: (ws) => {
        serverSocket = ws;
      },
    });
    cleanups.push(async () => {
      await hub.stop();
      server.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
    await waitFor(() => serverSocket !== undefined);

    // Force the server-side socket to look congested without actually
    // congesting a real loopback connection (real TCP-buffer sizes vary by
    // OS/CI and would make this test flaky). bufferedAmount has no setter on
    // the `ws` prototype, so shadow it with an own property.
    Object.defineProperty(serverSocket, 'bufferedAmount', { value: 999_999, configurable: true });

    ctx.bus.broadcast({
      type: 'notification',
      payload: { id: 'n1', taskId: null, kind: 'nudge', message: 'poke', score: 1 },
    });

    await waitFor(() => serverSocket!.readyState === WebSocket.CLOSED);
  });

  it('sends normally to a client under the cap', async () => {
    const { ctx, db, dataDir } = minimalCtx();
    const { server, port } = await startRaw();
    const hub: WsHub = attachWsHub(server, ctx, () => ({ ownPort: port, devPorts: [] }), {
      heartbeatIntervalMs: 60_000,
      maxBufferedBytes: 4 * 1024 * 1024,
    });
    cleanups.push(async () => {
      await hub.stop();
      server.close();
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: unknown[] = [];
    client.on('message', (data) => received.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve());
      client.once('error', reject);
    });
    await waitFor(() => received.length >= 1); // initial tasks.updated snapshot

    ctx.bus.broadcast({
      type: 'notification',
      payload: { id: 'n2', taskId: null, kind: 'nudge', message: 'poke', score: 1 },
    });
    await waitFor(() => received.length >= 2);
    expect(client.readyState).toBe(WebSocket.OPEN);
    client.close();
  });
});
