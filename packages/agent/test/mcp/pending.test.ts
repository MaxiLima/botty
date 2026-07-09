import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { createBus } from '../../src/bus/index.js';
import { Db, nowIso } from '../../src/db/index.js';
import { createMcpConnections } from '../../src/mcp/connections.js';
import { createPendingActionQueue, PENDING_ACTIONS_CAP } from '../../src/mcp/pending.js';
import { createFixtureMcpServer } from './fixture.js';

function setup() {
  const db = new Db(':memory:');
  const bus = createBus();
  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));
  const fixture = createFixtureMcpServer('demo');
  const connections = createMcpConnections({
    getConfig: () => ({ servers: { demo: { type: 'stdio', command: 'node', args: [], env: {}, tools: {} } } }),
    transportFactory: fixture.transportFactory,
  });
  const queue = createPendingActionQueue({ db, bus, connections });
  return {
    db,
    bus,
    events,
    fixture,
    connections,
    queue,
    async cleanup() {
      await connections.closeAll();
      await fixture.close();
    },
  };
}

describe('PendingActionQueue — enqueue', () => {
  it('inserts a pending row and broadcasts action.pending', async () => {
    const h = setup();
    try {
      const outcome = h.queue.enqueue({ server: 'demo', tool: 'send', args: { to: 'ana', text: 'hi' }, summary: 'demo.send(to=ana)' });
      expect('action' in outcome).toBe(true);
      const action = (outcome as { action: { id: string; status: string } }).action;
      expect(action.status).toBe('pending');
      expect(h.events.some((e) => e.type === 'action.pending' && e.payload.action.id === action.id)).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it('dedups an identical (server, tool, args) call onto the existing pending row', async () => {
    const h = setup();
    try {
      const first = h.queue.enqueue({ server: 'demo', tool: 'send', args: { to: 'ana' }, summary: 's' });
      const second = h.queue.enqueue({ server: 'demo', tool: 'send', args: { to: 'ana' }, summary: 's' });
      expect('action' in first && 'action' in second).toBe(true);
      expect((first as { action: { id: string } }).action.id).toBe((second as { action: { id: string } }).action.id);
      expect(h.db.listPendingActions('pending')).toHaveLength(1);
      // Only one action.pending broadcast — the dedup hit never re-inserts.
      expect(h.events.filter((e) => e.type === 'action.pending')).toHaveLength(1);
    } finally {
      await h.cleanup();
    }
  });

  it('rejects a new call once the queue is at PENDING_ACTIONS_CAP', async () => {
    const h = setup();
    try {
      for (let i = 0; i < PENDING_ACTIONS_CAP; i++) {
        const outcome = h.queue.enqueue({ server: 'demo', tool: 'send', args: { to: `p${i}` }, summary: `s${i}` });
        expect('action' in outcome).toBe(true);
      }
      const overflow = h.queue.enqueue({ server: 'demo', tool: 'send', args: { to: 'overflow' }, summary: 'overflow' });
      expect(overflow).toEqual({ error: 'approval queue full — ask the user to review pending actions' });
      expect(h.db.listPendingActions('pending')).toHaveLength(PENDING_ACTIONS_CAP);
    } finally {
      await h.cleanup();
    }
  });
});

describe('PendingActionQueue — approve/dismiss', () => {
  it('approve executes the tool via the fixture and stores the result as executed', async () => {
    const h = setup();
    try {
      const outcome = h.queue.enqueue({ server: 'demo', tool: 'send', args: { to: 'ana', text: 'hi' }, summary: 's' });
      const id = (outcome as { action: { id: string } }).action.id;

      const resolved = await h.queue.approve(id);
      expect(resolved.kind).toBe('ok');
      if (resolved.kind !== 'ok') throw new Error('unreachable');
      expect(resolved.action.status).toBe('executed');
      expect(resolved.action.resultJson).toContain('sent to ana');
      expect(h.fixture.calls).toEqual([{ tool: 'send', args: { to: 'ana', text: 'hi' } }]);
      expect(
        h.events.some(
          (e) => e.type === 'action.resolved' && e.payload.action.id === id && e.payload.action.status === 'executed',
        ),
      ).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it('approve on a failing tool resolves to failed with the error captured', async () => {
    const h = setup();
    try {
      const outcome = h.queue.enqueue({ server: 'demo', tool: 'fail', args: {}, summary: 'demo.fail' });
      const id = (outcome as { action: { id: string } }).action.id;

      const resolved = await h.queue.approve(id);
      expect(resolved.kind).toBe('ok');
      if (resolved.kind !== 'ok') throw new Error('unreachable');
      expect(resolved.action.status).toBe('failed');
      expect(resolved.action.resultJson).toContain('boom: intentional failure');
    } finally {
      await h.cleanup();
    }
  });

  it('dismiss flips a pending row to dismissed and broadcasts action.resolved', async () => {
    const h = setup();
    try {
      const outcome = h.queue.enqueue({ server: 'demo', tool: 'send', args: { to: 'x' }, summary: 's' });
      const id = (outcome as { action: { id: string } }).action.id;

      const resolved = h.queue.dismiss(id);
      expect(resolved.kind).toBe('ok');
      if (resolved.kind !== 'ok') throw new Error('unreachable');
      expect(resolved.action.status).toBe('dismissed');
      expect(h.fixture.calls).toHaveLength(0); // dismiss never calls the tool
      expect(
        h.events.some(
          (e) => e.type === 'action.resolved' && e.payload.action.id === id && e.payload.action.status === 'dismissed',
        ),
      ).toBe(true);
    } finally {
      await h.cleanup();
    }
  });

  it('approve on an unknown id → not_found', async () => {
    const h = setup();
    try {
      expect(await h.queue.approve('nope')).toEqual({ kind: 'not_found' });
      expect(h.queue.dismiss('nope')).toEqual({ kind: 'not_found' });
    } finally {
      await h.cleanup();
    }
  });

  it('approve/dismiss on an already-resolved action → not_pending', async () => {
    const h = setup();
    try {
      const outcome = h.queue.enqueue({ server: 'demo', tool: 'send', args: { to: 'x' }, summary: 's' });
      const id = (outcome as { action: { id: string } }).action.id;
      h.queue.dismiss(id);

      const reapprove = await h.queue.approve(id);
      expect(reapprove.kind).toBe('not_pending');
      const redismiss = h.queue.dismiss(id);
      expect(redismiss.kind).toBe('not_pending');
    } finally {
      await h.cleanup();
    }
  });
});

describe('PendingActionQueue — lazy expiry', () => {
  it('list()/get()/approve() flip pending rows older than 24h to expired and broadcast action.resolved', async () => {
    const h = setup();
    try {
      const outcome = h.queue.enqueue({ server: 'demo', tool: 'send', args: { to: 'x' }, summary: 's' });
      const id = (outcome as { action: { id: string } }).action.id;

      // Backdate created_at past the 24h TTL directly (no time-travel needed).
      const old = new Date(Date.parse(nowIso()) - 25 * 60 * 60 * 1000).toISOString();
      h.db.raw.prepare('UPDATE pending_actions SET created_at=? WHERE id=?').run(old, id);

      const listed = h.queue.list('pending');
      expect(listed.find((a) => a.id === id)).toBeUndefined();

      const got = h.queue.get(id);
      expect(got?.status).toBe('expired');
      expect(
        h.events.some(
          (e) => e.type === 'action.resolved' && e.payload.action.id === id && e.payload.action.status === 'expired',
        ),
      ).toBe(true);
      expect(h.fixture.calls).toHaveLength(0); // expiry never calls the tool
    } finally {
      await h.cleanup();
    }
  });

  it('approve() on an expired action returns not_pending, never calls the tool', async () => {
    const h = setup();
    try {
      const outcome = h.queue.enqueue({ server: 'demo', tool: 'send', args: { to: 'x' }, summary: 's' });
      const id = (outcome as { action: { id: string } }).action.id;
      const old = new Date(Date.parse(nowIso()) - 25 * 60 * 60 * 1000).toISOString();
      h.db.raw.prepare('UPDATE pending_actions SET created_at=? WHERE id=?').run(old, id);

      const resolved = await h.queue.approve(id);
      expect(resolved.kind).toBe('not_pending');
      if (resolved.kind !== 'not_pending') throw new Error('unreachable');
      expect(resolved.action.status).toBe('expired');
      expect(h.fixture.calls).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });
});
