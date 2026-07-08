# Data model — SQLite schema

DB at `${BOTTY_DATA_DIR:-~/.botty}/data/botty.db`. `better-sqlite3`, `journal_mode=WAL`,
`foreign_keys=ON`. IDs are nanoid strings unless noted. Timestamps are ISO-8601 UTC strings.

## Migrations

`packages/shared/migrations/NNN_name.sql`, applied in order, tracked in `schema_migrations
(version INTEGER PRIMARY KEY, applied_at TEXT)`. The Db class in `@botty/agent` runs pending
migrations on open. Migration files are plain SQL, one statement set per file. Current set:
001 (tables below), 002 (FTS5 index), 003 (FTS rebuild with `kind`/`ref_id` UNINDEXED).

## Tables (migration 001)

```sql
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL UNIQUE,
  slack_handle TEXT, email TEXT,
  weight TEXT NOT NULL DEFAULT 'NORMAL',          -- CRITICAL | HIGH | NORMAL
  tier INTEGER NOT NULL DEFAULT 2,                -- 1 | 2, derived from weight
  cadence TEXT,                                   -- e.g. 'daily', 'weekly', free text
  notes TEXT,
  muted_until TEXT,
  last_interaction_at TEXT,
  source TEXT NOT NULL DEFAULT 'team_md',         -- team_md | discovered | departed
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',          -- active | paused | done
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  raw_text TEXT,                                  -- the originating message text
  source TEXT NOT NULL,                           -- slack|gmail|gcal|jira|github|chat|manual
  source_ref TEXT,                                -- stable upstream id (thread ts, msg id, issue key)
  status TEXT NOT NULL DEFAULT 'open',            -- open|snoozed|done|cancelled|merged|archived
  priority INTEGER NOT NULL DEFAULT 2,            -- 1 HIGH, 2 NORMAL, 3 LOW
  requested_by TEXT REFERENCES people(id),
  project_id TEXT REFERENCES projects(id),
  due_date TEXT,
  snooze_until TEXT,
  done_at TEXT,
  surface_count INTEGER NOT NULL DEFAULT 0,
  last_surfaced_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(source, source_ref)
);
CREATE INDEX idx_tasks_status ON tasks(status);

CREATE TABLE decisions (                           -- product/work decisions extracted from messages
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  rationale TEXT,
  source TEXT NOT NULL, source_ref TEXT,
  project_id TEXT REFERENCES projects(id),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source, source_ref)
);

CREATE TABLE interactions (                        -- Tier-2 (and Tier-1) contact log
  id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(id),
  source TEXT NOT NULL,
  kind TEXT NOT NULL,                              -- dm|mention|channel|email|event|comment
  direction TEXT NOT NULL DEFAULT 'inbound',       -- inbound|outbound
  snippet TEXT,
  thread_ref TEXT,
  raw_log_id TEXT REFERENCES raw_log(id),
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_interactions_person ON interactions(person_id, occurred_at);

CREATE TABLE raw_log (                             -- append-only ground truth, replayable
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,                       -- upstream event id (dedup key)
  kind TEXT NOT NULL,
  actor TEXT,                                      -- upstream actor handle/email
  body TEXT NOT NULL,                              -- full JSON of the normalized event
  occurred_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE(source, external_id)
);

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL, end_at TEXT,
  location TEXT,
  attendees TEXT,                                  -- JSON array of {name,email}
  description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE chat_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,                              -- user|assistant
  content TEXT NOT NULL,
  meta TEXT,                                       -- JSON: tool calls, model, tokens
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_turns_session ON chat_turns(session_id, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'chat',               -- chat
  provider_session_id TEXT,                        -- Agent SDK session id for resume
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',           -- active|sealed
  created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
);

CREATE TABLE task_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  field TEXT NOT NULL, old_value TEXT, new_value TEXT,
  changed_by TEXT NOT NULL,                        -- user|agent|loop|funnel|sweep
  changed_at TEXT NOT NULL
);

CREATE TABLE proactive_log (                       -- every surface (nudge/notification)
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  surface_kind TEXT NOT NULL,                      -- nudge|morning_brief|evening_brief|meeting_prep|auto_resolve
  message TEXT NOT NULL,
  score REAL,
  trigger TEXT,                                    -- scheduled|manual|event
  surfaced_at TEXT NOT NULL,
  response_type TEXT,                              -- completed|acknowledged|dismissed|snoozed|expired|unrelated
  response_reason TEXT,
  response_at TEXT
);

CREATE TABLE tick_log (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT,
  candidates_in INTEGER, candidates_after_rules INTEGER,
  actions_json TEXT,                               -- JSON of executed actions
  skipped_json TEXT,                               -- JSON of skip reasons (incl. rules-filter log)
  judgment_decision_id TEXT,                       -- FK-ish to ai_decisions.id (nullable)
  error TEXT
);

CREATE TABLE ai_decisions (                        -- THE inspectability backbone
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                              -- classification|extraction|judgment|briefing|chat_turn
  input_json TEXT NOT NULL,                        -- full prompt inputs incl. system+context
  output_json TEXT,                                -- raw structured output
  model TEXT NOT NULL,
  latency_ms INTEGER,
  input_tokens INTEGER, output_tokens INTEGER,
  related_ref TEXT,                                -- raw_log id / tick id / session id
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ai_decisions_kind ON ai_decisions(kind, created_at);

CREATE TABLE source_check_log (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  events_fetched INTEGER NOT NULL DEFAULT 0,
  events_new INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                              -- JSON
);
```

## FTS5 (migrations 002 + 003)

One unified recall index. Content rows are inserted/updated by the owning writer code (no
triggers on v1 — keep it explicit):

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  kind UNINDEXED,  -- task|decision|interaction|chat
  ref_id UNINDEXED,-- id in the source table
  content,         -- searchable text (the only column MATCH sees)
  tokenize = 'porter unicode61'
);
```

Migration 003 rebuilds the 002 table with `kind`/`ref_id` UNINDEXED: indexed, they made an
unqualified MATCH over-match — porter stems "tasks" → "task", so any query containing
task/decision/chat/interaction hit every row of that kind, and nanoid fragments matched via
`ref_id`. Only `content` is searchable now; both columns stay stored and filterable/selectable.

`Memory.search(query, {limit})` (`packages/agent/src/memory/index.ts`) runs `memory_fts MATCH`
with bm25 ranking, joins back to source tables, and applies a recency tiebreak.

## Conventions

- All DB access through the `Db` class (`packages/agent/src/db/`) — prepared statements, camelCase
  mapping done once at that layer, typed row interfaces from `@botty/shared`.
- Writers that change `tasks` also append `task_history` and emit a `tasks.updated` WS event.
- People removed (or renamed away) in team.md are demoted, not deleted: `demoteTeamPeopleNotIn`
  sets tier 2, weight NORMAL, `source='departed'` on every `team_md` row not in the new roster.
- `raw_log.body` stores the normalized `SourceEvent` JSON (see `specs/ingestion.md`).
