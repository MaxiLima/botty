import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { WsEvent } from '@botty/shared';
import type { AgentContext } from '../context.js';
import { isLocalHostHeader, isLocalOrigin, type OriginPolicy } from './guards.js';

export interface WsHub {
  stop(): Promise<void>;
}

export interface WsHubOptions {
  /** Ping cadence; a client that hasn't ponged since the previous ping is
   * presumed dead and terminated. Default 30s — tests pass a short value to
   * exercise reaping without a real wait. */
  heartbeatIntervalMs?: number;
  /** A client whose `bufferedAmount` (bytes queued by the OS, unsent) exceeds
   * this on a broadcast is a stalled reader — dropped rather than left to
   * grow Node's internal send queue without bound. Default 4MB. */
  maxBufferedBytes?: number;
  /** Test hook: called with each server-side socket as it connects, so tests
   * can force a `bufferedAmount` without needing to actually congest a real
   * TCP loopback connection. Never set in production. */
  onConnection?: (ws: WebSocket) => void;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

type HubSocket = WebSocket & { isAlive?: boolean };

/**
 * WS hub at /ws: fans bus broadcast events out to every connected client as
 * JSON WsEvent envelopes, and pushes a tasks.updated snapshot on connect.
 * Client→server messages are ignored (all client actions go over REST).
 *
 * Two failure modes this guards against, neither previously handled: a client
 * that goes away without a clean close (laptop sleep, network drop — TCP
 * alone can leave that socket looking open for a long time) stays in
 * `wss.clients` forever, and a client that's open but not reading fast enough
 * (slow consumer) has every broadcast queued for it, unbounded, by Node's own
 * socket buffering. The heartbeat interval reaps the former; the buffered-
 * bytes check on send drops the latter.
 */
export function attachWsHub(
  server: HttpServer,
  ctx: AgentContext,
  getOriginPolicy: () => OriginPolicy,
  opts: WsHubOptions = {},
): WsHub {
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxBufferedBytes = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // Same two guards as the REST middleware (server/index.ts), applied to
    // the upgrade handshake: a DNS-rebinding Host check, then an Origin
    // check. Browsers allow cross-origin WS from any webpage (CORS does not
    // apply), so both matter here — absent Origin = non-browser client (TUI).
    verifyClient: ({ origin, req }: { origin?: string; req: { headers: { host?: string } } }) =>
      isLocalHostHeader(req.headers.host) && isLocalOrigin(origin, getOriginPolicy()),
  });
  wss.on('error', (err) => console.error('[ws] server error:', err.message));

  const send = (client: WebSocket, event: WsEvent): void => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > maxBufferedBytes) {
      // Stalled reader: it's not keeping up with what's already queued, so
      // piling on more would only grow memory further. Drop it — the client
      // reconnects and gets a fresh tasks.updated snapshot on the way back in.
      console.error(
        `[ws] client bufferedAmount ${client.bufferedAmount} exceeds ${maxBufferedBytes}, disconnecting stalled client`,
      );
      client.terminate();
      return;
    }
    client.send(JSON.stringify(event));
  };

  wss.on('connection', (ws: HubSocket) => {
    // A malformed frame (invalid UTF-8, bad RSV bits, oversized payload) emits
    // 'error' on the socket; without a listener that kills the whole process.
    ws.on('error', (err) => {
      console.error('[ws] client error:', err.message);
      ws.terminate();
    });
    // Heartbeat liveness: standard `ws` pattern (see the library's own
    // heartbeat example). A client that misses a pong by the next tick is
    // presumed dead and terminated — see the interval below.
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    send(ws, { type: 'tasks.updated', payload: { tasks: ctx.db.listTasks('open') } });
    opts.onConnection?.(ws);
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const hc = client as HubSocket;
      if (hc.isAlive === false) {
        hc.terminate();
        continue;
      }
      hc.isAlive = false;
      hc.ping();
    }
  }, heartbeatIntervalMs);
  // Never keep the process alive for this alone (relevant to any embedder that
  // doesn't call stop() on shutdown, e.g. a crash path).
  heartbeat.unref();

  const unsubscribe = ctx.bus.onBroadcast((event) => {
    for (const client of wss.clients) send(client, event);
  });

  return {
    async stop() {
      clearInterval(heartbeat);
      unsubscribe();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
