import type { Bus } from '../bus/index.js';
import type { Db } from '../db/index.js';
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
 * Reminders left overdue while the agent was down are delivered late on the
 * next scan; ones more than COMMITMENT_STALE_GRACE_HOURS overdue are expired by
 * the tick's existing stale sweep (db.expireStaleCommitments) like any other
 * commitment, so a week-old "in 2 minutes" never fires absurdly late.
 */

export const REMINDER_SCAN_INTERVAL_MS = 15_000;

export interface ReminderSchedulerDeps {
  db: Db;
  bus: Bus;
  macNotifier?: MacNotifier;
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
    const due = deps.db.dueCommitments(now).filter((c) => c.kind === 'explicit');
    for (const c of due) {
      const message = `Reminder: ${c.description}`;
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
      // deliver on boot, then steady polling.
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
