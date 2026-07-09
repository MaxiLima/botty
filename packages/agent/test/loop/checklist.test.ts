import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JudgmentOutputSchema, type JudgmentOutput, type WsEvent } from '@botty/shared';
import { createBus, type Bus } from '../../src/bus/index.js';
import { checklistTaskId, parseHeartbeat, type HeartbeatConfig } from '../../src/config/parse.js';
import { Db } from '../../src/db/index.js';
import type { LlmClient, StructuredRequest } from '../../src/llm/types.js';
import { createMemory } from '../../src/memory/index.js';
import {
  CHECKLIST_STATE_KEY,
  checklistCandidateId,
  dueChecklistTasks,
  loadChecklistState,
  markChecklistRun,
} from '../../src/loop/checklist.js';
import { validateJudgment } from '../../src/loop/judgment.js';
import { createResponseTracker } from '../../src/loop/response-tracker.js';
import { runTick, type TickDeps } from '../../src/loop/tick.js';

/** Heartbeat checklist tasks (feature #4): '## Tasks' items ride the tick as
 * trusted extra judgment candidates; a tick with zero survivors AND zero due
 * checklist items never reaches the LLM (zero-cost floor). */

const CI_PROMPT = 'check whether the CI dashboard has red builds';
const CI_ID = checklistTaskId(CI_PROMPT);
const CI_CANDIDATE = `checklist:${CI_ID}`;

function heartbeat(over: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    ...parseHeartbeat('', 'sim'),
    workingHours: { start: '00:00', end: '00:00' }, // gate off
    quietHours: { start: '00:00', end: '00:00' }, // never quiet
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    checklistTasks: [{ id: CI_ID, intervalMin: 240, prompt: CI_PROMPT }],
    ...over,
  };
}

function stubLlm(db: Db, judgment: JudgmentOutput) {
  const structured = vi.fn(async (req: StructuredRequest<unknown>) => {
    const value = req.schema.parse(JudgmentOutputSchema.parse(judgment));
    db.insertAiDecision({
      kind: req.task,
      input: { system: req.system, prompt: req.prompt },
      output: value,
      model: 'stub',
      relatedRef: req.relatedRef ?? null,
    });
    return value;
  });
  const llm: LlmClient = {
    chatTurn: async () => {
      throw new Error('not used');
    },
    structured: structured as LlmClient['structured'],
    interrupt: async () => undefined,
  };
  return { llm, structured };
}

function makeDeps(db: Db, bus: Bus, hb: HeartbeatConfig, judgment: JudgmentOutput) {
  const config = { heartbeat: () => hb, persona: () => '' };
  const memory = createMemory({ db, config });
  const tracker = createResponseTracker({ db, bus });
  const { llm, structured } = stubLlm(db, judgment);
  const macNotifier = vi.fn();
  const deps: TickDeps = { db, bus, config, llm, memory, tracker, macNotifier };
  return { deps, structured, macNotifier };
}

const skipAll: JudgmentOutput = { tickReasoning: 'skip', actions: [], skipped: [] };

describe('checklist scheduling helpers', () => {
  it('dueChecklistTasks: never-run and interval-elapsed items are due', () => {
    const tasks = [
      { id: 'a', intervalMin: 60, prompt: 'A' },
      { id: 'b', intervalMin: 60, prompt: 'B' },
      { id: 'c', intervalMin: 60, prompt: 'C' },
    ];
    const now = '2026-07-08T12:00:00.000Z';
    const state = {
      b: '2026-07-08T11:30:00.000Z', // 30 min ago — not due
      c: '2026-07-08T10:00:00.000Z', // 2h ago — due
    };
    expect(dueChecklistTasks(tasks, state, now).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('markChecklistRun advances due items and prunes ids no longer configured', () => {
    const db = new Db(':memory:');
    db.setSetting(CHECKLIST_STATE_KEY, { stale: '2026-07-01T00:00:00.000Z', b: '2026-07-08T00:00:00.000Z' });
    const configured = [
      { id: 'a', intervalMin: 60, prompt: 'A' },
      { id: 'b', intervalMin: 60, prompt: 'B' },
    ];
    markChecklistRun(db, configured, [configured[0]!], '2026-07-08T12:00:00.000Z');
    expect(loadChecklistState(db)).toEqual({
      a: '2026-07-08T12:00:00.000Z',
      b: '2026-07-08T00:00:00.000Z',
    });
    db.close();
  });
});

describe('validateJudgment — checklist candidates', () => {
  const validTaskIds = new Set(['t1']);
  const checklistIds = new Set([CI_CANDIDATE]);

  it('accepts notify actions on checklist ids, exempt from threshold and notify cap', () => {
    const res = validateJudgment(
      {
        tickReasoning: 'r',
        actions: [
          { type: 'notify', taskId: 't1', score: 9, message: 'task', reasoning: '' },
          // Low score + a second notify: both exemptions in one action.
          { type: 'notify', taskId: CI_CANDIDATE, score: 1, message: 'CI is red', reasoning: '' },
        ],
        skipped: [],
      },
      { surfacingThreshold: 7, validTaskIds, checklistIds },
    );
    expect(res.actions.map((a) => a.taskId)).toEqual(['t1', CI_CANDIDATE]);
    expect(res.dropped).toEqual([]);
  });

  it('drops snooze/update_priority on checklist ids and unknown checklist ids', () => {
    const res = validateJudgment(
      {
        tickReasoning: 'r',
        actions: [
          { type: 'snooze', taskId: CI_CANDIDATE, score: 5, snoozeDays: 2, reasoning: '' },
          { type: 'notify', taskId: 'checklist:hallucinated', score: 9, reasoning: '' },
        ],
        skipped: [],
      },
      { surfacingThreshold: 7, validTaskIds, checklistIds },
    );
    expect(res.actions).toEqual([]);
    expect(res.dropped).toEqual([
      { taskId: CI_CANDIDATE, type: 'snooze', reason: 'checklist_action' },
      { taskId: 'checklist:hallucinated', type: 'notify', reason: 'unknown_task' },
    ]);
  });
});

describe('runTick — checklist tasks', () => {
  let db: Db;
  let bus: Bus;
  let events: WsEvent[];

  beforeEach(() => {
    db = new Db(':memory:');
    bus = createBus();
    events = [];
    bus.onBroadcast((e) => events.push(e));
  });

  it('zero-cost floor: no survivors and no due checklist ⇒ no LLM call', async () => {
    const now = new Date().toISOString();
    // Item ran 10 minutes ago — not due for another ~4h.
    db.setSetting(CHECKLIST_STATE_KEY, { [CI_ID]: new Date(Date.now() - 10 * 60_000).toISOString() });
    const { deps, structured } = makeDeps(db, bus, heartbeat(), skipAll);
    const id = await runTick(deps, { trigger: 'run-now', now });
    expect(db.getTick(id)!.candidatesIn).toBe(0);
    expect(structured).not.toHaveBeenCalled();
    // lastRunAt untouched by the early return
    expect(loadChecklistState(db)[CI_ID]).toBeDefined();
  });

  it('a due checklist item alone reaches judgment; its context is labeled and trusted', async () => {
    const { deps, structured } = makeDeps(db, bus, heartbeat(), skipAll);
    await runTick(deps, { trigger: 'run-now' });
    expect(structured).toHaveBeenCalledTimes(1);
    const req = structured.mock.calls[0]![0] as StructuredRequest<unknown>;
    expect(req.prompt).toContain('Due recurring checklist items (1)');
    expect(req.prompt).toContain(CI_CANDIDATE);
    expect(req.prompt).toContain(CI_PROMPT);
  });

  it('judgment notify on a checklist id surfaces as a plain notification and advances lastRunAt', async () => {
    const judgment: JudgmentOutput = {
      tickReasoning: 'CI is red',
      actions: [{ type: 'notify', taskId: CI_CANDIDATE, score: 8, message: 'CI has red builds', reasoning: 'due' }],
      skipped: [],
    };
    const { deps, macNotifier } = makeDeps(db, bus, heartbeat(), judgment);
    const now = new Date().toISOString();
    const id = await runTick(deps, { trigger: 'run-now', now });
    const tick = db.getTick(id)!;

    const actions = JSON.parse(tick.actionsJson!) as { type: string; taskId: string; proactiveLogId?: string }[];
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'notify', taskId: CI_CANDIDATE });
    const surface = db.raw
      .prepare('SELECT * FROM proactive_log WHERE surface_kind=?')
      .get('checklist') as { task_id: string | null; message: string } | undefined;
    expect(surface).toMatchObject({ task_id: null, message: 'CI has red builds' });
    expect(macNotifier).toHaveBeenCalledWith('botty', 'CI has red builds');
    const notification = events.find((e) => e.type === 'notification');
    expect(notification?.payload).toMatchObject({ kind: 'checklist', taskId: null });
    expect(loadChecklistState(db)[CI_ID]).toBe(now);
  });

  it('judgment silence (skip) still advances lastRunAt — the item was processed', async () => {
    const { deps } = makeDeps(db, bus, heartbeat(), skipAll);
    const now = new Date().toISOString();
    await runTick(deps, { trigger: 'run-now', now });
    expect(loadChecklistState(db)[CI_ID]).toBe(now);
  });

  it('judgment failure (after the one retry) does NOT advance lastRunAt — retries next tick', async () => {
    const { deps } = makeDeps(db, bus, heartbeat(), skipAll);
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    deps.llm = { ...deps.llm, structured: failing as unknown as typeof deps.llm.structured };
    const now = new Date().toISOString();
    const id = await runTick(deps, { trigger: 'run-now', now });
    expect(failing).toHaveBeenCalledTimes(2);
    expect(db.getTick(id)!.error).toContain('boom');
    expect(loadChecklistState(db)[CI_ID]).toBeUndefined();

    // Next tick: the item is still due and judgment (recovered) processes it.
    const recovered = makeDeps(db, bus, heartbeat(), skipAll);
    await runTick(recovered.deps, { trigger: 'run-now', now });
    expect(recovered.structured).toHaveBeenCalledTimes(1);
    expect(loadChecklistState(db)[CI_ID]).toBe(now);
  });
});
