import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpConfig, McpServerConfig } from '../config/mcp.js';

/**
 * MCP connection manager: lazy-connects a client per configured server on
 * first use, caches it, and re-derives a fresh connection whenever that
 * server's config (command/args/env keys) changes on hot reload. Connection,
 * spawn, and call failures are always caught and surfaced as `{ error }` —
 * never thrown past this module — so a misbehaving external server can never
 * take the agent process down.
 */

export interface McpToolInfo {
  name: string;
  description?: string;
  /** Raw JSON Schema from tools/list, as reported by the server. */
  inputSchema?: unknown;
}

export type McpCallResult =
  | { content: string; structured?: unknown }
  | { error: string };

/** Builds the client-side Transport for one server config. Injectable for tests (InMemoryTransport). */
export type McpTransportFactory = (server: string, cfg: McpServerConfig) => Transport;

export interface McpConnections {
  /**
   * tools/list for one server. Lazy-connects if needed. Throws a readable
   * Error on failure. `timeoutMs` bounds the tools/list request itself
   * (default LIST_TOOLS_TIMEOUT_MS) — short by design: this runs on every
   * chat turn (mcp/tools.ts) and an unreachable server must not stall the
   * turn for anywhere near the MCP SDK's 60s default request timeout.
   */
  listTools(server: string, opts?: { timeoutMs?: number }): Promise<McpToolInfo[]>;
  /** tools/call for one server/tool. Lazy-connects if needed. Never throws — failures come back as `{ error }`. */
  callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<McpCallResult>;
  /** Close connections for servers removed or whose config changed, so the next call reconnects fresh. */
  onConfigChanged(next: McpConfig): void;
  /** Close every open connection (agent shutdown). */
  closeAll(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Bounds client.connect() itself (spawn + handshake) — a hung/unreachable server
 * must fail fast, not stall the caller for however long the subprocess never comes up. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Bounds tools/list — short because this runs on every chat turn (mcp/tools.ts)
 * to pick up hot mcp.json reloads; a slow/dead server shouldn't eat the MCP SDK's
 * full 60s default request timeout on every single turn. */
const LIST_TOOLS_TIMEOUT_MS = 10_000;
const CLIENT_INFO = { name: 'botty', version: '0.1.0' };

/** Race `p` against a timeout; rejects with a readable Error, never leaves a dangling timer. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function defaultTransportFactory(_server: string, cfg: McpServerConfig): Transport {
  return new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    // Explicit env only — the subprocess never inherits the agent's full
    // environment, so unrelated secrets stay out of a third-party tool's reach.
    env: cfg.env,
  });
}

interface ConnectionEntry {
  client: Client;
  /** Fingerprint of the config that produced this client — never includes env VALUES (secrets). */
  configKey: string;
}

/** Fingerprint used to detect "this server's config changed" — env var names only, never values. */
function configKeyFor(cfg: McpServerConfig): string {
  return JSON.stringify({
    command: cfg.command,
    args: cfg.args,
    envKeys: Object.keys(cfg.env).sort(),
  });
}

export function createMcpConnections(deps: {
  getConfig: () => McpConfig;
  transportFactory?: McpTransportFactory;
  /** Override the connect() timeout — for tests; production uses CONNECT_TIMEOUT_MS. */
  connectTimeoutMs?: number;
}): McpConnections {
  const transportFactory = deps.transportFactory ?? defaultTransportFactory;
  const connectTimeoutMs = deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const connections = new Map<string, ConnectionEntry>();
  const connecting = new Map<string, Promise<Client>>();

  async function closeEntry(server: string): Promise<void> {
    const entry = connections.get(server);
    if (!entry) return;
    connections.delete(server);
    try {
      await entry.client.close();
    } catch {
      /* best effort — the subprocess/transport may already be gone */
    }
  }

  async function connect(server: string): Promise<Client> {
    const cfg = deps.getConfig().servers[server];
    if (!cfg) throw new Error(`mcp server not configured: ${server}`);
    const key = configKeyFor(cfg);
    const existing = connections.get(server);
    if (existing && existing.configKey === key) return existing.client;
    if (existing) await closeEntry(server);

    const inFlight = connecting.get(server);
    if (inFlight) return inFlight;

    const attempt = (async (): Promise<Client> => {
      const client = new Client(CLIENT_INFO);
      // A crashed/exited external server must not stay cached as a dead client
      // until the agent restarts — evict it here so the NEXT call reconnects
      // fresh. Guarded against a STALE close event: if this client was already
      // replaced by a newer reconnect by the time its close fires, the map no
      // longer points at it and eviction is a no-op (closeEntry is itself
      // idempotent for the same reason).
      const evictIfCurrent = () => {
        if (connections.get(server)?.client === client) void closeEntry(server);
      };
      client.onclose = evictIfCurrent;
      client.onerror = evictIfCurrent;
      try {
        const transport = transportFactory(server, cfg);
        await withTimeout(client.connect(transport), connectTimeoutMs, `mcp server "${server}" connect`);
      } catch (err) {
        // Best-effort: don't leave a half-connected subprocess/transport behind
        // just because we gave up waiting on it.
        void client.close().catch(() => {});
        throw new Error(`mcp server "${server}" failed to connect: ${(err as Error).message}`);
      }
      connections.set(server, { client, configKey: key });
      return client;
    })();
    connecting.set(server, attempt);
    try {
      return await attempt;
    } finally {
      connecting.delete(server);
    }
  }

  return {
    async listTools(server, opts) {
      const client = await connect(server);
      const res = await client.listTools(undefined, { timeout: opts?.timeoutMs ?? LIST_TOOLS_TIMEOUT_MS });
      return res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    },

    async callTool(server, tool, args, opts) {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      try {
        const client = await connect(server);
        const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutMs });
        if ('toolResult' in result) {
          // Legacy/compat result shape (no `content` array) — stringify as-is.
          return { content: JSON.stringify(result.toolResult) };
        }
        const text = (result.content ?? [])
          .map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)))
          .join('\n');
        if (result.isError) return { error: text || `tool ${server}.${tool} returned an error` };
        return {
          content: text,
          ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
        };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    onConfigChanged(next) {
      for (const [server, entry] of connections.entries()) {
        const cfg = next.servers[server];
        if (!cfg || configKeyFor(cfg) !== entry.configKey) void closeEntry(server);
      }
    },

    async closeAll() {
      await Promise.all([...connections.keys()].map((s) => closeEntry(s)));
    },
  };
}
