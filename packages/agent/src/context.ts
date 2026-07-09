import type { AgentEnv } from './env.js';
import type { Bus } from './bus/index.js';
import type { Db } from './db/index.js';
import type { ConfigManager } from './config/index.js';
import type { LlmClient } from './llm/types.js';
import type { Memory } from './memory/index.js';
import type { Chat } from './chat/index.js';
import type { McpConnections } from './mcp/connections.js';
import type { PendingActionQueue } from './mcp/pending.js';

/** Everything a subsystem (ingest, loop, server) needs from the core. */
export interface AgentContext {
  env: AgentEnv;
  db: Db;
  bus: Bus;
  config: ConfigManager;
  llm: LlmClient;
  memory: Memory;
  chat: Chat;
  /** External MCP server connections (mcp.json) — lazy-connected, closed/reconnected on hot reload. */
  mcpConnections: McpConnections;
  /** Approval queue for consent-gated external MCP `action` tool calls. */
  pendingActions: PendingActionQueue;
}
