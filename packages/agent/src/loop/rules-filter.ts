import { HEARTBEAT_DEFAULTS, type ProactiveLogRow } from '@botty/shared';
import type { ProactiveCandidate } from '../memory/index.js';
import { dueDateInstant, isQuietHours } from './time.js';

/**
 * Layer-1 rules filter — pure, no LLM, no I/O. Nine gates in spec order
 * (docs/specs/loop.md §5), cheap checks first, plus one process-local
 * "judgment economy" gate (judgment_skip_cooldown — see below; not yet
 * reflected in the spec doc), which runs LAST so it can never mask the real
 * reason a candidate was held back. Each rejected candidate is reported with
 * the name of the FIRST gate that killed it.
 */

export type GateName =
  | 'cooldown'
  | 'hard_cap'
  | 'snoozed'
  | 'closed'
  | 'quiet_hours'
  | 'min_gap'
  | 'user_active'
  | 'hourly_cap'
  | 'muted'
  | 'judgment_skip_cooldown';

/** The slice of HeartbeatConfig the filter needs (HeartbeatConfig satisfies it). */
export interface RulesConfig {
  quietHours: { start: string; end: string };
  maxSurfacesPerTask: number;
  maxProactivePerHour: number;
  minGapBetweenNudgesMin: number;
  /** Gate 1: per-task cooldown hours keyed by surface_count (1/2/3+). */
  surfaceCooldownHours?: Record<number, number>;
  /** Gate 7: user-active window in minutes. */
  chatActiveGateMin?: number;
}

export interface RulesInputs {
  /** Timestamp of the user's last chat message (gate 7), if any. */
  lastUserChatAt?: string | null;
  /** people.muted_until keyed by person id (gate 9). */
  mutedUntil?: Record<string, string | null>;
  /**
   * A user-triggered run-now (POST /api/loop/run-now → tick.ts `manual`).
   * It is an explicit "check now" request, so it waives the quiet-hours
   * (gate 5) and user-active (gate 7) gates — those exist to avoid
   * interrupting the user unprompted, which doesn't apply when the user just
   * asked. The hard cap, mute, cooldown, snoozed/closed, min-gap and hourly
   * cap are NOT waived — run-now still can't force an over-notified or muted
   * task through. Defaults to false (today's behavior) so existing callers
   * that don't pass it are unaffected.
   */
  runNow?: boolean;
}

export interface RulesRejection {
  taskId: string;
  gate: GateName;
}

export interface RulesFilterResult {
  survivors: ProactiveCandidate[];
  rejections: RulesRejection[];
  /**
   * Nudge-kind (NUDGE_KINDS) surfaces already logged within the trailing hour.
   * Exposed so callers can enforce the SAME rolling hourly budget against
   * actions a single judgment call produces this tick — gate 8 below only ever
   * rejects candidates against surfaces already in the log before judgment
   * runs, it does not cap how many new notifies this tick's judgment output
   * may contain (see loop/tick.ts step 9.5 / loop/judgment.ts applyHourlyBudget).
   */
  nudgesLastHour: number;
}

/** Surface kinds that count as "nudges" for min-gap / hourly-cap (briefings don't). */
export const NUDGE_KINDS = new Set(['nudge', 'meeting_prep']);

const HOUR_MS = 3_600_000;

/**
 * "Due soon enough that our own pacing shouldn't sit on it" — matches the
 * 24h window loop/tick.ts uses to exempt due-soon tasks from the
 * one-notify-per-tick cap (see JUDGMENT_SYSTEM in loop/judgment.ts). Used
 * below both for the cooldown urgency waiver (finding 3) and the sticky-skip
 * urgency waiver (finding 2), so a task racing toward its due date is never
 * blocked by either "we already asked recently" mechanism.
 */
const NOTIFY_WINDOW_MS = 24 * HOUR_MS;

function cooldownHours(surfaceCount: number, table?: Record<number, number>): number {
  const key = Math.min(Math.max(surfaceCount, 1), 3);
  return (table ?? HEARTBEAT_DEFAULTS.surfaceCooldownHours)[key] ?? 168;
}

/** True when `task` is due inside NOTIFY_WINDOW_MS of `nowMs` (H2-safe: date-only due dates resolve to end of local day via dueDateInstant). */
function dueWithinNotifyWindow(task: ProactiveCandidate, nowMs: number): boolean {
  return task.dueDate !== null && dueDateInstant(task.dueDate) - nowMs < NOTIFY_WINDOW_MS;
}

/**
 * Sticky skip (MEDIUM finding "judgment economy", §5 item 8): re-judging the
 * same stale backlog every tick costs a real LLM call and erodes the "err
 * toward silence" bias under repeated sampling. No schema change this pass,
 * so this is a process-local memo (resets on restart — acceptable; worst
 * case is one extra judgment call, not lost product state) of the LAST time
 * each task reached judgment: its reminderReason plus a snapshot of its
 * mutable proactive state. If Db state for a task is unchanged since it was
 * last presented AND its reason is unchanged, nothing happened to it in
 * between — no notify (would bump surfaceCount/lastSurfacedAt), no
 * snooze/dismiss (would change status/snoozeUntil) — so judgment, in all
 * likelihood, skipped it; withhold it from judgment again until the cooldown
 * lapses. ANY change (new reason, new state) clears the entry immediately.
 */
interface JudgedMemoEntry {
  reason: string | undefined;
  stateKey: string;
  presentedAt: number;
}
const judgedMemo = new Map<string, JudgedMemoEntry>();

/** Hours a task presented-and-unchanged is withheld from judgment before trying again. */
const STICKY_SKIP_COOLDOWN_HOURS = 6;

function stateKeyFor(task: ProactiveCandidate): string {
  return `${task.status}|${task.surfaceCount}|${task.lastSurfacedAt ?? ''}|${task.snoozeUntil ?? ''}`;
}

/** Test-only: clear the sticky-skip memo between test cases (module-level state). */
export function resetJudgmentMemoForTests(): void {
  judgedMemo.clear();
}

export function applyRulesFilter(
  candidates: ProactiveCandidate[],
  config: RulesConfig,
  now: string,
  recentSurfaces: ProactiveLogRow[],
  inputs: RulesInputs = {},
): RulesFilterResult {
  const nowMs = Date.parse(now);
  const nudges = recentSurfaces.filter((s) => NUDGE_KINDS.has(s.surfaceKind));
  const lastNudgeMs = nudges.reduce((max, s) => Math.max(max, Date.parse(s.surfacedAt)), 0);
  const nudgesLastHour = nudges.filter((s) => Date.parse(s.surfacedAt) > nowMs - HOUR_MS).length;

  // Global gates, evaluated once. A user-triggered run-now (finding 5) waives
  // quiet-hours and user-active — it's an explicit "check now" request, not
  // an unprompted interruption — but NOT min-gap or the hourly cap, which
  // protect against a burst of notifies rather than an unwanted one.
  const quiet = !inputs.runNow && isQuietHours(now, config.quietHours);
  const minGapBlocked =
    lastNudgeMs > 0 && nowMs - lastNudgeMs < config.minGapBetweenNudgesMin * 60_000;
  const userActive =
    !inputs.runNow &&
    inputs.lastUserChatAt != null &&
    nowMs - Date.parse(inputs.lastUserChatAt) <
      (config.chatActiveGateMin ?? HEARTBEAT_DEFAULTS.chatActiveGateMin) * 60_000;
  const hourlyCapReached = nudgesLastHour >= config.maxProactivePerHour;

  const survivors: ProactiveCandidate[] = [];
  const rejections: RulesRejection[] = [];

  for (const task of candidates) {
    const gate = firstFailingGate(task);
    if (gate) rejections.push({ taskId: task.id, gate });
    else survivors.push(task);
  }
  // Sticky skip (finding 2): remember what we're about to hand to judgment —
  // reason + mutable state — so a later tick can tell whether anything
  // happened to it since. Only survivors are memoized; a task rejected by
  // another gate never reaches judgment this tick, so its old memo entry (if
  // any) is left as-is.
  for (const task of survivors) {
    judgedMemo.set(task.id, {
      reason: task.reminderReason,
      stateKey: stateKeyFor(task),
      presentedAt: nowMs,
    });
  }
  return { survivors, rejections, nudgesLastHour };

  function firstFailingGate(task: ProactiveCandidate): GateName | null {
    // 1. per-task cooldown escalation {1→48h, 2→96h, 3+→7d} — waived for
    // SNOOZE_EXPIRED (H3): the user set this snooze themselves, i.e. explicitly
    // asked to be reminded again at this moment; the cooldown exists to damp
    // organic re-nagging about an unaddressed task, which isn't what's
    // happening here. Also waived (finding 3) when the task has become due
    // inside the notify window: a task nudged yesterday as NEVER_SURFACED and
    // now due in 2h shouldn't stay blocked until the 48h cooldown clock runs
    // out — the user's own timeline overrides our pacing here too. Gate 2's
    // hard cap is NOT waived by either exemption, so this can't become an
    // infinite nag — total lifetime notifies for the task still tops out at
    // maxSurfacesPerTask (default 3) same as any other reason.
    if (
      task.reminderReason !== 'SNOOZE_EXPIRED' &&
      task.surfaceCount > 0 &&
      task.lastSurfacedAt
    ) {
      const sinceMs = nowMs - Date.parse(task.lastSurfacedAt);
      const withinCooldown =
        sinceMs < cooldownHours(task.surfaceCount, config.surfaceCooldownHours) * HOUR_MS;
      if (withinCooldown && !dueWithinNotifyWindow(task, nowMs)) {
        return 'cooldown';
      }
    }
    // 2. hard cap on total surfaces — unless due within 48h
    if (task.surfaceCount >= config.maxSurfacesPerTask) {
      // dueDateInstant (H2): a date-only dueDate is end-of-LOCAL-day, not
      // Date.parse's UTC midnight — see loop/time.ts.
      const dueSoon = task.dueDate !== null && dueDateInstant(task.dueDate) - nowMs < 48 * HOUR_MS;
      if (!dueSoon) return 'hard_cap';
    }
    // 3. snoozed
    if (task.snoozeUntil && Date.parse(task.snoozeUntil) > nowMs) return 'snoozed';
    // 4. closed status
    if (task.status !== 'open') return 'closed';
    // 5. quiet hours (redundant guard — the tick gate normally catches this)
    if (quiet) return 'quiet_hours';
    // 6. global min gap between nudges
    if (minGapBlocked) return 'min_gap';
    // 7. user currently active in chat
    if (userActive) return 'user_active';
    // 8. hourly proactive cap
    if (hourlyCapReached) return 'hourly_cap';
    // 9. requester muted
    if (task.requestedBy) {
      const until = inputs.mutedUntil?.[task.requestedBy];
      if (until && Date.parse(until) > nowMs) return 'muted';
    }
    // 10. sticky skip (judgment economy — see judgedMemo above): a task
    // judgment has already looked at with the SAME reason and UNCHANGED state
    // hasn't had anything happen to it since (no notify/snooze/dismiss would
    // leave state untouched), so don't spend another LLM call on it yet.
    // Exempt SNOOZE_EXPIRED (the user's own explicit request) and any task
    // newly due inside the notify window, same as the cooldown waiver above —
    // this can never suppress either of those.
    // Deliberately LAST: it is an economy gate, not a product rule, and its
    // only job is to stop an LLM call for a task that would otherwise have
    // reached judgment. Evaluated earlier it would shadow the real reason a
    // task was held back (quiet_hours, muted, user_active…) in the tick log
    // and the Inspector, which is the one place that has to stay truthful.
    // Also waived for a user-triggered run-now: "check now" is a request for a
    // fresh evaluation, not for last tick's cached conclusion.
    if (
      !inputs.runNow &&
      task.reminderReason !== 'SNOOZE_EXPIRED' &&
      !dueWithinNotifyWindow(task, nowMs)
    ) {
      const entry = judgedMemo.get(task.id);
      if (
        entry &&
        entry.reason === task.reminderReason &&
        entry.stateKey === stateKeyFor(task) &&
        nowMs - entry.presentedAt < STICKY_SKIP_COOLDOWN_HOURS * HOUR_MS
      ) {
        return 'judgment_skip_cooldown';
      }
    }
    return null;
  }
}
