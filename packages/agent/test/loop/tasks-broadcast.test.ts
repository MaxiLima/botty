import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { executeActions, type ActionDeps } from '../../src/loop/actions.js';
import { createSweepState, runResolutionSweep } from '../../src/loop/resolution-sweep.js';
import { parseHeartbeat } from '../../src/config/parse.js';
import { processEvent } from '../../src/ingest/funnel.js';
import { makeEvent, makeHarness } from '../ingest/helpers.js';

/**
 * Regression coverage for the `tasks.updated` snapshot-vs-delta contract
 * (docs comment on WsEventSchema in shared/src/api.ts): every sender must
 * broadcast the FULL open board, never just the touched task(s) — otherwise
 * a client deriving an open-task count/badge straight from the payload
 * (packages/web/src/lib/stores.ts, packages/tui/src/App.tsx) undercounts
 * until the next REST refetch.
 */

const NOW = '2026-07-03T10:00:00.000Z';

function lastTasksUpdated(broadcasts: WsEvent[]): { tasks: { id: string }[] } {
  const evt = [...broadcasts].reverse().find((e) => e.type === 'tasks.updated');
  if (!evt || evt.type !== 'tasks.updated') throw new Error('no tasks.updated broadcast');
  return evt.payload;
}

describe('tasks.updated is always a full-board snapshot', () => {
  it('executeActions broadcasts every open task, not just the one it touched', () => {
    const h = makeHarness();
    const deps: ActionDeps = { db: h.db, bus: h.bus, macNotifier: () => {} };
    const broadcasts: WsEvent[] = [];
    h.bus.onBroadcast((e) => broadcasts.push(e));

    const touched = h.db.insertTask({ description: 'snooze me', source: 'manual' }, 'test')!;
    const untouched = h.db.insertTask({ description: 'leave me open', source: 'manual' }, 'test')!;

    executeActions(
      deps,
      [{ type: 'snooze', taskId: touched.id, score: 5, snoozeDays: 2, reasoning: 'r' }],
      { now: NOW, trigger: 'schedule' },
    );

    const payload = lastTasksUpdated(broadcasts);
    const ids = payload.tasks.map((t) => t.id);
    // The touched task itself just left 'open' (now snoozed), but the untouched
    // task must still be present so a badge computed from this payload alone
    // (filter status==='open') stays accurate.
    expect(ids).toContain(untouched.id);
  });

  it('runResolutionSweep broadcasts every open task, not just the one it auto-closed', async () => {
    const h = makeHarness();
    const hb = parseHeartbeat('', 'sim');

    // Task A: gets an outbound "review done" reply so the sweep closes it.
    const askA = makeEvent({
      actor: { handle: '@marian' },
      text: 'can you review PR 42?',
      threadRef: 'T-A',
      occurredAt: '2026-07-03T10:00:00.000Z',
    });
    expect(await processEvent(h.ctx, askA)).toBe('EXTRACTED');
    const taskA = h.db.listTasks('open').find((t) => t.sourceRef === 'T-A')!;
    await processEvent(
      h.ctx,
      makeEvent({
        direction: 'outbound',
        actor: { displayName: 'me' },
        text: 'review done ✅',
        threadRef: 'T-A',
        occurredAt: '2026-07-03T11:00:00.000Z',
      }),
    );

    // Task B: unrelated open task with no evidence — must stay open and must
    // still show up in the broadcast that follows task A's auto-close.
    const taskB = h.db.insertTask({ description: 'send the invoice', source: 'manual' }, 'test')!;

    const broadcasts: WsEvent[] = [];
    h.bus.onBroadcast((e) => broadcasts.push(e));

    const result = await runResolutionSweep(
      { db: h.db, bus: h.bus, llm: h.llm, config: { heartbeat: () => hb } },
      { state: createSweepState(), trigger: 'sweep-now', now: '2026-07-03T12:00:00.000Z' },
    );

    expect(result.closed.map((c) => c.taskId)).toEqual([taskA.id]);
    expect(h.db.getTask(taskA.id)!.status).toBe('done');

    const payload = lastTasksUpdated(broadcasts);
    const ids = payload.tasks.map((t) => t.id);
    expect(ids).toContain(taskB.id);
  });
});
