import { describe, expect, it, vi } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { createBus } from '../../src/bus/index.js';
import { Db } from '../../src/db/index.js';
import { COMMITMENT_STALE_GRACE_HOURS } from '../../src/loop/commitments.js';
import { createReminderScheduler, reminderMessage } from '../../src/loop/reminders.js';

/**
 * Explicit reminders (set_reminder tool → kind='explicit' commitments): delivered
 * exactly at due_at by the scheduler's scan, bypassing tick judgment and its
 * min-age / max-per-day / working-hours gates. Inferred commitments stay the
 * tick's job (loop/commitments.ts) — the scan must never touch them.
 */

const NOW = '2026-08-15T17:00:00.000Z';
const TZ = 'America/Argentina/Buenos_Aires';

function setup() {
  const db = new Db(':memory:');
  const bus = createBus();
  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));
  const mac = vi.fn();
  const scheduler = createReminderScheduler({ db, bus, macNotifier: mac, timeZone: TZ });
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

  // ---- H10b: downtime (2026-08-21 report) ----

  it('expires a reminder overdue past the grace period INSTEAD of firing it — boot scan included', () => {
    const { db, events, mac, scheduler } = setup();
    const threeDaysAgo = new Date(Date.parse(NOW) - 3 * 86_400_000).toISOString();
    const stale = db.insertCommitment({
      description: 'check the PR (set 3 days ago, "in 2 minutes")',
      dueAt: threeDaysAgo,
      kind: 'explicit',
    });

    // the boot pass: start() runs scan() immediately off the system clock
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    scheduler.start();
    scheduler.stop();
    vi.useRealTimers();

    expect(db.getCommitment(stale.id)?.status).toBe('expired');
    expect(db.getCommitment(stale.id)?.deliveredAt).toBeNull();
    expect(events.some((e) => e.type === 'notification')).toBe(false);
    expect(mac).not.toHaveBeenCalled();
    expect(COMMITMENT_STALE_GRACE_HOURS).toBe(24);
  });

  it('the scan sweep never touches inferred commitments — those are the tick\'s (weekend survival)', () => {
    const { db, scheduler } = setup();
    const inferred = db.insertCommitment({
      description: 'weekend follow-up, due long ago, still the tick\'s to judge',
      dueAt: new Date(Date.parse(NOW) - 3 * 86_400_000).toISOString(),
    });
    expect(scheduler.scan(NOW)).toBe(0);
    expect(db.getCommitment(inferred.id)?.status).toBe('open');
  });

  it('a reminder still inside the grace period delivers, and says how late it is (local time)', () => {
    const { db, events, mac, scheduler } = setup();
    // due 2026-08-14T21:07Z = Fri 18:07 local (UTC-3), ~20h before NOW
    const c = db.insertCommitment({
      description: 'call the vet',
      dueAt: '2026-08-14T21:07:00.000Z',
      kind: 'explicit',
    });

    expect(scheduler.scan(NOW)).toBe(1);
    expect(db.getCommitment(c.id)?.status).toBe('delivered');
    const notif = events.find((e) => e.type === 'notification');
    expect(notif?.payload).toMatchObject({
      kind: 'reminder',
      message: 'Reminder: call the vet (was due Fri 18:07)',
    });
    expect(mac).toHaveBeenCalledWith('botty', 'Reminder: call the vet (was due Fri 18:07)');
  });

  it('reminderMessage: bare when on time or trivially late, hinted past 5 min', () => {
    const due = '2026-08-15T16:58:00.000Z';
    expect(reminderMessage('x', due, '2026-08-15T16:58:03.000Z', TZ)).toBe('Reminder: x');
    expect(reminderMessage('x', due, '2026-08-15T17:02:00.000Z', TZ)).toBe('Reminder: x');
    expect(reminderMessage('x', due, '2026-08-15T17:20:00.000Z', TZ)).toBe(
      'Reminder: x (was due Sat 13:58)',
    );
  });

  // ---- dedup (LOW: a retried set_reminder tool call created two) ----

  it('an identical explicit reminder inside the dedup window is idempotent', () => {
    const { db, scheduler } = setup();
    const first = db.insertCommitment({
      description: 'Review  the PR ',
      dueAt: '2026-08-15T16:58:00.000Z',
      kind: 'explicit',
    });
    const retry = db.insertCommitment({
      description: 'review the pr',
      dueAt: '2026-08-15T16:58:00.000Z',
      kind: 'explicit',
    });
    expect(retry.id).toBe(first.id);
    expect(db.listCommitments()).toHaveLength(1);
    expect(scheduler.scan(NOW)).toBe(1); // one banner, not two
  });

  it('dedup is scoped: a different due_at, a stale window, and inferred commitments all insert', () => {
    const db = new Db(':memory:');
    const base = { description: 'ping Ana', dueAt: '2026-08-15T16:58:00.000Z' } as const;
    const a = db.insertCommitment({ ...base, kind: 'explicit' }, NOW);
    const differentTime = db.insertCommitment(
      { ...base, dueAt: '2026-08-15T17:58:00.000Z', kind: 'explicit' },
      NOW,
    );
    // same text + time, but 30 min later — a deliberate re-set, not a retry
    const later = db.insertCommitment({ ...base, kind: 'explicit' }, '2026-08-15T17:30:00.000Z');
    const inferred1 = db.insertCommitment(base, NOW);
    const inferred2 = db.insertCommitment(base, NOW);
    expect(new Set([a.id, differentTime.id, later.id, inferred1.id, inferred2.id]).size).toBe(5);
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
