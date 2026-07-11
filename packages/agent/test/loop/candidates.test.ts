import { describe, expect, it } from 'vitest';
import { Db } from '../../src/db/index.js';
import { meetingPrepTasks } from '../../src/loop/candidates.js';

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
});
