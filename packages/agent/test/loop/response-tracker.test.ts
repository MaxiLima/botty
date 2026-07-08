import { beforeEach, describe, expect, it } from 'vitest';
import type { ProactiveLogRow } from '@botty/shared';
import { createBus } from '../../src/bus/index.js';
import { Db } from '../../src/db/index.js';
import {
  classifyMessage,
  createResponseTracker,
  keywordsFor,
  type SurfaceWithTask,
} from '../../src/loop/response-tracker.js';

function surface(over: Partial<ProactiveLogRow> = {}): ProactiveLogRow {
  return {
    id: 's1',
    taskId: 't1',
    surfaceKind: 'nudge',
    message: 'nudge',
    score: 8,
    trigger: 'schedule',
    surfacedAt: '2026-07-03T10:00:00.000Z',
    responseType: null,
    responseReason: null,
    responseAt: null,
    ...over,
  };
}

describe('keywordsFor', () => {
  it('extracts content words and drops stopwords/short words', () => {
    const kws = keywordsFor('Review the quarterly report for finance');
    expect(kws).toContain('quarterly');
    expect(kws).toContain('report');
    expect(kws).not.toContain('the');
    expect(kws).not.toContain('for');
  });
});

describe('classifyMessage (heuristic, no LLM)', () => {
  const surfaces: SurfaceWithTask[] = [
    { surface: surface({ id: 's1', taskId: 't1' }), taskDescription: 'Review the quarterly report' },
    { surface: surface({ id: 's2', taskId: 't2' }), taskDescription: 'Fix deploy pipeline' },
  ];

  it('keywords + completion phrase ⇒ completed', () => {
    const res = classifyMessage('just finished the quarterly report, sending it now', surfaces);
    expect(res).toEqual([{ surfaceId: 's1', taskId: 't1', responseType: 'completed' }]);
  });

  it('spanish completion phrases work ("ya está el reporte...")', () => {
    const res = classifyMessage('listo el tema del quarterly report', surfaces);
    expect(res).toEqual([{ surfaceId: 's1', taskId: 't1', responseType: 'completed' }]);
  });

  it('keywords + snooze phrase ⇒ snoozed', () => {
    const res = classifyMessage("I'll look at the deploy pipeline later", surfaces);
    expect(res).toEqual([{ surfaceId: 's2', taskId: 't2', responseType: 'snoozed' }]);
  });

  it('completion phrase without task keywords ⇒ nothing', () => {
    expect(classifyMessage('done!', surfaces)).toEqual([]);
  });

  it('task keywords without a phrase ⇒ nothing', () => {
    expect(classifyMessage('what was in the quarterly report again?', surfaces)).toEqual([]);
  });
});

describe('createResponseTracker (bus + db integration)', () => {
  let db: Db;
  beforeEach(() => {
    db = new Db(':memory:');
  });

  it('classifies chat.userMessage bus events against last-24h surfaces', () => {
    const bus = createBus();
    const task = db.insertTask({ description: 'Review the quarterly report', source: 'manual' })!;
    const row = db.insertProactiveLog({
      taskId: task.id,
      surfaceKind: 'nudge',
      message: 'nudge',
      surfacedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    const tracker = createResponseTracker({ db, bus });
    tracker.start();

    const at = new Date().toISOString();
    bus.emit('chat.userMessage', { text: 'quarterly report is done', at });

    const updated = db.surfacesForTask(task.id, 1)[0]!;
    expect(updated.id).toBe(row.id);
    expect(updated.responseType).toBe('completed');
    expect(updated.responseReason).toContain('quarterly report is done');
    expect(tracker.lastUserMessageAt()).toBe(at);
    tracker.stop();
  });

  it('ignores surfaces outside the 24h window and expires them', () => {
    const bus = createBus();
    const task = db.insertTask({ description: 'Review the quarterly report', source: 'manual' })!;
    const old = db.insertProactiveLog({
      taskId: task.id,
      surfaceKind: 'nudge',
      message: 'nudge',
      surfacedAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
    });
    const tracker = createResponseTracker({ db, bus });

    tracker.handleMessage('quarterly report done', new Date().toISOString());
    expect(db.surfacesForTask(task.id, 1)[0]!.responseType).toBeNull();

    expect(tracker.expire()).toBe(1);
    const expired = db.surfacesForTask(task.id, 1)[0]!;
    expect(expired.id).toBe(old.id);
    expect(expired.responseType).toBe('expired');
  });

  it('does not classify briefing surfaces', () => {
    const bus = createBus();
    const task = db.insertTask({ description: 'Review the quarterly report', source: 'manual' })!;
    db.insertProactiveLog({
      taskId: task.id,
      surfaceKind: 'morning_brief',
      message: 'brief',
      surfacedAt: new Date().toISOString(),
    });
    const tracker = createResponseTracker({ db, bus });
    const res = tracker.handleMessage('quarterly report done', new Date().toISOString());
    expect(res).toEqual([]);
  });
});
