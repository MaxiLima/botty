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
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const hours = Number(arg('hours') ?? 0) + Number(arg('days') ?? 0) * 24;
if (!hours || Number.isNaN(hours)) {
  console.error('usage: timewarp --hours N | --days N [--db path]');
  process.exit(1);
}

const dbPath = arg('db') ?? loadEnv().dbPath;
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// ISO strings sort lexicographically, so a uniform shift preserves all orderings.
const modifier = `-${hours} hours`;
let total = 0;
const tx = db.transaction(() => {
  for (const [table, cols] of Object.entries(SHIFTS)) {
    for (const col of cols) {
      const r = db
        .prepare(
          `UPDATE ${table}
           SET ${col} = strftime('%Y-%m-%dT%H:%M:%SZ', datetime(${col}, ?))
           WHERE ${col} IS NOT NULL`,
        )
        .run(modifier);
      total += r.changes;
    }
  }
});
tx();
console.log(`timewarp: advanced time by ${hours}h (${total} timestamp updates) in ${dbPath}`);
db.close();
