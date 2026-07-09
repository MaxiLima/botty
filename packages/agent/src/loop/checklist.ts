import type { Bus } from '../bus/index.js';
import type { Db } from '../db/index.js';
import type { ChecklistTask } from '../config/parse.js';
import type { ExecutedAction } from './actions.js';
import type { JudgmentAction } from './judgment.js';
import { notifyMacos, type MacNotifier } from './notify-macos.js';

/**
 * Heartbeat checklist tasks (feature #4): user-programmable recurring items
 * from '## Tasks' in heartbeat.md (`- every 4h: <instruction>`). Due items are
 * offered to the tick's judgment layer as trusted, clearly-labeled extra
 * candidates; judgment may notify them or stay silent (its skip decision).
 *
 * Per-item lastRunAt lives in the settings table under CHECKLIST_STATE_KEY as
 * a single JSON object {id → ISO timestamp} — no migration needed. A due item
 * is marked as run after a tick whose judgment call SUCCEEDED (whether or not
 * it spoke); a failed judgment leaves it due so it retries next tick.
 */

export const CHECKLIST_STATE_KEY = 'heartbeat.checklistState';

/**
 * Judgment references checklist items by this prefixed id (kept distinct from
 * real task ids so the hallucinated-task-id guard still holds for tasks).
 */
export const CHECKLIST_ID_PREFIX = 'checklist:';

export type ChecklistState = Record<string, string>;

export function checklistCandidateId(task: Pick<ChecklistTask, 'id'>): string {
  return `${CHECKLIST_ID_PREFIX}${task.id}`;
}

export function loadChecklistState(db: Db): ChecklistState {
  const raw = db.getSetting<unknown>(CHECKLIST_STATE_KEY);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: ChecklistState = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Items whose interval has elapsed since their last run (never-run ⇒ due). */
export function dueChecklistTasks(
  tasks: ChecklistTask[],
  state: ChecklistState,
  now: string,
): ChecklistTask[] {
  const nowMs = Date.parse(now);
  return tasks.filter((t) => {
    const last = state[t.id];
    if (!last) return true;
    const lastMs = Date.parse(last);
    if (!Number.isFinite(lastMs)) return true;
    return nowMs - lastMs >= t.intervalMin * 60_000;
  });
}

/**
 * Mark the due items as run at `now` and prune state for items no longer in
 * heartbeat.md. Call ONLY after a successful judgment pass.
 */
export function markChecklistRun(
  db: Db,
  configured: ChecklistTask[],
  due: ChecklistTask[],
  now: string,
): void {
  const state = loadChecklistState(db);
  if (due.length === 0 && Object.keys(state).length === 0) return;
  const keep = new Set(configured.map((t) => t.id));
  const next: ChecklistState = {};
  for (const [id, at] of Object.entries(state)) if (keep.has(id)) next[id] = at;
  for (const t of due) next[t.id] = now;
  db.setSetting(CHECKLIST_STATE_KEY, next);
}

/**
 * Context block appended to the judgment prompt when checklist items are due.
 * Unlike candidate cards this is user-authored config — trusted instructions,
 * deliberately NOT wrapped in the untrusted-content markers.
 */
export function buildChecklistContext(due: ChecklistTask[]): string {
  const lines = [
    `## Due recurring checklist items (${due.length})`,
    'These are recurring check items the user configured themself in heartbeat.md — trusted,',
    'user-authored instructions, unlike the ingested candidate content above. Each is due now.',
    'For each item either add a `notify` action using its EXACT id below (write `message` as the',
    'short reminder/check the instruction asks for) or list the id in `skipped`. Checklist items',
    'support ONLY notify-or-skip — never snooze or update_priority. They are exempt from the',
    'one-notify-per-tick limit; notifying a due checklist item is normally correct unless the',
    "user's instructions above clearly make now a bad time.",
  ];
  for (const t of due) {
    lines.push(
      '',
      `### Checklist ${checklistCandidateId(t)}`,
      `every: ${t.intervalMin} min`,
      `instruction: ${t.prompt.replace(/\s+/g, ' ').trim()}`,
    );
  }
  return lines.join('\n');
}

/**
 * Execute judgment notify actions that reference checklist items: proactive_log
 * row (no task id, surface_kind 'checklist') + WS notification + macOS banner.
 * Non-notify checklist actions never reach here (validateJudgment drops them).
 */
export function executeChecklistNotifies(
  deps: { db: Db; bus: Bus; macNotifier?: MacNotifier },
  actions: JudgmentAction[],
  due: ChecklistTask[],
  opts: { now: string; trigger: string },
): ExecutedAction[] {
  const mac = deps.macNotifier ?? notifyMacos;
  const byCandidateId = new Map(due.map((t) => [checklistCandidateId(t), t]));
  const executed: ExecutedAction[] = [];

  for (const action of actions) {
    if (action.type !== 'notify') continue;
    const item = byCandidateId.get(action.taskId);
    if (!item) continue;
    const message = action.message?.trim() || item.prompt;
    const row = deps.db.insertProactiveLog({
      taskId: null,
      surfaceKind: 'checklist',
      message,
      score: action.score,
      trigger: opts.trigger,
      surfacedAt: opts.now,
    });
    deps.bus.broadcast({
      type: 'notification',
      payload: { id: row.id, taskId: null, kind: 'checklist', message, score: action.score },
    });
    try {
      mac('botty', message);
    } catch {
      /* macOS notification failures never break a tick */
    }
    executed.push({
      type: 'notify',
      taskId: action.taskId,
      score: action.score,
      message,
      proactiveLogId: row.id,
      reasoning: action.reasoning,
    });
  }
  return executed;
}
