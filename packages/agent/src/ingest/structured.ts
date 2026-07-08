import { HEARTBEAT_DEFAULTS } from '@botty/shared';
import type { CalendarEvent, FunnelOutcome, Person, SourceEvent } from '@botty/shared';
import { nowIso, type Db } from '../db/index.js';
import {
  broadcastTasksUpdated,
  clip,
  insertEventRawLog,
  stampOutcome,
  type FunnelCtx,
} from './util.js';

/**
 * Structured sources (gcal, jira, github) skip the classifier/extractor —
 * they're already structured. See docs/specs/ingestion.md "Special handling".
 */

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// ---------- gcal → calendar_events ----------

/** Upsert into calendar_events (not tasks); the event is ALSO raw-logged. */
export function handleGcal(ctx: FunnelCtx, event: SourceEvent): FunnelOutcome {
  const rawLog = insertEventRawLog(ctx.db, event);
  const meta = event.meta;
  const attendees = Array.isArray(meta.attendees)
    ? JSON.stringify(meta.attendees.filter((a) => typeof a === 'string'))
    : null;
  ctx.db.upsertCalendarEvent({
    externalId: event.externalId,
    title: event.text.split('\n')[0]?.trim() || '(untitled event)',
    startAt: str(meta.startAt) ?? event.occurredAt,
    endAt: str(meta.endAt),
    location: str(meta.location),
    attendees,
    description: str(meta.description),
  });
  if (!rawLog) return 'DUPLICATE';
  stampOutcome(ctx.db, rawLog, event, 'UPSERTED', { table: 'calendar_events' });
  return 'UPSERTED';
}

export interface MeetingPrepCandidate {
  event: CalendarEvent;
  tier1Attendees: Person[];
}

/**
 * Meeting-prep candidates for the loop: calendar events starting within
 * `leadMin` minutes of `now` that have at least one Tier-1 attendee.
 */
export function meetingPrepCandidates(
  db: Db,
  opts: { now?: string; leadMin?: number } = {},
): MeetingPrepCandidate[] {
  const now = opts.now ?? nowIso();
  const leadMin = opts.leadMin ?? HEARTBEAT_DEFAULTS.meetingPrepLeadMin;
  const horizon = new Date(Date.parse(now) + leadMin * 60_000).toISOString();
  const out: MeetingPrepCandidate[] = [];
  for (const event of db.eventsStartingBetween(now, horizon)) {
    let attendees: unknown[] = [];
    try {
      const parsed: unknown = event.attendees ? JSON.parse(event.attendees) : [];
      if (Array.isArray(parsed)) attendees = parsed;
    } catch {
      // malformed attendees JSON — treat as none
    }
    const seen = new Set<string>();
    const tier1: Person[] = [];
    for (const attendee of attendees) {
      if (typeof attendee !== 'string') continue;
      const person = db.findPersonByActor({ email: attendee, displayName: attendee });
      if (person && person.tier === 1 && !seen.has(person.id)) {
        seen.add(person.id);
        tier1.push(person);
      }
    }
    if (tier1.length > 0) out.push({ event, tier1Attendees: tier1 });
  }
  return out;
}

// ---------- jira / github → tasks ----------

const CLOSED_JIRA = /^(done|closed|resolved|cancelled|canceled|won'?t\s*(do|fix))$/i;
const CLOSED_GITHUB = new Set(['closed', 'merged']);

/** `source_ref` per spec: issue key for jira, `repo#number` for github. */
export function taskSourceRef(event: SourceEvent): string {
  const meta = event.meta;
  if (event.source === 'jira') return str(meta.key) ?? event.externalId;
  const repo = str(meta.repo);
  const number = meta.number;
  if (repo && (typeof number === 'number' || typeof number === 'string')) {
    return `${repo}#${number}`;
  }
  return event.externalId;
}

function upstreamClosed(event: SourceEvent): boolean {
  const meta = event.meta;
  if (event.source === 'jira') {
    return typeof meta.status === 'string' && CLOSED_JIRA.test(meta.status.trim());
  }
  return typeof meta.state === 'string' && CLOSED_GITHUB.has(meta.state.trim().toLowerCase());
}

/**
 * Assigned jira/github items upsert tasks directly. Status sync: upstream
 * closed ⇒ task done (task_history changed_by='funnel').
 */
export function handleTaskSource(ctx: FunnelCtx, event: SourceEvent): FunnelOutcome {
  const rawLog = insertEventRawLog(ctx.db, event);
  if (!rawLog) return 'DUPLICATE';

  const ref = taskSourceRef(event);
  const closed = upstreamClosed(event);
  const existing = ctx.db.getTaskBySourceRef(event.source, ref);
  let changed = false;

  if (existing) {
    if (closed && (existing.status === 'open' || existing.status === 'snoozed')) {
      ctx.db.updateTask(existing.id, { status: 'done', doneAt: nowIso(), snoozeUntil: null }, 'funnel');
      changed = true;
    }
  } else if (!closed) {
    const description = clip(event.text.split('\n')[0]?.trim() || ref, 200);
    const task = ctx.db.insertTask(
      {
        description,
        rawText: event.text,
        source: event.source,
        sourceRef: ref,
        priority: 2,
      },
      'funnel',
    );
    if (task) {
      ctx.db.ftsIndex('task', task.id, task.description);
      changed = true;
    }
  }

  if (changed) broadcastTasksUpdated(ctx);
  stampOutcome(ctx.db, rawLog, event, 'UPSERTED', { ref, upstreamClosed: closed, changed });
  return 'UPSERTED';
}
