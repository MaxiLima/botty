import { describe, expect, it, vi } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { createBus } from '../../src/bus/index.js';
import { Db } from '../../src/db/index.js';
import { createReminderScheduler } from '../../src/loop/reminders.js';

/**
 * Explicit reminders (set_reminder tool → kind='explicit' commitments): delivered
 * exactly at due_at by the scheduler's scan, bypassing tick judgment and its
 * min-age / max-per-day / working-hours gates. Inferred commitments stay the
 * tick's job (loop/commitments.ts) — the scan must never touch them.
 */

const NOW = '2026-08-15T17:00:00.000Z';

function setup() {
  const db = new Db(':memory:');
  const bus = createBus();
  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));
  const mac = vi.fn();
  const scheduler = createReminderScheduler({ db, bus, macNotifier: mac });
  return { db, bus, events, mac, scheduler };
}

describe('reminder scheduler (explicit commitments)', () => {
  it('delivers a due explicit reminder: proactive_log + WS notification + banner + delivered status', () => {
    const { db, events, mac, scheduler } = setup();
    const c = db.insertCommitment({
      description: 'write to Ana about the renewal',
      dueAt: '2026-08-15T16:58:00.000Z',
      kind: 'explicit',
    });

    expect(scheduler.scan(NOW)).toBe(1);

    expect(db.getCommitment(c.id)?.status).toBe('delivered');
    expect(db.getCommitment(c.id)?.deliveredAt).toBe(NOW);

    const notif = events.find((e) => e.type === 'notification');
    expect(notif?.payload).toMatchObject({
      taskId: null,
      kind: 'reminder',
      message: 'Reminder: write to Ana about the renewal',
      score: null,
    });
    expect(mac).toHaveBeenCalledWith('botty', 'Reminder: write to Ana about the renewal');
  });

  it('skips future explicit reminders and ALL inferred commitments, even due ones', () => {
    const { db, events, scheduler } = setup();
    db.insertCommitment({
      description: 'future explicit',
      dueAt: '2026-08-15T17:05:00.000Z',
      kind: 'explicit',
    });
    const inferred = db.insertCommitment({
      description: 'due inferred — tick judgment territory',
      dueAt: '2026-08-15T16:00:00.000Z',
      // kind omitted → 'inferred'
    });

    expect(scheduler.scan(NOW)).toBe(0);
    expect(events.some((e) => e.type === 'notification')).toBe(false);
    expect(db.getCommitment(inferred.id)?.status).toBe('open');
  });

  it('never redelivers: a second scan after delivery finds nothing', () => {
    const { db, scheduler } = setup();
    db.insertCommitment({ description: 'once only', dueAt: '2026-08-15T16:59:00.000Z', kind: 'explicit' });
    expect(scheduler.scan(NOW)).toBe(1);
    expect(scheduler.scan('2026-08-15T17:01:00.000Z')).toBe(0);
  });

  it('a banner failure still marks the reminder delivered (bookkeeping never breaks)', () => {
    const { db, scheduler, mac } = setup();
    mac.mockImplementation(() => {
      throw new Error('no notifier');
    });
    const c = db.insertCommitment({ description: 'x', dueAt: '2026-08-15T16:59:00.000Z', kind: 'explicit' });
    expect(scheduler.scan(NOW)).toBe(1);
    expect(db.getCommitment(c.id)?.status).toBe('delivered');
  });
});
