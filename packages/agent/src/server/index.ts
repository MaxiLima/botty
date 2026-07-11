import fs from 'node:fs';
import path from 'node:path';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { AgentContext } from '../context.js';
import type { Ingest } from '../ingest/index.js';
import type { Loop } from '../loop/index.js';
import { HttpError, zodDetail } from './errors.js';
import { isLocalHostHeader, isLocalOrigin } from './guards.js';
import { buildApiRouter, AGENT_VERSION } from './routes.js';
import { attachWsHub, type WsHub } from './ws.js';

export { AGENT_VERSION };

export interface AgentServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Bound TCP port (useful when env.port is 0 = ephemeral). Valid after start(). */
  port(): number;
}

export interface ServerDeps {
  ingest: Ingest;
  loop: Loop;
}

/** packages/web/dist resolved relative to this module (→ repo root/packages/web/dist). */
const webDistDir = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

/**
 * HTTP/WS server per docs/specs/api.md: REST surface under /api, WS hub at /ws,
 * static SPA (packages/web/dist) at / with index.html fallback for non-API GETs.
 */
export function createServer(ctx: AgentContext, deps: ServerDeps): AgentServer {
  const app = express();
  app.disable('x-powered-by');
  // DNS-rebinding guard: the API is unauthenticated, so reject requests whose
  // Host header does not point at loopback (an attacker-controlled DNS name
  // rebound to 127.0.0.1 would otherwise let a webpage read the whole API).
  app.use((req, res, next) => {
    if (!isLocalHostHeader(req.headers.host)) {
      res.status(403).json({ error: 'forbidden', detail: 'non-local Host header' });
      return;
    }
    next();
  });
  // Cross-origin-fetch guard: like the WS handshake (ws.ts), reject requests
  // whose Origin header is present but not local — a malicious webpage's
  // fetch() would otherwise hit this loopback-bound, unauthenticated API with
  // the browser's ambient credentials. Non-browser clients (TUI, curl) send
  // no Origin at all and are unaffected; isLocalOrigin() treats that as local.
  app.use((req, res, next) => {
    if (!isLocalOrigin(req.headers.origin)) {
      res.status(403).json({ error: 'forbidden', detail: 'non-local Origin header' });
      return;
    }
    next();
  });
  // Chat messages may carry up to 4 base64 image attachments (~7MB of base64 each).
  app.use(express.json({ limit: '32mb' }));

  app.use('/api', buildApiRouter(ctx, deps));

  const indexHtml = path.join(webDistDir, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    console.warn(`[botty] web UI not built — run \`npm run build -w @botty/web\` to serve it at /`);
  }
  app.use(express.static(webDistDir));
  // SPA fallback: any GET that isn't /api or /ws gets index.html. Existence is
  // checked per-request so building the web app after startup needs no restart.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/ws')) {
      return next();
    }
    if (fs.existsSync(indexHtml)) {
      res.sendFile(indexHtml);
      return;
    }
    res
      .status(503)
      .type('html')
      .send(
        '<h1>botty agent is running, but the web UI is not built</h1>' +
          '<p>Run <code>npm run build -w @botty/web</code>, then reload this page.</p>',
      );
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', detail: `${req.method} ${req.path}` });
  });

  // Async-error middleware: every thrown/rejected handler error lands here as {error, detail}.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, ...(err.detail ? { detail: err.detail } : {}) });
      return;
    }
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'validation_error', detail: zodDetail(err) });
      return;
    }
    if (err instanceof SyntaxError && 'status' in err && (err as { status: number }).status === 400) {
      res.status(400).json({ error: 'validation_error', detail: 'invalid JSON body' });
      return;
    }
    // body-parser's entity.too.large (attachment payload over the JSON limit).
    if (err instanceof Error && 'status' in err && (err as { status: number }).status === 413) {
      res.status(413).json({ error: 'payload_too_large', detail: 'request body too large' });
      return;
    }
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[server] unhandled error:', err);
    res.status(500).json({ error: 'internal_error', detail });
  });

  let server: HttpServer | null = null;
  let wsHub: WsHub | null = null;
  let boundPort = ctx.env.port;

  return {
    start() {
      return new Promise<void>((resolve, reject) => {
        const srv = createHttpServer(app);
        wsHub = attachWsHub(srv, ctx);
        srv.once('error', reject);
        // Loopback only: the API is unauthenticated (single local user by design);
        // never expose it to the LAN.
        srv.listen(ctx.env.port, '127.0.0.1', () => {
          const addr = srv.address();
          if (addr && typeof addr === 'object') boundPort = addr.port;
          server = srv;
          resolve();
        });
      });
    },

    async stop() {
      if (wsHub) {
        await wsHub.stop();
        wsHub = null;
      }
      if (!server) return;
      const srv = server;
      server = null;
      srv.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        srv.close((err) => (err ? reject(err) : resolve()));
      });
    },

    port() {
      return boundPort;
    },
  };
}
