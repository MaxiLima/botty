import type { Bus } from '../bus/index.js';
import { defaultTimeZone, formatLocalIsoWithOffset } from '../chat/commitments.js';
import type { Db } from '../db/index.js';
import { COMMITMENT_STALE_GRACE_HOURS } from './commitments.js';
import { notifyMacos, type MacNotifier } from './notify-macos.js';

/**
 * Explicit reminders (kind='explicit' commitments, created by the set_reminder
 * chat tool): "remind me in 2 minutes / at 4pm". Unlike inferred commitments —
 * conversation-derived guesses that ride tick judgment behind min-age and
 * per-day anti-nag gates — an explicit reminder is a direct user command for a
 * precise moment, so this scheduler delivers it exactly at due_at:
 *   - no judgment LLM call (nothing to judge; also zero cost),
 *   - no min-age / maxPerDay caps, no working- or quiet-hours gate,
 *   - a cheap SQLite poll every SCAN_INTERVAL_MS (local DB, negligible).
 * Downtime (H10b, 2026-08-21 report): every scan — the boot one included —
 * sweeps explicit reminders more than COMMITMENT_STALE_GRACE_HOURS overdue
 * BEFORE delivering, so a 3-day-old "remind me in 2 minutes" is expired instead
 * of fired. Relying on the tick's sweep did not work: the boot scan runs first,
 * and ticks that reach the sweep are themselves working-hours-gated. Reminders
 * overdue by less than the grace period still deliver, and say how late they
 * are ("(was due Fri 18:07)", the user's local time).
 */

export const REMINDER_SCAN_INTERVAL_MS = 15_000;

/** Past this much lateness the delivered message says when it was actually due. */
export const REMINDER_LATE_HINT_MIN = 5;

export interface ReminderSchedulerDeps {
  db: Db;
  bus: Bus;
  macNotifier?: MacNotifier;
  /** IANA zone for the "(was due …)" hint; defaults to the process zone (the user's). */
  timeZone?: string;
}

/**
 * "Fri 18:07" — local weekday + wall clock for a due instant. Lateness is
 * capped by the grace period (< 24h), so weekday + time is unambiguous.
 * Reuses formatLocalIsoWithOffset for the offset math (H1) rather than
 * duplicating it.
 */
export function formatDueHint(iso: string, timeZone: string): string {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(
    new Date(iso),
  );
  const hhmm = formatLocalIsoWithOffset(iso, timeZone).slice(11, 16);
  return `${weekday} ${hhmm}`;
}

/**
 * The user-facing reminder text: bare when on time, with a "(was due …)" hint
 * when materially late, so a reminder delivered after downtime never looks like
 * it just came due.
 */
export function reminderMessage(
  description: string,
  dueAt: string,
  now: string,
  timeZone: string,
): string {
  const lateMs = Date.parse(now) - Date.parse(dueAt);
  const base = `Reminder: ${description}`;
  return lateMs > REMINDER_LATE_HINT_MIN * 60_000
    ? `${base} (was due ${formatDueHint(dueAt, timeZone)})`
    : base;
}

export interface ReminderScheduler {
  start(): void;
  stop(): void;
  /** One scan pass (exposed for tests and run-now paths). Returns count delivered. */
  scan(now?: string): number;
}

export function createReminderScheduler(deps: ReminderSchedulerDeps): ReminderScheduler {
  const mac = deps.macNotifier ?? notifyMacos;
  let timer: NodeJS.Timeout | null = null;

  function scan(now = new Date().toISOString()): number {
    // Sweep first, deliver second: a reminder that went past the grace period
    // while the agent was down must never fire (it would arrive days late, out
    // of any useful context). Scoped to kind='explicit' — inferred commitments
    // are the working-hours-gated tick's to sweep, at the END of a tick, so one
    // due over a weekend survives to Monday (loop/tick.ts step 10.5).
    deps.db.expireStaleCommitments(now, COMMITMENT_STALE_GRACE_HOURS, 'explicit');
    const timeZone = deps.timeZone ?? defaultTimeZone();
    const due = deps.db.dueCommitments(now).filter((c) => c.kind === 'explicit');
    for (const c of due) {
      const message = reminderMessage(c.description, c.dueAt, now, timeZone);
      const row = deps.db.insertProactiveLog({
        taskId: null,
        surfaceKind: 'reminder',
        message,
        score: null,
        trigger: 'reminder',
        surfacedAt: now,
      });
      deps.db.markCommitmentDelivered(c.id, now);
      deps.bus.broadcast({
        type: 'notification',
        payload: { id: row.id, taskId: null, kind: 'reminder', message, score: null },
      });
      try {
        mac('botty', message);
      } catch {
        /* banner failures never break delivery bookkeeping */
      }
    }
    return due.length;
  }

  return {
    start() {
      if (timer) return;
      // Immediate pass so reminders that came due while the agent was down
      // deliver on boot, then steady polling. The pass sweeps stale ones first,
      // so nothing past the grace period fires here (H10b).
      try {
        scan();
      } catch (err) {
        console.error('[reminders] scan failed:', (err as Error).message);
      }
      timer = setInterval(() => {
        try {
          const n = scan();
          if (n > 0) console.log(`[reminders] delivered ${n} explicit reminder(s)`);
        } catch (err) {
          console.error('[reminders] scan failed:', (err as Error).message);
        }
      }, REMINDER_SCAN_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    scan,
  };
}
