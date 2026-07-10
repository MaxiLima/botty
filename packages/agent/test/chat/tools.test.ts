import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { createMemory } from '../../src/memory/index.js';
import { createChatTools } from '../../src/chat/tools.js';
import { parseHeartbeat } from '../../src/config/parse.js';
import type { ChatToolSpec } from '../../src/llm/types.js';

function setup() {
  const db = new Db(':memory:');
  const bus = createBus();
  const config = {
    persona: () => '# PERSONA\nYou are botty.',
    heartbeat: () => parseHeartbeat('', 'sim'),
  };
  const memory = createMemory({ db, config });
  const tools = createChatTools({ db, memory, bus });
  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));
  const tool = (name: string): ChatToolSpec => tools.find((t) => t.name === name)!;
  return { db, bus, memory, tools, events, tool };
}

describe('chat tool registry', () => {
  it('exposes the four tools with zod raw shapes', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'capture_task',
      'memory_search',
      'session_search',
      'task_action',
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(Object.keys(t.inputSchema).length).toBeGreaterThan(0);
    }
  });
});

describe('capture_task', () => {
  it('creates an open chat-sourced task with defaults and broadcasts the board', async () => {
    const { db, events, tool } = setup();
    const res = await tool('capture_task').execute({ description: 'buy milk' });
    expect(res.error).toBeUndefined();
    expect(res.description).toBe('buy milk');

    const task = db.getTask(res.taskId as string)!;
    expect(task.status).toBe('open');
    expect(task.priority).toBe(2);
    expect(task.source).toBe('chat');
    expect(task.sourceRef).toMatch(/^chat:/);

    // history row attributed to chat
    const history = db.taskHistory(task.id);
    expect(history[0]!.changedBy).toBe('chat');

    // full-board tasks.updated snapshot, same as POST /api/tasks/:id/action
    const boards = events.filter((e) => e.type === 'tasks.updated');
    expect(boards).toHaveLength(1);
    expect(boards[0]!.payload.tasks.map((t) => t.id)).toContain(task.id);
  });

  it('two captures with identical text create two tasks (unique per-call sourceRef)', async () => {
    const { db, tool } = setup();
    const a = await tool('capture_task').execute({ description: 'same thing' });
    const b = await tool('capture_task').execute({ description: 'same thing' });
    expect(a.taskId).not.toBe(b.taskId);
    expect(db.listTasks('open')).toHaveLength(2);
    expect(db.getTask(a.taskId as string)!.sourceRef).not.toBe(db.getTask(b.taskId as string)!.sourceRef);
  });

  it('honors priority and dueDate, resolves requestedBy to a person (creating if unknown)', async () => {
    const { db, tool } = setup();
    const res = await tool('capture_task').execute({
      description: 'review the acme proposal',
      priority: 1,
      dueDate: '2026-07-15',
      requestedBy: 'Jane Doe',
    });
    const task = db.getTask(res.taskId as string)!;
    expect(task.priority).toBe(1);
    expect(task.dueDate).toBe('2026-07-15');
    const person = db.getPersonByName('Jane Doe')!;
    expect(task.requestedBy).toBe(person.id);
    expect(res.requestedBy).toBe('Jane Doe');
  });

  it('returns a readable error result on invalid input instead of throwing', async () => {
    const { tool } = setup();
    const noDesc = await tool('capture_task').execute({});
    expect(String(noDesc.error)).toContain('invalid input');
    const badDate = await tool('capture_task').execute({ description: 'x', dueDate: 'tomorrow' });
    expect(String(badDate.error)).toContain('invalid input');
    const badPriority = await tool('capture_task').execute({ description: 'x', priority: 5 });
    expect(String(badPriority.error)).toContain('invalid input');
  });

  it('summarize returns the description for the tool_use WS event', () => {
    const { tool } = setup();
    expect(tool('capture_task').summarize({ description: 'buy milk' })).toBe('buy milk');
  });
});

describe('task_action', () => {
  async function withTask() {
    const s = setup();
    const created = await s.tool('capture_task').execute({ description: 'target task' });
    s.events.length = 0; // drop the capture broadcast
    return { ...s, taskId: created.taskId as string };
  }

  it('done sets status + doneAt with changedBy chat and broadcasts', async () => {
    const { db, events, tool, taskId } = await withTask();
    const res = await tool('task_action').execute({ taskId, action: 'done' });
    expect(res.status).toBe('done');
    const task = db.getTask(taskId)!;
    expect(task.status).toBe('done');
    expect(task.doneAt).toBeTruthy();
    expect(db.taskHistory(taskId).some((h) => h.field === 'status' && h.newValue === 'done' && h.changedBy === 'chat')).toBe(true);
    expect(events.filter((e) => e.type === 'tasks.updated')).toHaveLength(1);
  });

  it('snooze defaults to 1 day and honors snoozeDays', async () => {
    const { db, tool, taskId } = await withTask();
    const res = await tool('task_action').execute({ taskId, action: 'snooze', snoozeDays: 3 });
    expect(res.status).toBe('snoozed');
    const until = Date.parse(db.getTask(taskId)!.snoozeUntil!);
    const expected = Date.now() + 3 * 86_400_000;
    expect(Math.abs(until - expected)).toBeLessThan(5_000);

    await tool('task_action').execute({ taskId, action: 'reopen' });
    await tool('task_action').execute({ taskId, action: 'snooze' });
    const oneDay = Date.parse(db.getTask(taskId)!.snoozeUntil!);
    expect(Math.abs(oneDay - (Date.now() + 86_400_000))).toBeLessThan(5_000);
  });

  it('snoozeUntil sets the exact wall-clock instant and takes precedence over snoozeDays', async () => {
    const { db, tool, taskId } = await withTask();
    const target = new Date(Date.now() + 36 * 3_600_000); // ~1.5 days out, an "off" day boundary
    const res = await tool('task_action').execute({
      taskId,
      action: 'snooze',
      snoozeUntil: target.toISOString(),
      snoozeDays: 3, // must be ignored — snoozeUntil wins
    });
    expect(res.status).toBe('snoozed');
    expect(Date.parse(db.getTask(taskId)!.snoozeUntil!)).toBe(target.getTime());
  });

  it('snoozeUntil in the past is rejected without mutating the task', async () => {
    const { db, tool, taskId } = await withTask();
    const past = new Date(Date.now() - 60_000).toISOString();
    const res = await tool('task_action').execute({ taskId, action: 'snooze', snoozeUntil: past });
    expect(String(res.error)).toContain('future');
    expect(db.getTask(taskId)!.status).toBe('open');
  });

  it('snoozeUntil without an offset/zone is a schema validation error (never silently accepted)', async () => {
    const { tool, taskId } = await withTask();
    const res = await tool('task_action').execute({ taskId, action: 'snooze', snoozeUntil: '2026-07-10T09:00' });
    expect(String(res.error)).toContain('invalid input');
  });

  it('dismiss cancels; reopen clears snooze/done back to open', async () => {
    const { db, tool, taskId } = await withTask();
    await tool('task_action').execute({ taskId, action: 'dismiss' });
    expect(db.getTask(taskId)!.status).toBe('cancelled');

    await tool('task_action').execute({ taskId, action: 'reopen' });
    const task = db.getTask(taskId)!;
    expect(task.status).toBe('open');
    expect(task.snoozeUntil).toBeNull();
    expect(task.doneAt).toBeNull();
  });

  it('priority action sets 1..3 and requires the priority field', async () => {
    const { db, tool, taskId } = await withTask();
    const missing = await tool('task_action').execute({ taskId, action: 'priority' });
    expect(String(missing.error)).toContain('priority');

    const res = await tool('task_action').execute({ taskId, action: 'priority', priority: 1 });
    expect(res.priority).toBe(1);
    expect(db.getTask(taskId)!.priority).toBe(1);
  });

  it('unknown taskId returns an error result, not a throw', async () => {
    const { tool } = await withTask();
    const res = await tool('task_action').execute({ taskId: 'nope', action: 'done' });
    expect(String(res.error)).toContain('task not found');
  });

  it('summarize names the action and task id', () => {
    const { tool } = setup();
    expect(tool('task_action').summarize({ taskId: 'abc', action: 'done' })).toBe('done: abc');
  });
});

describe('memory_search', () => {
  it('returns kind/refId/snippet rows from FTS', async () => {
    const { db, tool } = setup();
    const task = db.insertTask({ description: 'prepare quarterly report', source: 'chat', sourceRef: 'chat:x1' }, 'chat')!;
    db.ftsIndex('task', task.id, task.description);

    const res = await tool('memory_search').execute({ query: 'quarterly report' });
    const results = res.results as { kind: string; refId: string; snippet: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.kind).toBe('task');
    expect(results[0]!.refId).toBe(task.id);
    expect(results[0]!.snippet).toContain('quarterly');
  });

  it('rejects an empty query with an error result', async () => {
    const { tool } = setup();
    const res = await tool('memory_search').execute({ query: '' });
    expect(String(res.error)).toContain('invalid input');
  });
});

describe('session_search', () => {
  function seedSession(db: Db, contents: string[]) {
    const session = db.createSession();
    const turns = contents.map((content, i) => {
      const turn = db.insertChatTurn({
        sessionId: session.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content,
      });
      db.ftsIndex('chat', turn.id, content);
      return turn;
    });
    return { session, turns };
  }

  it('search mode FTS-matches only chat turns and joins back sessionId', async () => {
    const { db, tool } = setup();
    const { session } = seedSession(db, ['we talked about the zebra migration', 'yes, zebra migration is on track']);
    // A task mentioning the same word must NOT show up in session results.
    const task = db.insertTask({ description: 'zebra migration cleanup', source: 'chat', sourceRef: 'chat:z' }, 'chat')!;
    db.ftsIndex('task', task.id, task.description);

    const res = await tool('session_search').execute({ mode: 'search', query: 'zebra migration' });
    const results = res.results as { turnId: string; sessionId: string; snippet: string }[];
    expect(results.length).toBe(2);
    expect(results.every((r) => r.sessionId === session.id)).toBe(true);
  });

  it('search mode without a query is a readable error', async () => {
    const { tool } = setup();
    const res = await tool('session_search').execute({ mode: 'search' });
    expect(String(res.error)).toContain('query');
  });

  it('recent mode lists sessions with turn counts and summaries', async () => {
    const { db, tool } = setup();
    const { session } = seedSession(db, ['old chat', 'old reply']);
    db.sealSession(session.id, 'Talked about old things');

    const res = await tool('session_search').execute({ mode: 'recent' });
    const sessions = res.sessions as { sessionId: string; status: string; turns: number; summary?: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe(session.id);
    expect(sessions[0]!.status).toBe('sealed');
    expect(sessions[0]!.turns).toBe(2);
    expect(sessions[0]!.summary).toBe('Talked about old things');
  });

  it('browse mode pages turns with offset/limit and reports the total', async () => {
    const { db, tool } = setup();
    const { session } = seedSession(db, ['t0', 't1', 't2', 't3', 't4']);
    // Same-millisecond inserts tiebreak on random ids — take the canonical order
    // from turnsForSession (same ORDER BY) rather than insertion order.
    const ordered = db.turnsForSession(session.id);

    const res = await tool('session_search').execute({ mode: 'browse', sessionId: session.id, offset: 1, limit: 2 });
    expect(res.total).toBe(5);
    expect(res.offset).toBe(1);
    const page = res.turns as { turnId: string; content: string }[];
    expect(page.map((t) => t.turnId)).toEqual([ordered[1]!.id, ordered[2]!.id]);
  });

  it('browse mode requires sessionId and rejects unknown sessions', async () => {
    const { tool } = setup();
    const missing = await tool('session_search').execute({ mode: 'browse' });
    expect(String(missing.error)).toContain('sessionId');
    const unknown = await tool('session_search').execute({ mode: 'browse', sessionId: 'nope' });
    expect(String(unknown.error)).toContain('session not found');
  });
});
