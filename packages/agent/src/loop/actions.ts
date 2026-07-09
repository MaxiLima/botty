import type { Bus } from '../bus/index.js';
import type { Db } from '../db/index.js';
import { broadcastTasksUpdated } from '../ingest/util.js';
import type { JudgmentAction } from './judgment.js';
import { notifyMacos, type MacNotifier } from './notify-macos.js';

/**
 * Action execution (tick step 10):
 * - notify         ⇒ proactive_log row + surface_count++ (+ task_history) + WS `notification`
 *                    + macOS notification (failures swallowed)
 * - snooze         ⇒ task → snoozed with snooze_until (task_history via Db.updateTask)
 * - update_priority⇒ task priority write (task_history via Db.updateTask)
 * Finishes with a single WS `tasks.updated` full-board broadcast (see
 * broadcastTasksUpdated) if any action touched a task — `tasks.updated` is always
 * a full snapshot, never a delta, so clients can safely replace their state.
 */

export interface ActionDeps {
  db: Db;
  bus: Bus;
  /** Injectable for tests; defaults to the real terminal-notifier/osascript path. */
  macNotifier?: MacNotifier;
}

export interface ExecutedAction {
  type: JudgmentAction['type'];
  taskId: string;
  score: number;
  message?: string;
  snoozeUntil?: string;
  priority?: number;
  proactiveLogId?: string;
  reasoning: string;
}

export function executeActions(
  deps: ActionDeps,
  actions: JudgmentAction[],
  opts: {
    now: string;
    trigger: string;
    /** reminderReason by task id — MEETING_PREP notifies get surface_kind 'meeting_prep'. */
    reasonByTask?: Record<string, string | undefined>;
  },
): ExecutedAction[] {
  const { db, bus } = deps;
  const mac = deps.macNotifier ?? notifyMacos;
  const executed: ExecutedAction[] = [];
  const touched = new Set<string>();

  for (const action of actions) {
    const task = db.getTask(action.taskId);
    // Re-check status: the judgment LLM call takes seconds, during which the
    // resolution sweep or the user may have closed the task — never resurrect
    // or re-notify a task that is no longer open.
    if (!task || task.status !== 'open') continue;

    if (action.type === 'notify') {
      const message = action.message?.trim() || task.description;
      const kind =
        opts.reasonByTask?.[action.taskId] === 'MEETING_PREP' ? 'meeting_prep' : 'nudge';
      const row = db.insertProactiveLog({
        taskId: task.id,
        surfaceKind: kind,
        message,
        score: action.score,
        trigger: opts.trigger,
        surfacedAt: opts.now,
      });
      db.recordSurface(task.id, opts.now);
      db.appendTaskHistory(
        task.id,
        'surfaceCount',
        String(task.surfaceCount),
        String(task.surfaceCount + 1),
        'loop',
      );
      bus.broadcast({
        type: 'notification',
        payload: { id: row.id, taskId: task.id, kind, message, score: action.score },
      });
      try {
        mac('botty', message);
      } catch {
        /* macOS notification failures never break a tick */
      }
      touched.add(task.id);
      executed.push({
        type: 'notify',
        taskId: task.id,
        score: action.score,
        message,
        proactiveLogId: row.id,
        reasoning: action.reasoning,
      });
    } else if (action.type === 'snooze') {
      // The prompt promises 1-14 days — clamp so a hallucinated value can't bury a task.
      const days = Math.min(14, Math.max(1, Math.round(action.snoozeDays ?? 1)));
      const snoozeUntil = new Date(Date.parse(opts.now) + days * 86_400_000).toISOString();
      db.updateTask(task.id, { status: 'snoozed', snoozeUntil }, 'loop');
      touched.add(task.id);
      executed.push({
        type: 'snooze',
        taskId: task.id,
        score: action.score,
        snoozeUntil,
        reasoning: action.reasoning,
      });
    } else {
      // update_priority — the task scale is 1 (HIGH) .. 3 (LOW), per docs/specs/data-model.md.
      if (typeof action.priority !== 'number') continue;
      const priority = Math.max(1, Math.min(3, Math.round(action.priority)));
      db.updateTask(task.id, { priority }, 'loop');
      touched.add(task.id);
      executed.push({
        type: 'update_priority',
        taskId: task.id,
        score: action.score,
        priority,
        reasoning: action.reasoning,
      });
    }
  }

  if (touched.size > 0) {
    broadcastTasksUpdated(deps);
  }
  return executed;
}
