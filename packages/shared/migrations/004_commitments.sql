-- Inferred commitments (2026-07-09 investigation feature #2): short-lived
-- follow-ups the user mentions in passing during chat ("my interview is
-- tomorrow at 3"), extracted by a hidden post-turn pass (chat/commitments.ts)
-- and delivered through the proactive tick when due (loop/commitments.ts).
-- Operational state, NOT a task and NOT durable memory.
-- source_turn_id is FK-ish (not an enforced REFERENCES): it points at the user
-- chat_turns row the commitment was inferred from, but is left un-enforced so
-- test/synthetic turn ids and any future chat_turns retention policy never
-- risk an insert failure here.
CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  due_at TEXT NOT NULL,
  source_turn_id TEXT,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  delivered_at TEXT
);

CREATE INDEX idx_commitments_status_due ON commitments(status, due_at);
