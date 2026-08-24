import type { FunnelOutcome, SourceEvent } from '@botty/shared';
import { nowIso, type Db, type TaskPatch } from '../db/index.js';
import { findNearDuplicateTask } from './dedup.js';
import {
  broadcastTasksUpdated,
  clip,
  insertEventRawLog,
  mergeTaskEvidence,
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

/**
 * Canonicalize a parseable ISO instant to UTC `Z` form. Real sources (gcal in
 * particular) can hand back offsets like `2026-08-22T10:00:00-03:00`; several
 * call sites compare `start_at`/`due_date` lexicographically in SQL, so an
 * un-canonicalized offset sorts wrong against its `Z` twin (a meeting 30 min
 * out can miss meeting-prep candidacy while the same instant in `Z` form
 * wouldn't). Fix at the write side, here, so nothing downstream has to know
 * about offsets. Date-only `YYYY-MM-DD` values are left untouched — those are
 * end-of-local-day values handled by the read-side `dueDateInstant()` helper
 * (H2), not an instant to canonicalize. Unparseable input passes through
 * unchanged so a malformed value degrades instead of vanishing.
 */
export function toUtcInstant(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}

/** `str()` plus UTC canonicalization, for meta fields that carry instants. */
function strInstant(v: unknown): string | null {
  const s = str(v);
  return s ? toUtcInstant(s) : null;
}

// ---------- gcal → calendar_events ----------

/**
 * meeting_prep source_ref for a gcal event — kept in sync with
 * loop/candidates.ts:meetingPrepTasks, which is the only other place that
 * builds one.
 */
function meetingPrepSourceRef(externalId: string): string {
  return `meeting_prep:${externalId}`;
}

/** Upsert into calendar_events (not tasks); the event is ALSO raw-logged. */
export function handleGcal(ctx: FunnelCtx, event: SourceEvent): FunnelOutcome {
  const rawLog = insertEventRawLog(ctx.db, event);
  const meta = event.meta;

  // H9: a cancelled/deleted upstream event (Google Calendar's event.status)
  // must not become or remain a live meeting-prep candidate. Drop the cached
  // row so eventsStartingBetween (candidates.ts:meetingPrepTasks) stops
  // seeing it, and cancel any prep task already materialized for it — same
  // terminal status candidates.ts's elapsed-meeting sweep uses, not a new
  // one.
  if (str(meta.status)?.toLowerCase() === 'cancelled') {
    ctx.db.deleteCalendarEvent(event.externalId);
    const prepTask = ctx.db.getTaskBySourceRef('gcal', meetingPrepSourceRef(event.externalId));
    if (prepTask && (prepTask.status === 'open' || prepTask.status === 'snoozed')) {
      ctx.db.updateTask(prepTask.id, { status: 'cancelled', snoozeUntil: null }, 'funnel');
    }
    if (!rawLog) return 'DUPLICATE';
    stampOutcome(ctx.db, rawLog, event, 'UPSERTED', { table: 'calendar_events', cancelled: true });
    return 'UPSERTED';
  }

  const attendees = Array.isArray(meta.attendees)
    ? JSON.stringify(meta.attendees.filter((a) => typeof a === 'string'))
    : null;
  ctx.db.upsertCalendarEvent({
    externalId: event.externalId,
    title: event.text.split('\n')[0]?.trim() || '(untitled event)',
    startAt: strInstant(meta.startAt) ?? toUtcInstant(event.occurredAt),
    endAt: strInstant(meta.endAt),
    location: str(meta.location),
    attendees,
    description: str(meta.description),
  });
  if (!rawLog) return 'DUPLICATE';
  stampOutcome(ctx.db, rawLog, event, 'UPSERTED', { table: 'calendar_events' });
  return 'UPSERTED';
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
 * Read an assignee identity off `event.meta`, in whatever shape the source
 * happens to provide it: an actor-shaped object (`{handle, email,
 * displayName}`), or flat string fields (`assigneeHandle`/`assigneeEmail`/
 * `assigneeName`), or a bare `assignee` string (sniffed as a handle/email/
 * name). No real jira/github driver ships yet (both are credential-gated
 * stubs in adapters/index.ts) and no sim scenario sets these fields today, so
 * this is deliberately defensive: absent assignee info changes nothing.
 */
function assigneeActor(meta: SourceEvent['meta']): { handle?: string; email?: string; displayName?: string } | null {
  const raw = meta.assignee;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const handle = str(obj.handle) ?? undefined;
    const email = str(obj.email) ?? undefined;
    const displayName = str(obj.displayName) ?? undefined;
    return handle || email || displayName ? { handle, email, displayName } : null;
  }
  const rawStr = str(raw);
  const handle = str(meta.assigneeHandle) ?? (rawStr?.startsWith('@') ? rawStr : undefined);
  const email = str(meta.assigneeEmail) ?? (rawStr?.includes('@') && !rawStr.startsWith('@') ? rawStr : undefined);
  const displayName = str(meta.assigneeName) ?? (rawStr && !handle && !email ? rawStr : undefined);
  return handle || email || displayName ? { handle, email, displayName } : null;
}

/**
 * True when the payload names an assignee who resolves to a person already
 * KNOWN to botty (team.md or previously discovered). The user is never their
 * own `people` row (team.md lists others), so a resolved match means the item
 * belongs to a teammate, not the user — the case that used to silently become
 * "the user's task". Absent/unresolvable assignee info is not evidence either
 * way: keep the existing behavior (every new key is assumed the user's, per
 * docs/specs/ingestion.md's "assigned items" note).
 */
function assignedToOther(db: Db, event: SourceEvent): boolean {
  const actor = assigneeActor(event.meta);
  return actor !== null && db.findPersonByActor(actor) !== undefined;
}

/** The most recent `status` field change in a task's history, if any. */
function lastStatusChange(db: Db, taskId: string) {
  const rows = db.taskHistory(taskId).filter((r) => r.field === 'status');
  return rows[rows.length - 1];
}

/**
 * Assigned jira/github items upsert tasks directly. Status sync: upstream
 * closed ⇒ task done, upstream re-opened ⇒ task re-opened (task_history
 * changed_by='funnel' either way), and the task description tracks the
 * upstream title/first line so a rename doesn't leave a stale task.
 */
export function handleTaskSource(ctx: FunnelCtx, event: SourceEvent): FunnelOutcome {
  const rawLog = insertEventRawLog(ctx.db, event);
  if (!rawLog) return 'DUPLICATE';

  const ref = taskSourceRef(event);
  const closed = upstreamClosed(event);
  const existing = ctx.db.getTaskBySourceRef(event.source, ref);
  let changed = false;
  const title = clip(event.text.split('\n')[0]?.trim() || ref, 200);

  if (existing) {
    const patch: TaskPatch = {};
    if (closed && (existing.status === 'open' || existing.status === 'snoozed')) {
      patch.status = 'done';
      patch.doneAt = nowIso();
      patch.snoozeUntil = null;
    } else if (existing.status === 'done' && !closed) {
      // Reopen only an item the funnel itself auto-closed (mirrors it back
      // open, symmetric with the close above) — a task the user completed
      // manually is never overridden by an upstream state that hadn't caught
      // up yet.
      const last = lastStatusChange(ctx.db, existing.id);
      if (last && last.newValue === 'done' && last.changedBy === 'funnel') {
        patch.status = 'open';
        patch.doneAt = null;
      }
    }
    if (title && title !== existing.description) {
      patch.description = title;
    }
    if (Object.keys(patch).length > 0) {
      ctx.db.updateTask(existing.id, patch, 'funnel');
      changed = true;
    }
  } else if (!closed) {
    if (assignedToOther(ctx.db, event)) {
      stampOutcome(ctx.db, rawLog, event, 'CLASSIFIED_OUT', { ref, reason: 'assigned_to_other' });
      return 'CLASSIFIED_OUT';
    }

    // Cross-source near-duplicate check (mirrors the extraction path in
    // funnel.ts — see ingest/dedup.ts): the same real-world ask can arrive
    // slack-first ("can you review PR #482") and THEN as the structured
    // GitHub/Jira event for the same ref; without this the structured path
    // blindly inserts a second open task. Only the NEW-task branch is gated —
    // status sync on an existing (source, ref) task above is untouched.
    // Known trade-off, accepted for v1: skipping the insert means this
    // github/jira ref never gets its own task row, so upstream status sync
    // (auto-close on merged/done, the `existing` branch above) won't attach
    // to the surviving cross-source task — it stays open until the resolution
    // sweep or the user closes it. Conservative: a lingering open task beats
    // a duplicate.
    const dupe = findNearDuplicateTask(ctx.db, {
      description: title,
      rawText: event.text,
      source: event.source,
    });
    if (dupe) {
      // Symmetry with funnel.ts's dedup path (H4b): the loser's metadata is
      // merged into the survivor rather than discarded. Structured events carry
      // no requester today, so in practice this only records the cross-source
      // ref as evidence — but a future driver that does supply one won't
      // silently lose it. No followUp: a bot event is not a human re-ask, so it
      // must not re-surface the task.
      const metaDue = event.meta?.dueDate;
      mergeTaskEvidence(ctx.db, dupe, {
        dueDate: typeof metaDue === 'string' ? metaDue : null,
        note: `${event.source} ${ref}: ${title}`,
      });
      stampOutcome(ctx.db, rawLog, event, 'DEDUPED', {
        ref,
        dedupedTasks: [{ description: title, existingTaskId: dupe.id }],
      });
      return 'DEDUPED';
    }

    const task = ctx.db.insertTask(
      {
        description: title,
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
