import fs from 'node:fs';
import path from 'node:path';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import type { AgentContext } from '../context.js';
import type { Backfill } from '../backfill/index.js';
import type { Ingest } from '../ingest/index.js';
import type { Loop } from '../loop/index.js';
import { HttpError, zodDetail } from './errors.js';
import { isLocalHostHeader, isLocalOrigin, type OriginPolicy } from './guards.js';
import { buildApiRouter, AGENT_VERSION } from './routes.js';
import { attachWsHub, type WsHub } from './ws.js';

export { AGENT_VERSION };

// A plain module-level flag isn't enough of a guard here: vitest resets the
// module registry per test file (isolate: true) while running many files in
// the same worker thread/process, so a module-level `let` would re-arm and
// double-install on every file even though `process` itself — and its
// listeners — persists across that reset. Symbol.for uses Node's global
// symbol registry, which is keyed by string and shared process-wide
// regardless of which module instance asks for it, so it survives that reset.
const PROCESS_HANDLERS_INSTALLED = Symbol.for('botty.server.processErrorHandlersInstalled');

/**
 * Process-level safety net. Without these, an unhandled promise rejection
 * (Node's default since v15 is to crash the process, and does so with no
 * botty-specific context) or a synchronous throw that escapes every try/catch
 * takes the whole agent down silently — no log line naming what happened,
 * just the process exiting. Idempotent so repeated createServer() calls, as
 * tests make many of, don't pile up listeners and trip Node's
 * MaxListenersExceededWarning.
 *
 * unhandledRejection logs and keeps running: most rejections here are one
 * stray promise (e.g. a fire-and-forget in a route handler), not corrupted
 * process state, and the whole point of this finding is that one of those
 * shouldn't take the agent down.
 *
 * uncaughtException logs and then exits (non-zero): per Node's own guidance,
 * the process is in an undefined state after a truly uncaught synchronous
 * exception, so continuing to serve requests as if nothing happened risks
 * worse (silent corruption) than a clean restart under the process
 * supervisor (`tsx watch` in dev, launchd/systemd in prod).
 */
function installProcessErrorHandlers(): void {
  const proc = process as unknown as Record<symbol, boolean>;
  if (proc[PROCESS_HANDLERS_INSTALLED]) return;
  proc[PROCESS_HANDLERS_INSTALLED] = true;
  process.on('unhandledRejection', (reason, promise) => {
    console.error('[process] unhandledRejection:', reason, '— promise:', promise);
  });
  process.on('uncaughtException', (err, origin) => {
    console.error('[process] uncaughtException, exiting:', err, '— origin:', origin);
    // Vitest sets VITEST=true in every worker; exiting there would kill the
    // whole test run over one incidental uncaught error instead of just
    // failing the test that caused it. Production (no VITEST env) still exits.
    if (!process.env.VITEST) process.exit(1);
  });
}

export interface AgentServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Bound TCP port (useful when env.port is 0 = ephemeral). Valid after start(). */
  port(): number;
}

export interface ServerDeps {
  ingest: Ingest;
  loop: Loop;
  /** Optional so lightweight test servers can omit it; main.ts always wires it. */
  backfill?: Backfill;
}

/** packages/web/dist resolved relative to this module (→ repo root/packages/web/dist). */
const webDistDir = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

/**
 * HTTP/WS server per docs/specs/api.md: REST surface under /api, WS hub at /ws,
 * static SPA (packages/web/dist) at / with index.html fallback for non-API GETs.
 */
export function createServer(ctx: AgentContext, deps: ServerDeps): AgentServer {
  installProcessErrorHandlers();
  const app = express();
  app.disable('x-powered-by');

  // env.port can be 0 (ephemeral, tests); this is corrected to the real
  // listen port in start() below, before any request/upgrade can arrive.
  // Read via originPolicy() (not captured by value) so every guard always
  // sees the resolved port.
  let boundPort = ctx.env.port;
  const originPolicy = (): OriginPolicy => ({ ownPort: boundPort, devPorts: ctx.env.devOriginPorts });

  // Security headers: this API/UI is unauthenticated by design (single local
  // user), so a page that framed it could ride the user's clicks into
  // approving a pending MCP action (clickjacking). Both headers block
  // framing; CSP's frame-ancestors is the modern/standards form and X-Frame-
  // Options covers older embedders that don't honor it. We deliberately stop
  // at frame-ancestors here rather than a full CSP (script-src etc.) — the
  // web bundle hasn't been audited for inline scripts/eval that a stricter
  // policy could break.
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    next();
  });
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
  // whose Origin header is present but not trusted — a malicious webpage's
  // fetch() would otherwise hit this loopback-bound, unauthenticated API with
  // the browser's ambient credentials. Loopback-bound does not mean
  // this-app-only: any other localhost:<port> page is rejected too, only the
  // agent's own port and configured dev ports are trusted (H6). Non-browser
  // clients (TUI, curl) send no Origin at all and are unaffected;
  // isLocalOrigin() treats that as local.
  app.use((req, res, next) => {
    if (!isLocalOrigin(req.headers.origin, originPolicy())) {
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

  return {
    start() {
      return new Promise<void>((resolve, reject) => {
        const srv = createHttpServer(app);
        wsHub = attachWsHub(srv, ctx, originPolicy);
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
