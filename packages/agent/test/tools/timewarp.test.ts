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
