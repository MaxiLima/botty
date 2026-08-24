import { describe, expect, it } from 'vitest';
import { defaultTimeZone, formatLocalIsoWithOffset } from '../../src/chat/commitments.js';
import { Db } from '../../src/db/index.js';
import { gatherCandidates, meetingPrepTasks } from '../../src/loop/candidates.js';

/** Tier-1 attendee so meetingPrepTasks raises a candidate for the event. */
function tier1Person(db: Db, name = 'Dana Tier1') {
  return db.upsertTeamPerson({ name, weight: 'HIGH', email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com` });
}

describe('meetingPrepTasks', () => {
  it('creates a meeting_prep task for an upcoming Tier-1 meeting', () => {
    const db = new Db(':memory:');
    const person = tier1Person(db);
    const now = '2026-07-13T08:00:00.000Z';
    const startAt = '2026-07-13T08:30:00.000Z';
    db.upsertCalendarEvent({
      externalId: 'evt-1',
      title: '1:1 with Dana',
      startAt,
      attendees: JSON.stringify([{ email: person.email }]),
    });

    const tasks = meetingPrepTasks(db, now, 60);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.dueDate).toBe(startAt);
    expect(tasks[0]!.sourceRef).toBe('meeting_prep:evt-1');
  });

  // H1 (2026-08-21 investigation): this description is shown to the user
  // as-is (task list, notifications) — a bare UTC startAt would misstate the
  // meeting time for negative-offset users.
  it('renders the meeting time in the description as LOCAL wall-clock with offset, not bare UTC', () => {
    const db = new Db(':memory:');
    const person = tier1Person(db);
    const now = '2026-08-15T08:00:00.000Z';
    const startAt = '2026-08-16T01:17:00.000Z'; // 2026-08-15T22:17:00-03:00 in Buenos Aires
    db.upsertCalendarEvent({
      externalId: 'evt-tz',
      title: 'Sprint planning',
      startAt,
      attendees: JSON.stringify([{ email: person.email }]),
    });

    const tz = 'America/Argentina/Buenos_Aires';
    const tasks = meetingPrepTasks(db, now, 24 * 60, tz);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.description).toBe(
      `Prep for meeting "Sprint planning" (starts ${formatLocalIsoWithOffset(startAt, tz)})`,
    );
    expect(tasks[0]!.description).not.toContain(startAt);
  });

  it('is idempotent across ticks — a second call does not create a duplicate task', () => {
    const db = new Db(':memory:');
    const person = tier1Person(db);
    const now = '2026-07-13T08:00:00.000Z';
    const startAt = '2026-07-13T08:30:00.000Z';
    db.upsertCalendarEvent({
      externalId: 'evt-1',
      title: '1:1 with Dana',
      startAt,
      attendees: JSON.stringify([{ email: person.email }]),
    });

    meetingPrepTasks(db, now, 60);
    const tasks = meetingPrepTasks(db, now, 60);
    expect(tasks).toHaveLength(1);
  });

  it('updates dueDate when the meeting is rescheduled, keeping the reminder in sync', () => {
    const db = new Db(':memory:');
    const person = tier1Person(db);
    const now = '2026-07-13T08:00:00.000Z';
    const originalStart = '2026-07-13T08:30:00.000Z';
    db.upsertCalendarEvent({
      externalId: 'evt-1',
      title: '1:1 with Dana',
      startAt: originalStart,
      attendees: JSON.stringify([{ email: person.email }]),
    });
    const [created] = meetingPrepTasks(db, now, 60);
    expect(created!.dueDate).toBe(originalStart);

    // Meeting moves 30 minutes later; upsertCalendarEvent updates the same row
    // (ON CONFLICT external_id), so start_at changes but the id doesn't.
    const movedStart = '2026-07-13T09:00:00.000Z';
    db.upsertCalendarEvent({
      externalId: 'evt-1',
      title: '1:1 with Dana',
      startAt: movedStart,
      attendees: JSON.stringify([{ email: person.email }]),
    });

    const tasks = meetingPrepTasks(db, now, 90); // wider lead so the moved time still qualifies
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(created!.id);
    expect(tasks[0]!.dueDate).toBe(movedStart);

    const history = db.taskHistory(created!.id);
    expect(history.some((h) => h.field === 'dueDate' && h.newValue === movedStart)).toBe(true);
  });

  it('does not touch dueDate for a done/closed prep task even if the meeting moves', () => {
    const db = new Db(':memory:');
    const person = tier1Person(db);
    const now = '2026-07-13T08:00:00.000Z';
    const originalStart = '2026-07-13T08:30:00.000Z';
    db.upsertCalendarEvent({
      externalId: 'evt-1',
      title: '1:1 with Dana',
      startAt: originalStart,
      attendees: JSON.stringify([{ email: person.email }]),
    });
    const [created] = meetingPrepTasks(db, now, 60);
    db.updateTask(created!.id, { status: 'done', doneAt: now }, 'test');

    const movedStart = '2026-07-13T09:00:00.000Z';
    db.upsertCalendarEvent({
      externalId: 'evt-1',
      title: '1:1 with Dana',
      startAt: movedStart,
      attendees: JSON.stringify([{ email: person.email }]),
    });

    const tasks = meetingPrepTasks(db, now, 90);
    expect(tasks).toHaveLength(0); // closed task is never re-offered as a candidate
    expect(db.getTask(created!.id)!.dueDate).toBe(originalStart); // untouched
  });

  // H9: a recurring series that reuses one externalId must not get exactly
  // one prep task, ever — once the earlier occurrence's task auto-closes
  // (status 'cancelled', see gatherCandidates/closeElapsedMeetingPrepTasks),
  // the next occurrence recycles it rather than staying dead.
  it('reopens a cancelled prep task for a later occurrence reusing the same externalId', () => {
    const db = new Db(':memory:');
    const person = tier1Person(db);
    const now = '2026-07-13T08:00:00.000Z';
    const firstStart = '2026-07-13T08:30:00.000Z';
    db.upsertCalendarEvent({
      externalId: 'evt-recurring',
      title: 'Weekly sync',
      startAt: firstStart,
      attendees: JSON.stringify([{ email: person.email }]),
    });
    const [created] = meetingPrepTasks(db, now, 60);
    expect(created!.surfaceCount).toBe(0);
    db.recordSurface(created!.id, now);
    // auto-close, as closeElapsedMeetingPrepTasks would once the meeting passed
    db.updateTask(created!.id, { status: 'cancelled', snoozeUntil: null }, 'loop');
    expect(db.getTask(created!.id)!.surfaceCount).toBe(1);

    // next week's occurrence, same externalId — calendar_events (unique on
    // external_id) now reflects the new occurrence's start time
    const nextStart = '2026-07-20T08:30:00.000Z';
    db.upsertCalendarEvent({
      externalId: 'evt-recurring',
      title: 'Weekly sync',
      startAt: nextStart,
      attendees: JSON.stringify([{ email: person.email }]),
    });

    const tasks = meetingPrepTasks(db, nextStart, 60);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(created!.id); // same row recycled, not a new one
    expect(tasks[0]!.status).toBe('open');
    expect(tasks[0]!.dueDate).toBe(nextStart);
    expect(tasks[0]!.description).toContain(formatLocalIsoWithOffset(nextStart, defaultTimeZone()));
    // surfacing history reset — the previous occurrence's notify shouldn't
    // gate/cooldown the new one
    expect(tasks[0]!.surfaceCount).toBe(0);
    expect(tasks[0]!.lastSurfacedAt).toBeNull();
  });
});

describe('gatherCandidates — SNOOZE_EXPIRED (H3)', () => {
  it('tags a task whose snooze just expired, even though it was already surfaced', () => {
    const db = new Db(':memory:');
    const now = '2026-07-04T00:00:00.000Z';
    const t = db.insertTask({ description: 'follow up next week', source: 'manual' })!;
    db.recordSurface(t.id, '2026-06-20T00:00:00.000Z'); // already surfaced once, long ago
    db.updateTask(t.id, { status: 'snoozed', snoozeUntil: '2026-07-01T00:00:00Z' }, 'user');
    db.unsnoozeDue(now, 'loop');

    const found = gatherCandidates(db, now);
    expect(found.map((c) => c.id)).toContain(t.id);
    expect(found.find((c) => c.id === t.id)!.reminderReason).toBe('SNOOZE_EXPIRED');
  });

  it('SNOOZE_EXPIRED takes precedence over a task that also matches DUE_SOON', () => {
    const db = new Db(':memory:');
    const now = '2026-07-04T00:00:00.000Z';
    const t = db.insertTask({
      description: 'due tomorrow',
      source: 'manual',
      dueDate: '2026-07-05T00:00:00.000Z',
    })!;
    db.recordSurface(t.id, '2026-06-20T00:00:00.000Z');
    db.updateTask(t.id, { status: 'snoozed', snoozeUntil: '2026-07-01T00:00:00Z' }, 'user');
    db.unsnoozeDue(now, 'loop');

    const found = gatherCandidates(db, now);
    expect(found.find((c) => c.id === t.id)!.reminderReason).toBe('SNOOZE_EXPIRED');
  });
});

describe('gatherCandidates — meeting-prep auto-close (H9)', () => {
  it('closes (cancels) a prep task once its meeting is past the grace period, and it stops being DUE_SOON forever', () => {
    const db = new Db(':memory:');
    const person = tier1Person(db);
    const meetingStart = '2026-07-13T08:30:00.000Z';
    db.upsertCalendarEvent({
      externalId: 'evt-1',
      title: '1:1 with Dana',
      startAt: meetingStart,
      attendees: JSON.stringify([{ email: person.email }]),
    });
    const created = meetingPrepTasks(db, '2026-07-13T08:00:00.000Z', 60)[0]!;

    // 3 days after the meeting — without the fix this is still trivially
    // "due soon" (a past dueDate) and reappears via DUE_SOON every tick.
    const threeDaysLater = '2026-07-16T08:30:00.000Z';
    const found = gatherCandidates(db, threeDaysLater);
    expect(found.map((c) => c.id)).not.toContain(created.id);
    expect(db.getTask(created.id)!.status).toBe('cancelled');
  });

  it('does not close a prep task still within the grace window after its meeting started', () => {
    const db = new Db(':memory:');
    const person = tier1Person(db);
    const meetingStart = '2026-07-13T08:30:00.000Z';
    db.upsertCalendarEvent({
      externalId: 'evt-1',
      title: '1:1 with Dana',
      startAt: meetingStart,
      attendees: JSON.stringify([{ email: person.email }]),
    });
    const created = meetingPrepTasks(db, '2026-07-13T08:00:00.000Z', 60)[0]!;

    const tenMinLater = '2026-07-13T08:40:00.000Z'; // within the 30-min grace
    gatherCandidates(db, tenMinLater);
    expect(db.getTask(created.id)!.status).toBe('open');
  });

  // Loop MEDIUM finding (2026-08-21 report): a meeting-prep task's dueDate is
  // the meeting's startAt, which by construction falls inside dueSoonDays —
  // so db.dueSoon() also matches it from the tick AFTER it's created. Before
  // the fix, gatherCandidates tagged DUE_SOON before MEETING_PREP, so the
  // reason flipped on the second (and every later) tick even though nothing
  // about the candidate changed.
  it('keeps reminderReason MEETING_PREP (not DUE_SOON) on a second tick', () => {
    const db = new Db(':memory:');
    const person = tier1Person(db);
    const now = '2026-07-13T08:00:00.000Z';
    const startAt = '2026-07-13T08:30:00.000Z'; // 30 min out — also inside dueSoonDays
    db.upsertCalendarEvent({
      externalId: 'evt-1',
      title: '1:1 with Dana',
      startAt,
      attendees: JSON.stringify([{ email: person.email }]),
    });

    const first = gatherCandidates(db, now, {
      dueSoonDays: 2,
      neverSurfacedMinAgeHours: 4,
      staleAfterDays: 5,
      meetingPrepLeadMin: 60,
    });
    expect(first.map((c) => c.reminderReason)).toEqual(['MEETING_PREP']);

    // Second tick, a few minutes later — the prep task now already exists in
    // the DB with a dueDate well inside dueSoonDays, so db.dueSoon() would
    // also return it.
    const secondTickNow = '2026-07-13T08:05:00.000Z';
    const second = gatherCandidates(db, secondTickNow, {
      dueSoonDays: 2,
      neverSurfacedMinAgeHours: 4,
      staleAfterDays: 5,
      meetingPrepLeadMin: 60,
    });
    expect(second.map((c) => c.reminderReason)).toEqual(['MEETING_PREP']);
  });
});

// Loop LOW finding (2026-08-21 report): TESTING.md claims aged tasks "also
// carry STALE", but gatherCandidates' documented precedence order
// (SNOOZE_EXPIRED / MEETING_PREP / DUE_SOON / NEVER_SURFACED / STALE) keeps
// NEVER_SURFACED for a task that matches both — this test pins that as the
// correct, intended behavior (db.staleTasks doesn't require surface_count>0,
// see db/index.ts, so an old never-surfaced task legitimately matches both).
describe('gatherCandidates — NEVER_SURFACED precedence over STALE', () => {
  it('tags a never-surfaced, long-untouched task NEVER_SURFACED, not STALE', () => {
    const db = new Db(':memory:');
    const now = '2026-07-08T12:00:00.000Z';
    const task = db.insertTask({ description: 'old and untouched', source: 'manual' })!;
    const oldTimestamp = new Date(Date.parse(now) - 10 * 86_400_000).toISOString(); // 10 days ago
    db.raw
      .prepare('UPDATE tasks SET created_at=?, updated_at=?, surface_count=0 WHERE id=?')
      .run(oldTimestamp, oldTimestamp, task.id);

    const found = gatherCandidates(db, now, {
      dueSoonDays: 2,
      neverSurfacedMinAgeHours: 4,
      staleAfterDays: 5,
      meetingPrepLeadMin: 60,
    });
    expect(found.map((c) => c.id)).toEqual([task.id]);
    expect(found[0]!.reminderReason).toBe('NEVER_SURFACED');
  });
});
