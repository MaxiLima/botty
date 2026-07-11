import { nanoid } from 'nanoid';
import { describe, expect, it } from 'vitest';
import { Db } from '../../src/db/index.js';
import { applyTimewarp } from '../../src/tools/timewarp.js';

/**
 * Regression for the bug where timewarp rewrote every timestamp column with
 * `strftime('%Y-%m-%dT%H:%M:%SZ', datetime(col, ?))`: it stripped millisecond
 * precision from every datetime value, and turned date-only `due_date` values
 * (e.g. "2026-07-10") into full datetimes (e.g. "2026-07-10T00:00:00Z"),
 * skewing DUE_SOON-style downstream comparisons and display text.
 */
describe('applyTimewarp — preserves each timestamp value\'s original shape', () => {
  it('shifts a date-only due_date and keeps it date-only', () => {
    const db = new Db(':memory:');
    const task = db.insertTask({ description: 'Renew the lease', source: 'manual', dueDate: '2026-07-10' })!;

    applyTimewarp(db.raw, 6);

    const row = db.raw.prepare('SELECT due_date FROM tasks WHERE id=?').get(task.id) as { due_date: string };
    expect(row.due_date).toBe('2026-07-09');
    expect(row.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shifts a millisecond-precision due_date and keeps the milliseconds', () => {
    const db = new Db(':memory:');
    const task = db.insertTask({
      description: 'Prep for meeting',
      source: 'gcal',
      dueDate: '2026-07-10T09:30:00.000Z',
    })!;

    applyTimewarp(db.raw, 6);

    const row = db.raw.prepare('SELECT due_date FROM tasks WHERE id=?').get(task.id) as { due_date: string };
    expect(row.due_date).toBe('2026-07-10T03:30:00.000Z');
    expect(row.due_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('preserves millisecond precision on nowIso()-written columns (created_at etc.)', () => {
    const db = new Db(':memory:');
    const task = db.insertTask({ description: 'Anything', source: 'manual' })!;
    const before = db.raw.prepare('SELECT created_at FROM tasks WHERE id=?').get(task.id) as { created_at: string };
    expect(before.created_at).toMatch(/\.\d{3}Z$/); // sanity: nowIso() always writes ms

    applyTimewarp(db.raw, 6);

    const after = db.raw.prepare('SELECT created_at FROM tasks WHERE id=?').get(task.id) as { created_at: string };
    expect(after.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(before.created_at) - Date.parse(after.created_at)).toBe(6 * 3_600_000);
  });

  it('keeps a whole-second (no-ms) datetime value whole-second after the shift', () => {
    const db = new Db(':memory:');
    const id = nanoid();
    db.raw
      .prepare(
        'INSERT INTO source_check_log (id, source, checked_at, events_fetched, events_new) VALUES (?, ?, ?, 0, 0)',
      )
      .run(id, 'gmail', '2026-07-09T10:00:00Z');

    applyTimewarp(db.raw, 6);

    const row = db.raw.prepare('SELECT checked_at FROM source_check_log WHERE id=?').get(id) as {
      checked_at: string;
    };
    expect(row.checked_at).toBe('2026-07-09T04:00:00Z');
    expect(row.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('leaves null due_date alone and reports the total rows touched', () => {
    const db = new Db(':memory:');
    db.insertTask({ description: 'No due date', source: 'manual' });
    const total = applyTimewarp(db.raw, 6);
    expect(total).toBeGreaterThan(0); // at least created_at/updated_at shifted
  });
});

// L7: the SHIFTS table map predates migrations 004 (commitments) and 005
// (pending_actions) — without these, timewarping the DB never ages the
// short-lived commitment due dates or the 24h pending-action expiry, so
// time-gated tests of those features (loop/commitments.ts, mcp/pending.ts)
// couldn't actually exercise their aging behavior via timewarp.
describe('applyTimewarp — migrations 004/005 tables', () => {
  it('shifts commitments.due_at/created_at/delivered_at', () => {
    const db = new Db(':memory:');
    db.raw
      .prepare(
        `INSERT INTO commitments (id, description, due_at, source_turn_id, created_at, status, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'c1',
        'interview follow-up',
        '2026-07-10T09:00:00.000Z',
        null,
        '2026-07-09T09:00:00.000Z',
        'delivered',
        '2026-07-09T10:00:00.000Z',
      );

    applyTimewarp(db.raw, 6);

    const row = db.raw.prepare('SELECT due_at, created_at, delivered_at FROM commitments WHERE id=?').get('c1') as {
      due_at: string;
      created_at: string;
      delivered_at: string;
    };
    expect(row.due_at).toBe('2026-07-10T03:00:00.000Z');
    expect(row.created_at).toBe('2026-07-09T03:00:00.000Z');
    expect(row.delivered_at).toBe('2026-07-09T04:00:00.000Z');
  });

  it('shifts pending_actions.created_at/resolved_at', () => {
    const db = new Db(':memory:');
    db.raw
      .prepare(
        `INSERT INTO pending_actions (id, server, tool, args_json, summary, status, created_at, resolved_at, result_json, source_turn_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'pa1',
        'gmail',
        'send_email',
        '{}',
        'send an email',
        'approved',
        '2026-07-09T09:00:00.000Z',
        '2026-07-09T09:05:00.000Z',
        null,
        null,
      );

    applyTimewarp(db.raw, 6);

    const row = db.raw.prepare('SELECT created_at, resolved_at FROM pending_actions WHERE id=?').get('pa1') as {
      created_at: string;
      resolved_at: string;
    };
    expect(row.created_at).toBe('2026-07-09T03:00:00.000Z');
    expect(row.resolved_at).toBe('2026-07-09T03:05:00.000Z');
  });

  it('a still-pending action (resolved_at NULL) is left alone on that column, created_at still shifts', () => {
    const db = new Db(':memory:');
    db.raw
      .prepare(
        `INSERT INTO pending_actions (id, server, tool, args_json, summary, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('pa2', 'gmail', 'send_email', '{}', 'send an email', 'pending', '2026-07-09T09:00:00.000Z');

    applyTimewarp(db.raw, 6);

    const row = db.raw.prepare('SELECT created_at, resolved_at FROM pending_actions WHERE id=?').get('pa2') as {
      created_at: string;
      resolved_at: string | null;
    };
    expect(row.created_at).toBe('2026-07-09T03:00:00.000Z');
    expect(row.resolved_at).toBeNull();
  });
});

// L4: SHIFTS only reaches plain DB columns — settings.value is an opaque JSON
// blob, so the ISO timestamps botty stashes inside heartbeat.checklistState
// and ingest.lastCheck.<source> were never aging with a timewarp, silently
// leaving checklist items looking freshly-run and ingest watermarks unmoved.
describe('applyTimewarp — settings-stored ISO timestamps', () => {
  it('shifts every lastRunAt inside heartbeat.checklistState', () => {
    const db = new Db(':memory:');
    db.setSetting('heartbeat.checklistState', {
      'end-of-day-recap': '2026-07-09T18:00:00.000Z',
      'morning-standup-check': '2026-07-09T09:00:00.000Z',
    });

    applyTimewarp(db.raw, 6);

    const state = db.getSetting<Record<string, string>>('heartbeat.checklistState');
    expect(state).toEqual({
      'end-of-day-recap': '2026-07-09T12:00:00.000Z',
      'morning-standup-check': '2026-07-09T03:00:00.000Z',
    });
  });

  it('shifts ingest.lastCheck.<source> watermarks', () => {
    const db = new Db(':memory:');
    db.setSetting('ingest.lastCheck.slack', '2026-07-09T09:00:00.000Z');
    db.setSetting('ingest.lastCheck.gmail', '2026-07-09T09:30:00.000Z');

    applyTimewarp(db.raw, 6);

    expect(db.getSetting<string>('ingest.lastCheck.slack')).toBe('2026-07-09T03:00:00.000Z');
    expect(db.getSetting<string>('ingest.lastCheck.gmail')).toBe('2026-07-09T03:30:00.000Z');
  });

  it('leaves unrelated settings keys untouched', () => {
    const db = new Db(':memory:');
    db.setSetting('some.other.key', { unrelated: true });
    applyTimewarp(db.raw, 6);
    expect(db.getSetting('some.other.key')).toEqual({ unrelated: true });
  });

  it('counts shifted settings rows in the returned total', () => {
    const db = new Db(':memory:');
    db.setSetting('heartbeat.checklistState', { a: '2026-07-09T09:00:00.000Z' });
    db.setSetting('ingest.lastCheck.slack', '2026-07-09T09:00:00.000Z');
    const total = applyTimewarp(db.raw, 6);
    expect(total).toBe(2); // no other rows in this DB to shift
  });
});
