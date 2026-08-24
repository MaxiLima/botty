import { describe, expect, it } from 'vitest';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { executeActions, type ActionDeps } from '../../src/loop/actions.js';

const NOW = '2026-07-03T10:00:00.000Z';

function makeDeps(): ActionDeps {
  return { db: new Db(':memory:'), bus: createBus(), macNotifier: () => {} };
}

describe('executeActions', () => {
  it('skips actions whose task is no longer open (closed while judgment was in flight)', () => {
    const deps = makeDeps();
    const task = deps.db.insertTask({ description: 'review PR', source: 'manual' }, 'test')!;
    deps.db.updateTask(task.id, { status: 'done', doneAt: NOW }, 'user');

    const executed = executeActions(
      deps,
      [
        { type: 'snooze', taskId: task.id, score: 5, snoozeDays: 2, reasoning: 'r' },
        { type: 'notify', taskId: task.id, score: 9, message: 'go', reasoning: 'r' },
      ],
      { now: NOW, trigger: 'schedule' },
    );

    expect(executed).toEqual([]);
    expect(deps.db.getTask(task.id)!.status).toBe('done');
    expect(deps.db.surfacesForTask(task.id)).toEqual([]);
  });

  it('clamps snoozeDays to the promised 1-14 range', () => {
    const deps = makeDeps();
    const task = deps.db.insertTask({ description: 'thing', source: 'manual' }, 'test')!;
    const executed = executeActions(
      deps,
      [{ type: 'snooze', taskId: task.id, score: 5, snoozeDays: 365, reasoning: 'r' }],
      { now: NOW, trigger: 'schedule' },
    );
    expect(executed[0]!.snoozeUntil).toBe(
      new Date(Date.parse(NOW) + 14 * 86_400_000).toISOString(),
    );
  });

  // Defense in depth for the duplicate-action bug (validateJudgment already
  // dedupes upstream — see loop/judgment.test.ts — but executeActions is the
  // only place that actually mutates surface_count, so it guards itself too).
  it('never double-applies two notify actions for the same task', () => {
    const deps = makeDeps();
    const task = deps.db.insertTask({ description: 'thing', source: 'manual' }, 'test')!;
    const executed = executeActions(
      deps,
      [
        { type: 'notify', taskId: task.id, score: 9, message: 'first', reasoning: 'r' },
        { type: 'notify', taskId: task.id, score: 5, message: 'second', reasoning: 'r' },
      ],
      { now: NOW, trigger: 'schedule' },
    );
    expect(executed).toHaveLength(1);
    expect(executed[0]!.message).toBe('first');
    expect(deps.db.getTask(task.id)!.surfaceCount).toBe(1);
    expect(deps.db.surfacesForTask(task.id)).toHaveLength(1);
  });

  it('clamps update_priority to the 1 (HIGH) .. 3 (LOW) task scale', () => {
    const deps = makeDeps();
    const task = deps.db.insertTask({ description: 'thing', source: 'manual' }, 'test')!;
    executeActions(
      deps,
      [{ type: 'update_priority', taskId: task.id, score: 5, priority: 5, reasoning: 'r' }],
      { now: NOW, trigger: 'schedule' },
    );
    expect(deps.db.getTask(task.id)!.priority).toBe(3);

    executeActions(
      deps,
      [{ type: 'update_priority', taskId: task.id, score: 5, priority: 0, reasoning: 'r' }],
      { now: NOW, trigger: 'schedule' },
    );
    expect(deps.db.getTask(task.id)!.priority).toBe(1);
  });
});
