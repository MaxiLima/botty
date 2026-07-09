-- Consent-gated external MCP tool calls (mcp.json `mode: action`). The chat
-- model can queue a call but never send it; the user approves or dismisses
-- (packages/agent/src/mcp/pending.ts). Pending rows older than 24h are lazily
-- flipped to 'expired' whenever the queue is read.
CREATE TABLE pending_actions (
  id TEXT PRIMARY KEY,
  server TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  result_json TEXT,
  source_turn_id TEXT
);

CREATE INDEX idx_pending_actions_status_created ON pending_actions(status, created_at);
