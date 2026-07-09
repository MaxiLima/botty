import { HEARTBEAT_DEFAULTS, type ProactiveLogRow } from '@botty/shared';
import type { ProactiveCandidate } from '../memory/index.js';
import { isQuietHours } from './time.js';

/**
 * Layer-1 rules filter — pure, no LLM, no I/O. Nine gates in spec order
 * (docs/specs/loop.md §5), cheap checks first. Each rejected candidate is
 * reported with the name of the FIRST gate that killed it.
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
  | 'muted';

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
}

export interface RulesRejection {
  taskId: string;
  gate: GateName;
}

export interface RulesFilterResult {
  survivors: ProactiveCandidate[];
  rejections: RulesRejection[];
}

/** Surface kinds that count as "nudges" for min-gap / hourly-cap (briefings don't). */
const NUDGE_KINDS = new Set(['nudge', 'meeting_prep']);

const HOUR_MS = 3_600_000;

function cooldownHours(surfaceCount: number, table?: Record<number, number>): number {
  const key = Math.min(Math.max(surfaceCount, 1), 3);
  return (table ?? HEARTBEAT_DEFAULTS.surfaceCooldownHours)[key] ?? 168;
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

  // Global gates, evaluated once.
  const quiet = isQuietHours(now, config.quietHours);
  const minGapBlocked =
    lastNudgeMs > 0 && nowMs - lastNudgeMs < config.minGapBetweenNudgesMin * 60_000;
  const userActive =
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
  return { survivors, rejections };

  function firstFailingGate(task: ProactiveCandidate): GateName | null {
    // 1. per-task cooldown escalation {1→48h, 2→96h, 3+→7d}
    if (task.surfaceCount > 0 && task.lastSurfacedAt) {
      const sinceMs = nowMs - Date.parse(task.lastSurfacedAt);
      if (sinceMs < cooldownHours(task.surfaceCount, config.surfaceCooldownHours) * HOUR_MS) {
        return 'cooldown';
      }
    }
    // 2. hard cap on total surfaces — unless due within 48h
    if (task.surfaceCount >= config.maxSurfacesPerTask) {
      const dueSoon =
        task.dueDate !== null && Date.parse(task.dueDate) - nowMs < 48 * HOUR_MS;
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
    return null;
  }
}
