// Mirrors packages/web/src/lib/format.ts so both clients present the same
// values for the same data (priority direction, age tiers, fallbacks).
// Candidate to hoist into @botty/shared if a third client appears.
import type { ScheduleInfo } from './api.js';

/** "3m" / "2h" / "5d" style relative age from an ISO timestamp. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '–';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '–';
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 9) return `${w}w`;
  return `${Math.floor(d / 30)}mo`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Task priority: 1 = HIGH, 2 = NORMAL, 3 = LOW (docs/specs/data-model.md). */
export function priorityLabel(p: number): string {
  if (!Number.isFinite(p)) return 'P2'; // fall back to NORMAL
  const clamped = Math.min(3, Math.max(1, Math.round(p)));
  return `P${clamped}`;
}

export function priorityColor(p: number): string | undefined {
  const label = priorityLabel(p);
  if (label === 'P1') return 'red';
  if (label === 'P2') return 'yellow';
  return 'cyan';
}

/** Same open-board ordering as the web TasksPage: ascending priority (1 = HIGH first), then oldest. */
export function byPriorityThenAge(a: { priority: number; createdAt: string }, b: { priority: number; createdAt: string }): number {
  return a.priority - b.priority || a.createdAt.localeCompare(b.createdAt);
}

/**
 * Botty's proactive silence during off-hours/quiet-hours/inactive days is by
 * design, but looks indistinguishable from "broken" without a hint. `schedule`
 * is optional on the health response (older agents omit it) — undefined means
 * "say nothing", not "assume always-on".
 */
export function scheduleHint(schedule: ScheduleInfo | null | undefined): string | null {
  if (!schedule) return null;
  if (!schedule.activeToday) return 'inactive today';
  if (schedule.quietHours) return `quiet ${schedule.quietHoursRange}`;
  if (!schedule.withinWorkingHours) return 'off-hours';
  return null;
}

/**
 * Aggregates the gate keys recorded in a tick's `skippedJson` into a compact
 * summary, e.g. "(quiet_hours×11, cooldown×1)" — null when there's nothing to
 * show. Shapes observed from packages/agent/src/loop/tick.ts:
 *   - a whole-tick skip: {"timing":"off_hours"|"quiet_hours"|"inactive_day"}
 *   - a per-candidate rejection log: {"rules":[{"taskId":..,"gate":"cooldown"}, ...], ...}
 * Both can carry a "gate" (or "timing") string we count occurrences of.
 */
export function summarizeGates(skippedJson: string | null | undefined): string | null {
  if (!skippedJson) return null;
  let data: unknown;
  try {
    data = JSON.parse(skippedJson);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const counts = new Map<string, number>();
  const bump = (k: unknown) => {
    if (typeof k === 'string' && k) counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  const obj = data as Record<string, unknown>;
  bump(obj['timing']);
  if (Array.isArray(obj['rules'])) {
    for (const r of obj['rules']) {
      if (r && typeof r === 'object') bump((r as Record<string, unknown>)['gate']);
    }
  }
  if (counts.size === 0) return null;
  const parts = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([gate, n]) => `${gate}×${n}`);
  return `(${parts.join(', ')})`;
}
