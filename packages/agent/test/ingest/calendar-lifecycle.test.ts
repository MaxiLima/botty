import { describe, expect, it } from 'vitest';
import { handleGcal } from '../../src/ingest/structured.js';
import { makeEvent, makeHarness, outcomeInRawLog } from './helpers.js';

/**
 * H9 (2026-08-21 investigation): a cancelled/deleted gcal event must not
 * become or remain a live meeting-prep candidate. `handleGcal` used to
 * unconditionally upsert into `calendar_events` regardless of `meta.status`,
 * so a cancelled event still nudged the user and its meeting-prep task, once
 * created, never closed.
 *
 * Tested directly against `handleGcal` (not through `ingest/funnel.ts`,
 * concurrently owned by another agent) — gcal is structured-source-only and
 * never touches the funnel's classify/extract path anyway.
 */

const MEETING_PREP_REF = (externalId: string) => `meeting_prep:${externalId}`;

describe('handleGcal — cancelled events (H9)', () => {
  it('does not upsert calendar_events for a cancelled event with no prior prep task', async () => {
    const h = makeHarness();
    const event = makeEvent({
      source: 'gcal',
      kind: 'event',
      externalId: 'cal-cancel-1',
      actor: {},
      text: 'Cancelled sync',
      meta: { startAt: new Date(Date.now() + 30 * 60_000).toISOString(), status: 'cancelled' },
    });

    expect(handleGcal(h.ctx, event)).toBe('UPSERTED');
    expect(h.db.eventsStartingBetween('0000', '9999')).toEqual([]);
    expect(outcomeInRawLog(h.db, 'cal-cancel-1')).toBe('UPSERTED');
  });

  it('removes a previously-cached (now cancelled) event from calendar_events', () => {
    const h = makeHarness();
    const externalId = 'cal-cancel-2';
    const startAt = new Date(Date.now() + 30 * 60_000).toISOString();

    handleGcal(
      h.ctx,
      makeEvent({ source: 'gcal', externalId, actor: {}, text: 'Sync', meta: { startAt } }),
    );
    expect(h.db.eventsStartingBetween('0000', '9999')).toHaveLength(1);

    handleGcal(
      h.ctx,
      makeEvent({
        source: 'gcal',
        externalId,
        actor: {},
        text: 'Sync',
        meta: { startAt, status: 'cancelled' },
      }),
    );
    expect(h.db.eventsStartingBetween('0000', '9999')).toEqual([]);
  });

  it('cancels an OPEN meeting-prep task already created for the event', () => {
    const h = makeHarness();
    const externalId = 'cal-cancel-3';
    const prep = h.db.insertTask({
      description: 'Prep for meeting "Sync"',
      source: 'gcal',
      sourceRef: MEETING_PREP_REF(externalId),
      dueDate: new Date(Date.now() + 30 * 60_000).toISOString(),
    })!;
    expect(prep.status).toBe('open');

    handleGcal(
      h.ctx,
      makeEvent({
        source: 'gcal',
        externalId,
        actor: {},
        text: 'Sync',
        meta: { startAt: prep.dueDate, status: 'cancelled' },
      }),
    );

    expect(h.db.getTask(prep.id)!.status).toBe('cancelled');
  });

  it('cancels a SNOOZED meeting-prep task already created for the event', () => {
    const h = makeHarness();
    const externalId = 'cal-cancel-4';
    const prep = h.db.insertTask({
      description: 'Prep for meeting "Sync"',
      source: 'gcal',
      sourceRef: MEETING_PREP_REF(externalId),
      dueDate: new Date(Date.now() + 30 * 60_000).toISOString(),
    })!;
    h.db.updateTask(prep.id, { status: 'snoozed', snoozeUntil: '2099-01-01T00:00:00Z' }, 'user');

    handleGcal(
      h.ctx,
      makeEvent({
        source: 'gcal',
        externalId,
        actor: {},
        text: 'Sync',
        meta: { startAt: prep.dueDate, status: 'cancelled' },
      }),
    );

    expect(h.db.getTask(prep.id)!.status).toBe('cancelled');
    expect(h.db.getTask(prep.id)!.snoozeUntil).toBeNull();
  });

  it('leaves an already-DONE meeting-prep task alone (user completed it — not ours to touch)', () => {
    const h = makeHarness();
    const externalId = 'cal-cancel-5';
    const prep = h.db.insertTask({
      description: 'Prep for meeting "Sync"',
      source: 'gcal',
      sourceRef: MEETING_PREP_REF(externalId),
      dueDate: new Date(Date.now() + 30 * 60_000).toISOString(),
    })!;
    h.db.updateTask(prep.id, { status: 'done', doneAt: new Date().toISOString() }, 'user');

    handleGcal(
      h.ctx,
      makeEvent({
        source: 'gcal',
        externalId,
        actor: {},
        text: 'Sync',
        meta: { startAt: prep.dueDate, status: 'cancelled' },
      }),
    );

    expect(h.db.getTask(prep.id)!.status).toBe('done');
  });

  it('a live (non-cancelled) event is unaffected — still upserts normally', () => {
    const h = makeHarness();
    const startAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const event = makeEvent({
      source: 'gcal',
      externalId: 'cal-live-1',
      actor: {},
      text: 'Still on',
      meta: { startAt },
    });
    expect(handleGcal(h.ctx, event)).toBe('UPSERTED');
    expect(h.db.eventsStartingBetween('0000', '9999')).toHaveLength(1);
  });
});

describe('handleGcal — moved (rescheduled) events', () => {
  it('re-arriving with a new startAt/endAt for the SAME external id moves the stored event, not duplicates it', () => {
    const h = makeHarness();
    const externalId = 'cal-move-1';
    const originalStart = new Date(Date.now() + 30 * 60_000).toISOString();
    const movedStart = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const movedEnd = new Date(Date.now() + 4 * 3_600_000).toISOString();

    handleGcal(
      h.ctx,
      makeEvent({ source: 'gcal', externalId, actor: {}, text: 'Sync', meta: { startAt: originalStart } }),
    );
    expect(h.db.eventsStartingBetween('0000', '9999')).toHaveLength(1);
    expect(h.db.eventsStartingBetween('0000', '9999')[0]!.startAt).toBe(originalStart);

    handleGcal(
      h.ctx,
      makeEvent({
        source: 'gcal',
        externalId,
        actor: {},
        text: 'Sync',
        meta: { startAt: movedStart, endAt: movedEnd },
      }),
    );

    const rows = h.db.eventsStartingBetween('0000', '9999');
    expect(rows).toHaveLength(1); // still one row — moved, not duplicated
    expect(rows[0]!.startAt).toBe(movedStart);
    expect(rows[0]!.endAt).toBe(movedEnd);
    // the old slot is empty — nothing left starting around the original time
    expect(h.db.eventsStartingBetween('0000', new Date(Date.parse(originalStart) + 60_000).toISOString())).toEqual(
      [],
    );
  });
});

describe('handleGcal — recurring series (distinct external ids per occurrence)', () => {
  it('each occurrence of a recurring series is its own calendar_events row, keyed by its own external id', () => {
    const h = makeHarness();
    const week1 = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const week2 = new Date(Date.now() + 8 * 24 * 3_600_000).toISOString();

    handleGcal(
      h.ctx,
      makeEvent({
        source: 'gcal',
        externalId: 'series-1_20260825T100000Z',
        actor: {},
        text: 'Weekly standup',
        meta: { startAt: week1 },
      }),
    );
    handleGcal(
      h.ctx,
      makeEvent({
        source: 'gcal',
        externalId: 'series-1_20260901T100000Z',
        actor: {},
        text: 'Weekly standup',
        meta: { startAt: week2 },
      }),
    );

    expect(h.db.eventsStartingBetween('0000', '9999')).toHaveLength(2);
  });

  it('cancelling ONE occurrence leaves the other occurrences of the series untouched', () => {
    const h = makeHarness();
    const week1 = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const week2 = new Date(Date.now() + 8 * 24 * 3_600_000).toISOString();

    handleGcal(
      h.ctx,
      makeEvent({
        source: 'gcal', externalId: 'series-2_occ-1', actor: {}, text: 'Weekly 1:1',
        meta: { startAt: week1 },
      }),
    );
    handleGcal(
      h.ctx,
      makeEvent({
        source: 'gcal', externalId: 'series-2_occ-2', actor: {}, text: 'Weekly 1:1',
        meta: { startAt: week2 },
      }),
    );
    expect(h.db.eventsStartingBetween('0000', '9999')).toHaveLength(2);

    handleGcal(
      h.ctx,
      makeEvent({
        source: 'gcal', externalId: 'series-2_occ-1', actor: {}, text: 'Weekly 1:1',
        meta: { startAt: week1, status: 'cancelled' },
      }),
    );

    const remaining = h.db.eventsStartingBetween('0000', '9999');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.startAt).toBe(week2);
  });
});
