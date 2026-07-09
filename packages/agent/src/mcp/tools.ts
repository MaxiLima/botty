import type { ChatToolSpec } from '../llm/types.js';
import type { McpConfig, McpServerConfig, McpToolMode } from '../config/mcp.js';
import type { McpConnections, McpToolInfo } from './connections.js';
import type { PendingActionQueue } from './pending.js';
import { jsonSchemaToZodShape } from './schema.js';

/**
 * Turns the current mcp.json allowlist into ChatToolSpecs the chat pipeline
 * can hand to the model alongside the four built-ins (chat/tools.ts). Called
 * fresh each turn (see chat/index.ts) so a hot mcp.json reload is picked up
 * without an agent restart — tools/list results are cached per server here,
 * keyed by that server's config, so a normal turn doesn't re-hit the MCP
 * server unless its config actually changed since the last successful fetch.
 *
 * `read` tools call straight through to the MCP server (connections.callTool).
 * `action` tools NEVER call the server mid-turn — they only enqueue a
 * pending_actions row; connections.callTool for an action tool happens
 * exclusively on approval (mcp/pending.ts).
 */

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const CONSENT_NOTE =
  "This tool is consent-gated: calling it queues the request for the user's approval — it does NOT " +
  'execute immediately. Tell the user it is queued.';

function buildDescription(opts: { mode: McpToolMode; remoteDescription?: string; inputSchema?: unknown }): string {
  const base = opts.remoteDescription?.trim() || 'External MCP tool (no description reported by the server).';
  const schemaText =
    opts.inputSchema !== undefined
      ? `Input schema (JSON Schema): ${JSON.stringify(opts.inputSchema)}`
      : 'No input schema is available from the server; pass arguments as a flat JSON object.';
  const parts = [base, schemaText];
  if (opts.mode === 'action') parts.push(CONSENT_NOTE);
  return parts.join('\n\n');
}

/** Short `key=value, key=value` hint from call args, clipped for display. */
function argHint(args: Record<string, unknown>): string {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return '';
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}=${clip(typeof v === 'string' ? v : JSON.stringify(v), 40)}`)
    .join(', ');
}

function buildSummary(server: string, tool: string, args: Record<string, unknown>): string {
  const hint = argHint(args);
  return clip(`${server}.${tool}${hint ? `(${hint})` : ''}`, 160);
}

function buildToolSpec(opts: {
  server: string;
  toolName: string;
  mode: McpToolMode;
  remote?: McpToolInfo;
  connections: McpConnections;
  pending: PendingActionQueue;
  sourceTurnId?: string | null;
}): ChatToolSpec {
  const { server, toolName, mode, remote, connections, pending, sourceTurnId } = opts;
  const name = `${server}_${toolName}`;
  const description = buildDescription({
    mode,
    remoteDescription: remote?.description,
    inputSchema: remote?.inputSchema,
  });
  const inputSchema = jsonSchemaToZodShape(remote?.inputSchema);

  return {
    name,
    description,
    inputSchema,
    summarize(input) {
      const base = `${server}.${toolName}${argHint(input) ? ` — ${argHint(input)}` : ''}`;
      return mode === 'action' ? `queue: ${base}` : base;
    },
    async execute(input) {
      if (mode === 'read') {
        const result = await connections.callTool(server, toolName, input, { timeoutMs: 30_000 });
        if ('error' in result) return { error: result.error };
        return {
          content: result.content,
          ...(result.structured !== undefined ? { structured: result.structured } : {}),
        };
      }
      // action mode — never executes mid-turn, only queues.
      const outcome = pending.enqueue({
        server,
        tool: toolName,
        args: input,
        summary: buildSummary(server, toolName, input),
        sourceTurnId: sourceTurnId ?? null,
      });
      if ('error' in outcome) return { error: outcome.error };
      return {
        queued: true,
        actionId: outcome.action.id,
        summary: outcome.action.summary,
        note: 'awaiting user approval — let the user know',
      };
    },
  };
}

export interface McpChatToolsDeps {
  config: { mcp(): McpConfig };
  connections: McpConnections;
  pending: PendingActionQueue;
}

/** Re-derived per turn (see chat/index.ts): what allowlisted tools exist right now. */
export type McpChatToolsProvider = (sourceTurnId?: string) => Promise<ChatToolSpec[]>;

export function createMcpToolsFactory(deps: McpChatToolsDeps): McpChatToolsProvider {
  /** tools/list cache per server, invalidated whenever that server's config changes. */
  const cache = new Map<string, { key: string; tools: McpToolInfo[] }>();

  function cacheKey(cfg: McpServerConfig): string {
    return JSON.stringify({ command: cfg.command, args: cfg.args, envKeys: Object.keys(cfg.env).sort() });
  }

  async function toolsForServer(server: string, cfg: McpServerConfig): Promise<McpToolInfo[]> {
    const key = cacheKey(cfg);
    const cached = cache.get(server);
    if (cached && cached.key === key) return cached.tools;
    try {
      const tools = await deps.connections.listTools(server);
      cache.set(server, { key, tools });
      return tools;
    } catch {
      // Unreachable server: still let the allowlisted tools be built below
      // (with a generic description) so a call can still enqueue/attempt.
      return [];
    }
  }

  return async function getMcpChatTools(sourceTurnId) {
    const cfg = deps.config.mcp();
    const specs: ChatToolSpec[] = [];
    for (const [server, serverCfg] of Object.entries(cfg.servers)) {
      const allow = Object.entries(serverCfg.tools);
      if (allow.length === 0) continue;
      const remoteTools = await toolsForServer(server, serverCfg);
      for (const [toolName, mode] of allow) {
        const remote = remoteTools.find((t) => t.name === toolName);
        specs.push(
          buildToolSpec({ server, toolName, mode, remote, connections: deps.connections, pending: deps.pending, sourceTurnId }),
        );
      }
    }
    return specs;
  };
}
