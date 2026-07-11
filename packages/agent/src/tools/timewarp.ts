/**
 * timewarp — simulate the passage of time by shifting every timestamp in the DB
 * into the past. "Advancing time by 6 hours" = subtracting 6 hours from stored
 * timestamps, so age-based gates (never-surfaced min-age, staleness, surface
 * cooldowns, snooze expiry, due-date proximity) behave as if the time had passed.
 *
 *   npm run timewarp -w @botty/agent -- --hours 6
 *   npm run timewarp -w @botty/agent -- --days 2 --db /path/to/botty.db
 *
 * Stop the agent before running this (WAL single-writer), or accept a brief lock wait.
 */
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { loadEnv } from '../env.js';

const SHIFTS: Record<string, string[]> = {
  tasks: ['created_at', 'updated_at', 'last_surfaced_at', 'done_at', 'snooze_until', 'due_date'],
  proactive_log: ['surfaced_at', 'response_at'],
  interactions: ['occurred_at'],
  raw_log: ['occurred_at', 'captured_at'],
  chat_turns: ['created_at'],
  sessions: ['created_at', 'last_active_at'],
  calendar_events: ['start_at', 'end_at', 'created_at', 'updated_at'],
  tick_log: ['started_at', 'finished_at'],
  ai_decisions: ['created_at'],
  people: ['last_interaction_at', 'muted_until'],
  source_check_log: ['checked_at'],
  // migrations 004/005 (added after this map was first written — L7): inferred
  // commitments and consent-gated pending MCP actions are both time-gated
  // (due_at delivery / 24h pending_actions expiry) and need to age with everything else.
  commitments: ['due_at', 'created_at', 'delivered_at'],
  pending_actions: ['created_at', 'resolved_at'],
};

/**
 * Settings-table keys whose JSON value embeds ISO timestamps that also need to
 * age along with everything else — these aren't plain DB columns so SHIFTS/
 * shiftColumnSql can't reach them:
 *  - heartbeat.checklistState (loop/checklist.ts): { [checklistTaskId]: lastRunAt
 *    ISO } — dueChecklistTasks gates on now - lastRunAt >= intervalMin, so a
 *    stale lastRunAt makes an item look freshly-run and silently un-due after
 *    a timewarp.
 *  - ingest.lastCheck.<source> (ingest/scheduler.ts sinceKey): a single ISO
 *    string, the watermark passed to each adapter's fetch(since).
 */
const CHECKLIST_STATE_KEY = 'heartbeat.checklistState';
const LASTCHECK_PREFIX = 'ingest.lastCheck.';

function shiftIso(iso: string, hours: number): string | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms - hours * 3_600_000).toISOString() : null;
}

/** Shift the ISO timestamps embedded in settings JSON values. Returns rows touched. */
function shiftSettingsTimestamps(db: Database.Database, hours: number): number {
  const rows = db
    .prepare('SELECT key, value FROM settings WHERE key = ? OR key LIKE ?')
    .all(CHECKLIST_STATE_KEY, `${LASTCHECK_PREFIX}%`) as { key: string; value: string }[];
  let touched = 0;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    let next: unknown;
    if (row.key === CHECKLIST_STATE_KEY) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const shifted: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
      let changed = false;
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== 'string') continue;
        const s = shiftIso(v, hours);
        if (s === null) continue;
        shifted[id] = s;
        changed = true;
      }
      if (!changed) continue;
      next = shifted;
    } else {
      if (typeof parsed !== 'string') continue;
      const s = shiftIso(parsed, hours);
      if (s === null) continue;
      next = s;
    }
    db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(next), row.key);
    touched += 1;
  }
  return touched;
}

/**
 * Shift a column's timestamps by `@shift` while preserving each stored value's
 * original shape:
 *  - date-only values (`YYYY-MM-DD`, e.g. `tasks.due_date`) stay date-only —
 *    shifting them into a full datetime would fabricate a fake time-of-day and
 *    change DUE_SOON-style semantics downstream.
 *  - datetime values keep their precision: millisecond-precision values
 *    (`.SSS`, what `nowIso()` always writes) keep milliseconds; whole-second
 *    values stay whole-second.
 * Distinguished per-row (not per-column) since `due_date` in particular can
 * hold either shape depending on how the task was created.
 */
function shiftColumnSql(table: string, col: string): string {
  // NOTE: the modifier is applied directly in strftime()/date() rather than via
  // a nested datetime(col, ?) — datetime() truncates to whole seconds, which
  // would silently zero out milliseconds before strftime ever sees them.
  return `
    UPDATE ${table}
    SET ${col} = CASE
      WHEN length(${col}) = 10 THEN date(${col}, @shift)
      WHEN instr(${col}, '.') > 0 THEN strftime('%Y-%m-%dT%H:%M:%fZ', ${col}, @shift)
      ELSE strftime('%Y-%m-%dT%H:%M:%SZ', ${col}, @shift)
    END
    WHERE ${col} IS NOT NULL
  `;
}

/** Apply the timewarp shift to every configured column. Returns total rows touched. */
export function applyTimewarp(db: Database.Database, hours: number): number {
  const modifier = `-${hours} hours`;
  let total = 0;
  const tx = db.transaction(() => {
    for (const [table, cols] of Object.entries(SHIFTS)) {
      for (const col of cols) {
        const r = db.prepare(shiftColumnSql(table, col)).run({ shift: modifier });
        total += r.changes;
      }
    }
    total += shiftSettingsTimestamps(db, hours);
  });
  tx();
  return total;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

// Only run the CLI when this file is executed directly (not when imported by tests).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const hours = Number(arg('hours') ?? 0) + Number(arg('days') ?? 0) * 24;
  if (!hours || Number.isNaN(hours)) {
    console.error('usage: timewarp --hours N | --days N [--db path]');
    process.exit(1);
  }

  const dbPath = arg('db') ?? loadEnv().dbPath;
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // ISO strings sort lexicographically, so a uniform shift preserves all orderings.
  const total = applyTimewarp(db, hours);
  console.log(`timewarp: advanced time by ${hours}h (${total} timestamp updates) in ${dbPath}`);
  db.close();
}
