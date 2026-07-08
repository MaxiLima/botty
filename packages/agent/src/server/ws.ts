import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { WsEvent } from '@botty/shared';
import type { AgentContext } from '../context.js';
import { isLocalOrigin } from './guards.js';

export interface WsHub {
  stop(): Promise<void>;
}

/**
 * WS hub at /ws: fans bus broadcast events out to every connected client as
 * JSON WsEvent envelopes, and pushes a tasks.updated snapshot on connect.
 * Client→server messages are ignored (all client actions go over REST).
 */
export function attachWsHub(server: HttpServer, ctx: AgentContext): WsHub {
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    // Browsers allow cross-origin WS from any webpage (CORS does not apply),
    // so reject non-local Origins; absent Origin = non-browser client (TUI).
    verifyClient: ({ origin }: { origin?: string }) => isLocalOrigin(origin),
  });
  wss.on('error', (err) => console.error('[ws] server error:', err.message));

  const send = (client: WebSocket, event: WsEvent): void => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(event));
  };

  wss.on('connection', (ws) => {
    // A malformed frame (invalid UTF-8, bad RSV bits, oversized payload) emits
    // 'error' on the socket; without a listener that kills the whole process.
    ws.on('error', (err) => {
      console.error('[ws] client error:', err.message);
      ws.terminate();
    });
    send(ws, { type: 'tasks.updated', payload: { tasks: ctx.db.listTasks('open') } });
  });

  const unsubscribe = ctx.bus.onBroadcast((event) => {
    for (const client of wss.clients) send(client, event);
  });

  return {
    async stop() {
      unsubscribe();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
