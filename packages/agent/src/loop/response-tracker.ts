import { HEARTBEAT_DEFAULTS, type ProactiveLogRow } from '@botty/shared';
import type { Bus } from '../bus/index.js';
import type { Db } from '../db/index.js';

/**
 * Response tracker (docs/specs/loop.md "Response tracker"). v1 is heuristic
 * only (no LLM): each user chat message is matched against un-responded
 * surfaces from the last 24h. A message that mentions a surfaced task's
 * keywords AND a completion phrase ⇒ 'completed'; a snooze phrase ⇒ 'snoozed'.
 * UI buttons remain the primary path (they call REST tasks/:id/action); this
 * only fills proactive_log.response_*. Unanswered surfaces expire after 24h.
 */

export const COMPLETION_RE =
  /\b(done|finished|completed|complete|shipped|resolved|closed|merged|sent|hecho|hecha|listo|lista|terminado|terminada)\b|ya\s+est[aá]/i;

export const SNOOZE_RE =
  /\b(later|snooze|tomorrow|next week|not now|ma[nñ]ana|despu[eé]s|luego|ahora no)\b/i;

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'about', 'para', 'sobre', 'esta', 'este',
  'when', 'will', 'have', 'been', 'they', 'them', 'your', 'please', 'meeting',
]);

/** Content words (≥4 chars, minus stopwords) from a task description. */
export function keywordsFor(description: string): string[] {
  const words = description.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  return [...new Set(words.filter((w) => !STOPWORDS.has(w)))];
}

export interface SurfaceWithTask {
  surface: ProactiveLogRow;
  taskDescription: string;
}

export interface Classification {
  surfaceId: string;
  taskId: string;
  responseType: 'completed' | 'snoozed';
}

/** Pure heuristic classification of one user message against open surfaces. */
export function classifyMessage(message: string, surfaces: SurfaceWithTask[]): Classification[] {
  const msg = message.toLowerCase();
  const completed = COMPLETION_RE.test(message);
  const snoozed = SNOOZE_RE.test(message);
  if (!completed && !snoozed) return [];

  const out: Classification[] = [];
  for (const { surface, taskDescription } of surfaces) {
    if (!surface.taskId) continue;
    const kws = keywordsFor(taskDescription);
    if (kws.length === 0 || !kws.some((k) => msg.includes(k))) continue;
    out.push({
      surfaceId: surface.id,
      taskId: surface.taskId,
      responseType: completed ? 'completed' : 'snoozed',
    });
  }
  return out;
}

/** Surface kinds the tracker classifies against (briefings aren't per-task asks). */
const TRACKED_KINDS = new Set(['nudge', 'meeting_prep']);

export interface ResponseTracker {
  start(): void;
  stop(): void;
  /** ISO timestamp of the most recent user chat message seen (rules gate 7). */
  lastUserMessageAt(): string | null;
  /** Classify one message now (also invoked via the bus subscription). */
  handleMessage(text: string, at: string): Classification[];
  /** Mark surfaces older than the response window as expired. Returns count. */
  expire(now?: string): number;
}

export function createResponseTracker(deps: { db: Db; bus: Bus }): ResponseTracker {
  const { db, bus } = deps;
  const windowMs = HEARTBEAT_DEFAULTS.responseWindowHours * 3_600_000;
  let unsubscribe: (() => void) | null = null;
  let lastAt: string | null = null;

  function handleMessage(text: string, at: string): Classification[] {
    lastAt = at;
    const since = new Date(Date.parse(at) - windowMs).toISOString();
    const candidates: SurfaceWithTask[] = [];
    for (const surface of db.openSurfacesSince(since)) {
      if (!TRACKED_KINDS.has(surface.surfaceKind) || !surface.taskId) continue;
      const task = db.getTask(surface.taskId);
      if (!task) continue;
      candidates.push({ surface, taskDescription: task.description });
    }
    const results = classifyMessage(text, candidates);
    for (const r of results) {
      db.setProactiveResponse(r.surfaceId, r.responseType, `chat: ${text.slice(0, 120)}`);
    }
    return results;
  }

  return {
    start() {
      if (unsubscribe) return;
      unsubscribe = bus.on('chat.userMessage', ({ text, at }) => {
        try {
          handleMessage(text, at);
        } catch (err) {
          console.error('[loop] response tracker failed:', (err as Error).message);
        }
      });
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
    },
    lastUserMessageAt: () => lastAt,
    handleMessage,
    expire(now = new Date().toISOString()) {
      return db.expireSurfacesBefore(new Date(Date.parse(now) - windowMs).toISOString());
    },
  };
}
