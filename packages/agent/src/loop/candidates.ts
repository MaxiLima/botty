import { HEARTBEAT_DEFAULTS, type CalendarEvent, type Task } from '@botty/shared';
import type { Db } from '../db/index.js';
import type { ProactiveCandidate } from '../memory/index.js';

/**
 * Candidate gathering (tick step 4): open tasks tagged with the reason they're
 * being considered — DUE_SOON / NEVER_SURFACED / STALE — plus MEETING_PREP
 * candidates synthesized from upcoming calendar events. Union, deduped by task
 * id; the first reason (in the order above) wins.
 */

export type ReminderReason = 'DUE_SOON' | 'NEVER_SURFACED' | 'STALE' | 'MEETING_PREP';

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
): ProactiveCandidate[] {
  const byId = new Map<string, ProactiveCandidate>();
  const add = (tasks: Task[], reminderReason: ReminderReason) => {
    for (const t of tasks) {
      if (!byId.has(t.id)) byId.set(t.id, { ...t, reminderReason });
    }
  };
  add(db.dueSoon(now, thresholds.dueSoonDays), 'DUE_SOON');
  add(db.neverSurfaced(now, thresholds.neverSurfacedMinAgeHours), 'NEVER_SURFACED');
  add(db.staleTasks(now, thresholds.staleAfterDays), 'STALE');
  add(meetingPrepTasks(db, now, thresholds.meetingPrepLeadMin), 'MEETING_PREP');
  return [...byId.values()];
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
): Task[] {
  const leadMs = leadMin * 60_000;
  const horizon = new Date(Date.parse(now) + leadMs).toISOString();
  const out: Task[] = [];
  for (const event of db.eventsStartingBetween(now, horizon)) {
    if (!hasTier1Attendee(db, event)) continue;
    const sourceRef = `meeting_prep:${event.externalId}`;
    let task = db.getTaskBySourceRef('gcal', sourceRef);
    if (!task) {
      task =
        db.insertTask(
          {
            description: `Prep for meeting "${event.title}" (starts ${event.startAt})`,
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
      task = db.updateTask(task.id, { dueDate: event.startAt }, 'loop');
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
