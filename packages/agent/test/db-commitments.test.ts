import { describe, expect, it } from 'vitest';
import { Db } from '../src/db/index.js';

/** Inferred commitments (feature #2) — Db layer: migration 004 + CRUD/query methods. */

describe('Db — commitments', () => {
  it('insertCommitment / getCommitment round-trip with status=open and null deliveredAt', () => {
    const db = new Db(':memory:');
    const c = db.insertCommitment({ description: 'call the plumber back', dueAt: '2026-07-10T15:00:00.000Z' });
    expect(c.status).toBe('open');
    expect(c.deliveredAt).toBeNull();
    expect(c.sourceTurnId).toBeNull();
    expect(db.getCommitment(c.id)).toEqual(c);
    db.close();
  });

  it('insertCommitment persists sourceTurnId when given', () => {
    const db = new Db(':memory:');
    const c = db.insertCommitment({
      description: 'interview follow-up',
      dueAt: '2026-07-10T15:00:00.000Z',
      sourceTurnId: 'turn-1',
    });
    expect(c.sourceTurnId).toBe('turn-1');
    db.close();
  });

  it('dueCommitments returns only open commitments due at or before now, earliest first', () => {
    const db = new Db(':memory:');
    const past = db.insertCommitment({ description: 'past one', dueAt: '2026-07-08T00:00:00.000Z' });
    const future = db.insertCommitment({ description: 'future one', dueAt: '2026-07-20T00:00:00.000Z' });
    const alsoDue = db.insertCommitment({ description: 'also due', dueAt: '2026-07-07T00:00:00.000Z' });
    const now = '2026-07-09T00:00:00.000Z';
    expect(db.dueCommitments(now).map((c) => c.id)).toEqual([alsoDue.id, past.id]);
    expect(db.dueCommitments(now).map((c) => c.id)).not.toContain(future.id);
  });

  it('dueCommitments excludes non-open commitments', () => {
    const db = new Db(':memory:');
    const c = db.insertCommitment({ description: 'x', dueAt: '2026-07-01T00:00:00.000Z' });
    db.markCommitmentDelivered(c.id, '2026-07-09T00:00:00.000Z');
    expect(db.dueCommitments('2026-07-09T01:00:00.000Z')).toEqual([]);
  });

  it('markCommitmentDelivered flips status and stamps deliveredAt', () => {
    const db = new Db(':memory:');
    const c = db.insertCommitment({ description: 'x', dueAt: '2026-07-01T00:00:00.000Z' });
    db.markCommitmentDelivered(c.id, '2026-07-09T12:00:00.000Z');
    const after = db.getCommitment(c.id)!;
    expect(after.status).toBe('delivered');
    expect(after.deliveredAt).toBe('2026-07-09T12:00:00.000Z');
  });

  it('expireStaleCommitments flips open commitments due more than graceHours ago, and only those', () => {
    const db = new Db(':memory:');
    const stale = db.insertCommitment({ description: 'stale', dueAt: '2026-07-08T00:00:00.000Z' }); // 30h ago
    const fresh = db.insertCommitment({ description: 'fresh', dueAt: '2026-07-09T05:00:00.000Z' }); // 1h ago
    const delivered = db.insertCommitment({ description: 'delivered', dueAt: '2026-07-01T00:00:00.000Z' });
    db.markCommitmentDelivered(delivered.id, '2026-07-01T01:00:00.000Z');
    const now = '2026-07-09T06:00:00.000Z';
    const n = db.expireStaleCommitments(now, 24);
    expect(n).toBe(1);
    expect(db.getCommitment(stale.id)!.status).toBe('expired');
    expect(db.getCommitment(fresh.id)!.status).toBe('open');
    expect(db.getCommitment(delivered.id)!.status).toBe('delivered'); // never re-flipped
  });

  it('countCommitmentDeliveriesSince counts only delivered ones on/after the cutoff', () => {
    const db = new Db(':memory:');
    const a = db.insertCommitment({ description: 'a', dueAt: '2026-07-01T00:00:00.000Z' });
    const b = db.insertCommitment({ description: 'b', dueAt: '2026-07-01T00:00:00.000Z' });
    const c = db.insertCommitment({ description: 'c', dueAt: '2026-07-01T00:00:00.000Z' });
    db.markCommitmentDelivered(a.id, '2026-07-08T12:00:00.000Z'); // outside window
    db.markCommitmentDelivered(b.id, '2026-07-09T00:00:00.000Z'); // inside window
    db.markCommitmentDelivered(c.id, '2026-07-09T05:00:00.000Z'); // inside window
    expect(db.countCommitmentDeliveriesSince('2026-07-09T00:00:00.000Z')).toBe(2);
  });

  it('openCommitments lists only open ones, ordered by due_at', () => {
    const db = new Db(':memory:');
    const later = db.insertCommitment({ description: 'later', dueAt: '2026-07-10T00:00:00.000Z' });
    const earlier = db.insertCommitment({ description: 'earlier', dueAt: '2026-07-09T00:00:00.000Z' });
    const delivered = db.insertCommitment({ description: 'delivered', dueAt: '2026-07-08T00:00:00.000Z' });
    db.markCommitmentDelivered(delivered.id);
    expect(db.openCommitments().map((c) => c.id)).toEqual([earlier.id, later.id]);
  });

  it('listCommitments returns newest-first, capped at limit', () => {
    const db = new Db(':memory:');
    for (let i = 0; i < 5; i++) {
      const c = db.insertCommitment({ description: `c${i}`, dueAt: '2026-07-10T00:00:00.000Z' });
      // Explicit, distinct created_at — insertCommitment's own nowIso() calls can
      // collide at millisecond resolution in a tight loop, which would make
      // newest-first ordering non-deterministic.
      db.raw.prepare('UPDATE commitments SET created_at=? WHERE id=?').run(`2026-07-09T00:00:0${i}.000Z`, c.id);
    }
    const list = db.listCommitments(3);
    expect(list).toHaveLength(3);
    // newest-first: last-inserted (highest created_at) comes first
    expect(list[0]!.description).toBe('c4');
  });
});
