import { HEARTBEAT_DEFAULTS, type CalendarEvent, type Task } from '@botty/shared';
import { defaultTimeZone, formatLocalIsoWithOffset } from '../chat/commitments.js';
import type { Db } from '../db/index.js';
import type { ProactiveCandidate } from '../memory/index.js';

/**
 * Candidate gathering (tick step 4): open tasks tagged with the reason they're
 * being considered — SNOOZE_EXPIRED / MEETING_PREP / DUE_SOON / NEVER_SURFACED
 * / STALE, the last synthesized from upcoming calendar events, the rest read
 * straight off Db. Union, deduped by task id; the first reason (in the order
 * above — i.e. gatherCandidates' `add()` call order below) wins.
 */

export type ReminderReason =
  | 'SNOOZE_EXPIRED'
  | 'DUE_SOON'
  | 'NEVER_SURFACED'
  | 'STALE'
  | 'MEETING_PREP';

/**
 * H9: grace period after a meeting's startAt before its synthesized prep task
 * auto-closes (status 'cancelled'). Long enough that a user glancing at the
 * task moments into the meeting still sees it; short enough that a past
 * meeting doesn't sit around as an eternal DUE_SOON candidate that bypasses
 * the hard cap (rules-filter.ts gate 2) and the one-notify cap every tick.
 */
export const MEETING_PREP_CLOSE_GRACE_MIN = 30;

/** The slice of HeartbeatConfig candidate gathering needs (HeartbeatConfig satisfies it). */
export interface CandidateThresholds {
  dueSoonDays: number;
  neverSurfacedMinAgeHours: number;
  staleAfterDays: number;
  meetingPrepLeadMin: number;
}

export function gatherCandidates(
  db: Db,
  now: string,
  thresholds: CandidateThresholds = HEARTBEAT_DEFAULTS,
  timeZone: string = defaultTimeZone(),
): ProactiveCandidate[] {
  // H9: close prep tasks whose meeting has come and gone BEFORE gathering, so
  // an elapsed meeting never rides along this tick as a phantom DUE_SOON
  // candidate (see MEETING_PREP_CLOSE_GRACE_MIN).
  closeElapsedMeetingPrepTasks(db, now);

  const byId = new Map<string, ProactiveCandidate>();
  const add = (tasks: Task[], reminderReason: ReminderReason) => {
    for (const t of tasks) {
      if (!byId.has(t.id)) byId.set(t.id, { ...t, reminderReason });
    }
  };
  // H3: snooze-expiry reopens are the user's own explicit "remind me then" —
  // tag first (highest precedence) so that reason always wins even when a
  // task also matches DUE_SOON etc. Persists across ticks via task_history
  // (db.snoozeExpiredTasks) rather than a one-shot flag from unsnoozeDue, so
  // a tick where some other gate still rejects it doesn't lose the signal.
  add(db.snoozeExpiredTasks(), 'SNOOZE_EXPIRED');
  // MEETING_PREP is tagged BEFORE dueSoon() runs (2026-08-21 report, §5 item
  // 6 / §3 MEDIUM "Loop"): a synthesized prep task's dueDate is the meeting's
  // startAt, which is by construction inside dueSoonDays — so on every tick
  // after the one that created it, db.dueSoon() would also return it. Since
  // `add` only tags a task on its FIRST match, DUE_SOON used to win from the
  // second tick onward (dueSoon() ran first), flipping the reason judgment
  // and the UI see even though nothing about the candidate changed. Tagging
  // meeting-prep first keeps the more specific reason stable for the task's
  // whole lifetime (H9's auto-close still retires it 30min after start).
  add(meetingPrepTasks(db, now, thresholds.meetingPrepLeadMin, timeZone), 'MEETING_PREP');
  add(db.dueSoon(now, thresholds.dueSoonDays), 'DUE_SOON');
  add(db.neverSurfaced(now, thresholds.neverSurfacedMinAgeHours), 'NEVER_SURFACED');
  add(db.staleTasks(now, thresholds.staleAfterDays), 'STALE');
  return [...byId.values()];
}

/** See MEETING_PREP_CLOSE_GRACE_MIN. */
function closeElapsedMeetingPrepTasks(
  db: Db,
  now: string,
  graceMin: number = MEETING_PREP_CLOSE_GRACE_MIN,
): void {
  for (const task of db.elapsedMeetingPrepTasks(now, graceMin)) {
    db.updateTask(task.id, { status: 'cancelled', snoozeUntil: null }, 'loop');
  }
}

/**
 * Calendar events starting within meetingPrepLeadMin (default 60) that have a
 * Tier-1 attendee raise a meeting-prep candidate. We materialize each as a task
 * (source 'gcal', sourceRef 'meeting_prep:<externalId>') so judgment actions
 * have a real task id to reference; the (source, source_ref) UNIQUE constraint
 * makes this idempotent across ticks.
 *
 * NOTE: this is a minimal duplicate of ingest's meeting-prep calendar query
 * (ingest is built concurrently — see docs/specs/ingestion.md "gcal" special
 * handling). If ingest ships its own helper, converge on one implementation.
 */
export function meetingPrepTasks(
  db: Db,
  now: string,
  leadMin: number = HEARTBEAT_DEFAULTS.meetingPrepLeadMin,
  timeZone: string = defaultTimeZone(),
): Task[] {
  const leadMs = leadMin * 60_000;
  const horizon = new Date(Date.parse(now) + leadMs).toISOString();
  const out: Task[] = [];
  for (const event of db.eventsStartingBetween(now, horizon)) {
    if (!hasTier1Attendee(db, event)) continue;
    const sourceRef = `meeting_prep:${event.externalId}`;
    // Local wall-clock + offset (H1 bugfix) — this description is shown to
    // the user as-is (task list, notifications), not just fed to an LLM, so a
    // bare UTC startAt would misstate the meeting time.
    const description = `Prep for meeting "${event.title}" (starts ${formatLocalIsoWithOffset(event.startAt, timeZone)})`;
    let task = db.getTaskBySourceRef('gcal', sourceRef);
    if (!task) {
      task =
        db.insertTask(
          {
            description,
            source: 'gcal',
            sourceRef,
            dueDate: event.startAt,
            // Tier-1 meeting, imminent by construction — HIGH on the 1..3 scale.
            priority: 1,
          },
          'loop',
        ) ?? db.getTaskBySourceRef('gcal', sourceRef);
    } else if (task.status === 'open' && task.dueDate !== event.startAt) {
      // The meeting moved since the prep task was created — keep the reminder
      // in sync with the calendar rather than nagging about the stale time.
      task = db.updateTask(task.id, { dueDate: event.startAt, description }, 'loop');
    } else if (task.status === 'cancelled' && task.dueDate !== event.startAt) {
      // H9: this externalId's prep task already auto-closed (see
      // closeElapsedMeetingPrepTasks) after ITS occurrence's meeting passed,
      // and the calendar now shows a later startAt for the same externalId —
      // either the meeting was rescheduled forward past its own start, or
      // (recurring series that reuses one externalId — calendar_events has no
      // per-instance identity to key on, and that table is migration-frozen,
      // so this is the best available signal) this is the NEXT occurrence.
      // Either way, recycle the task rather than leaving it dead forever:
      // reopen, refresh the stale description, and reset surfacing history so
      // the previous (unrelated) occurrence's cooldown/hard-cap count doesn't
      // suppress this one.
      task = db.updateTask(
        task.id,
        {
          status: 'open',
          dueDate: event.startAt,
          description,
          doneAt: null,
          surfaceCount: 0,
          lastSurfacedAt: null,
        },
        'loop',
      );
    }
    if (task && task.status === 'open') out.push(task);
  }
  return out;
}

function hasTier1Attendee(db: Db, event: CalendarEvent): boolean {
  if (!event.attendees) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.attendees);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  for (const entry of parsed) {
    const actor = attendeeToActor(entry);
    if (!actor) continue;
    const person = db.findPersonByActor(actor);
    if (person?.tier === 1) return true;
  }
  return false;
}

function attendeeToActor(
  entry: unknown,
): { handle?: string; email?: string; displayName?: string } | null {
  if (typeof entry === 'string') {
    const s = entry.trim();
    if (!s) return null;
    if (s.includes('@') && s.includes('.')) return { email: s };
    if (s.startsWith('@')) return { handle: s };
    return { displayName: s };
  }
  if (entry && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    const actor: { handle?: string; email?: string; displayName?: string } = {};
    if (typeof o.email === 'string') actor.email = o.email;
    if (typeof o.handle === 'string') actor.handle = o.handle;
    if (typeof o.slackHandle === 'string') actor.handle = o.slackHandle;
    if (typeof o.name === 'string') actor.displayName = o.name;
    if (typeof o.displayName === 'string') actor.displayName = o.displayName;
    return actor.email || actor.handle || actor.displayName ? actor : null;
  }
  return null;
}
