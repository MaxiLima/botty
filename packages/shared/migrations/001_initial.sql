CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL UNIQUE,
  slack_handle TEXT, email TEXT,
  weight TEXT NOT NULL DEFAULT 'NORMAL',
  tier INTEGER NOT NULL DEFAULT 2,
  cadence TEXT,
  notes TEXT,
  muted_until TEXT,
  last_interaction_at TEXT,
  source TEXT NOT NULL DEFAULT 'team_md',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE raw_log (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT,
  body TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  UNIQUE(source, external_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  raw_text TEXT,
  source TEXT NOT NULL,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 2,
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

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  rationale TEXT,
  source TEXT NOT NULL, source_ref TEXT,
  project_id TEXT REFERENCES projects(id),
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(source, source_ref)
);

CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(id),
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'inbound',
  snippet TEXT,
  thread_ref TEXT,
  raw_log_id TEXT REFERENCES raw_log(id),
  occurred_at TEXT NOT NULL
);
CREATE INDEX idx_interactions_person ON interactions(person_id, occurred_at);

CREATE TABLE calendar_events (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  start_at TEXT NOT NULL, end_at TEXT,
  location TEXT,
  attendees TEXT,
  description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE chat_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_turns_session ON chat_turns(session_id, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'chat',
  provider_session_id TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL, last_active_at TEXT NOT NULL
);

CREATE TABLE task_history (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  field TEXT NOT NULL, old_value TEXT, new_value TEXT,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL
);

CREATE TABLE proactive_log (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  surface_kind TEXT NOT NULL,
  message TEXT NOT NULL,
  score REAL,
  trigger TEXT,
  surfaced_at TEXT NOT NULL,
  response_type TEXT,
  response_reason TEXT,
  response_at TEXT
);

CREATE TABLE tick_log (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT,
  candidates_in INTEGER, candidates_after_rules INTEGER,
  actions_json TEXT,
  skipped_json TEXT,
  judgment_decision_id TEXT,
  error TEXT
);

CREATE TABLE ai_decisions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_json TEXT,
  model TEXT NOT NULL,
  latency_ms INTEGER,
  input_tokens INTEGER, output_tokens INTEGER,
  related_ref TEXT,
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
  value TEXT NOT NULL
);
