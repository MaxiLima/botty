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
  /** tools/list for one server. Lazy-connects if needed. Throws a readable Error on failure. */
  listTools(server: string): Promise<McpToolInfo[]>;
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
const CLIENT_INFO = { name: 'botty', version: '0.1.0' };

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
}): McpConnections {
  const transportFactory = deps.transportFactory ?? defaultTransportFactory;
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
      try {
        const transport = transportFactory(server, cfg);
        await client.connect(transport);
      } catch (err) {
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
    async listTools(server) {
      const client = await connect(server);
      const res = await client.listTools();
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
