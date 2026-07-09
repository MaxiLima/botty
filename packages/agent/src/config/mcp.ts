import { z } from 'zod';

/**
 * mcp.json — user-declared external MCP servers (stdio only in v1) whose
 * allowlisted tools become available to the chat model. `read` tools execute
 * mid-turn; `action` tools are always queued as pending_actions rows for the
 * user's approval (see mcp/tools.ts, mcp/pending.ts). Parsed with the same
 * last-known-good discipline as heartbeat.md (config/index.ts): a revision
 * that fails to parse never replaces a previously-good config, and boot with
 * a broken file serves an empty config ({ servers: {} }) with warnings.
 */

/** Server keys and tool names are restricted so they compose safely into chat-tool names (`<server>_<tool>`). */
const NAME_RE = /^[a-zA-Z0-9_-]+$/;
const NAME_SCHEMA = z.string().regex(NAME_RE, 'must match [a-zA-Z0-9_-]+');

export const McpToolModeSchema = z.enum(['read', 'action']);
export type McpToolMode = z.infer<typeof McpToolModeSchema>;

export const McpServerConfigSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  // Never logged — env values are secrets (bot tokens, API keys). See
  // ConnectionManager / config/index.ts warnings, which surface only zod
  // issue paths + messages, never field values.
  env: z.record(z.string(), z.string()).default({}),
  // Explicit allowlist, default deny: a server with no `tools` entry (or an
  // empty one) exposes nothing to the chat model.
  tools: z.record(NAME_SCHEMA, McpToolModeSchema).default({}),
});
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const McpConfigSchema = z.object({
  servers: z.record(NAME_SCHEMA, McpServerConfigSchema).default({}),
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

export const EMPTY_MCP_CONFIG: McpConfig = { servers: {} };

export interface McpParseResult {
  config: McpConfig;
  warnings: string[];
}

/** Parse mcp.json content. Never throws — invalid JSON/shape comes back as warnings + the empty config. */
export function parseMcpConfig(raw: string): McpParseResult {
  const trimmed = raw.trim();
  if (!trimmed) return { config: EMPTY_MCP_CONFIG, warnings: [] };

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    return { config: EMPTY_MCP_CONFIG, warnings: [`invalid JSON: ${(err as Error).message}`] };
  }

  const parsed = McpConfigSchema.safeParse(json);
  if (!parsed.success) {
    const warnings = parsed.error.issues.map(
      (i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`,
    );
    return { config: EMPTY_MCP_CONFIG, warnings };
  }
  return { config: parsed.data, warnings: [] };
}
