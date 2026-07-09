import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  JudgmentOutputSchema,
  type JudgmentOutput,
  type WsEvent,
} from '@botty/shared';
import { createBus, type Bus } from '../../src/bus/index.js';
import { parseHeartbeat, type HeartbeatConfig } from '../../src/config/parse.js';
import { Db } from '../../src/db/index.js';
import type { LlmClient, StructuredRequest } from '../../src/llm/types.js';
import { createMemory } from '../../src/memory/index.js';
import { createResponseTracker } from '../../src/loop/response-tracker.js';
import { runTick, type TickDeps } from '../../src/loop/tick.js';

function heartbeat(over: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    ...parseHeartbeat('', 'sim'), // defaults for every knob (sim source intervals: 1m)
    workingHours: { start: '00:00', end: '00:00' }, // start === end ⇒ gate off (always within)
    quietHours: { start: '00:00', end: '00:00' }, // start === end ⇒ never quiet
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    ...over,
  };
}

/** LLM stub: returns the canned judgment and records the decision like the real client. */
function stubLlm(db: Db, judgment: JudgmentOutput): { llm: LlmClient; structured: ReturnType<typeof vi.fn> } {
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

describe('runTick', () => {
  let db: Db;
  let bus: Bus;
  let events: WsEvent[];

  beforeEach(() => {
    db = new Db(':memory:');
    bus = createBus();
    events = [];
    bus.onBroadcast((e) => events.push(e));
  });

  it('scheduled tick during quiet hours records a skipped tick without calling the LLM', async () => {
    const now = new Date();
    const hhmm = (offMin: number) => {
      const d = new Date(now.getTime() + offMin * 60_000);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const hb = heartbeat({ quietHours: { start: hhmm(-60), end: hhmm(60) } });
    const { deps, structured } = makeDeps(db, bus, hb, skipAll);

    const id = await runTick(deps, { trigger: 'schedule' });
    const tick = db.getTick(id)!;
    expect(tick.skippedJson).toContain('quiet_hours');
    expect(tick.finishedAt).not.toBeNull();
    expect(structured).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'tick.completed')).toBe(true);
  });

  describe('working-hours hard gate', () => {
    // 2026-07-01 is a Wednesday; noon is outside a 14:00-16:00 window.
    const offNow = '2026-07-01T12:00:00';
    const offHb = () => heartbeat({ workingHours: { start: '14:00', end: '16:00' } });

    it('scheduled tick outside working hours writes ONE off_hours row, no LLM', async () => {
      const { deps, structured } = makeDeps(db, bus, offHb(), skipAll);

      const first = await runTick(deps, { trigger: 'schedule', now: offNow });
      const tick = db.getTick(first)!;
      expect(tick.skippedJson).toContain('off_hours');
      expect(tick.finishedAt).not.toBeNull();
      expect(structured).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === 'tick.completed')).toBe(true);

      // subsequent off-hours ticks are silent no-ops: same row, no new tick_log entries
      const second = await runTick(deps, { trigger: 'schedule', now: offNow });
      expect(second).toBe(first);
      expect(db.listTicks(10)).toHaveLength(1);
    });

    it('inactive day is off-hours even inside the time window', async () => {
      // 2026-07-05 is a Sunday; activeDays default Mon-Fri
      const { deps, structured } = makeDeps(
        db,
        bus,
        heartbeat({ workingHours: { start: '08:00', end: '19:00' }, activeDays: [1, 2, 3, 4, 5] }),
        skipAll,
      );
      const id = await runTick(deps, { trigger: 'schedule', now: '2026-07-05T12:00:00' });
      expect(db.getTick(id)!.skippedJson).toContain('off_hours');
      expect(structured).not.toHaveBeenCalled();
    });

    it('manual run-now BYPASSES the gate and runs the full tick', async () => {
      const task = db.insertTask({ description: 'Off-hours manual check', source: 'manual' })!;
      db.raw
        .prepare('UPDATE tasks SET created_at=?, updated_at=? WHERE id=?')
        .run(
          new Date(Date.parse(offNow) - 5 * 3_600_000).toISOString(),
          new Date(Date.parse(offNow) - 5 * 3_600_000).toISOString(),
          task.id,
        );
      const { deps, structured } = makeDeps(db, bus, offHb(), skipAll);

      const id = await runTick(deps, { trigger: 'run-now', now: offNow });
      const tick = db.getTick(id)!;
      expect(tick.skippedJson ?? '').not.toContain('off_hours');
      expect(tick.candidatesIn).toBe(1);
      expect(structured).toHaveBeenCalledTimes(1); // judgment ran ⇒ gate bypassed
    });
  });

  it('no survivors ⇒ tick recorded, no LLM call', async () => {
    const { deps, structured } = makeDeps(db, bus, heartbeat(), skipAll);
    const id = await runTick(deps, { trigger: 'run-now' });
    const tick = db.getTick(id)!;
    expect(tick.candidatesIn).toBe(0);
    expect(tick.candidatesAfterRules).toBe(0);
    expect(structured).not.toHaveBeenCalled();
  });

  it('notify action: proactive_log + surface_count + history + WS + macOS + tick_log', async () => {
    const task = db.insertTask({ description: 'Ship the release notes', source: 'manual' })!;
    // Make it a NEVER_SURFACED candidate (created > 4h ago).
    db.raw
      .prepare('UPDATE tasks SET created_at=?, updated_at=? WHERE id=?')
      .run(
        new Date(Date.now() - 5 * 3_600_000).toISOString(),
        new Date(Date.now() - 5 * 3_600_000).toISOString(),
        task.id,
      );

    const judgment: JudgmentOutput = {
      tickReasoning: 'worth it',
      actions: [
        { type: 'notify', taskId: task.id, score: 9, message: 'Ship the release notes now', reasoning: 'due' },
        { type: 'notify', taskId: 'hallucinated', score: 9, reasoning: 'bogus' },
      ],
      skipped: [],
    };
    const { deps, structured, macNotifier } = makeDeps(db, bus, heartbeat(), judgment);

    const id = await runTick(deps, { trigger: 'run-now' });
    const tick = db.getTick(id)!;

    expect(structured).toHaveBeenCalledTimes(1);
    expect(tick.candidatesIn).toBe(1);
    expect(tick.candidatesAfterRules).toBe(1);
    expect(tick.judgmentDecisionId).not.toBeNull();
    expect(tick.error).toBeNull();

    const actions = JSON.parse(tick.actionsJson!) as { type: string; taskId: string }[];
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'notify', taskId: task.id });
    const skipped = JSON.parse(tick.skippedJson!) as { droppedActions: { reason: string }[] };
    expect(skipped.droppedActions).toEqual([
      { taskId: 'hallucinated', type: 'notify', reason: 'unknown_task' },
    ]);

    const updated = db.getTask(task.id)!;
    expect(updated.surfaceCount).toBe(1);
    expect(updated.lastSurfacedAt).not.toBeNull();
    expect(db.taskHistory(task.id).some((h) => h.field === 'surfaceCount')).toBe(true);
    expect(db.surfacesForTask(task.id, 1)[0]!.message).toBe('Ship the release notes now');

    expect(macNotifier).toHaveBeenCalledWith('botty', 'Ship the release notes now');
    expect(events.some((e) => e.type === 'notification')).toBe(true);
    expect(events.some((e) => e.type === 'tasks.updated')).toBe(true);
    expect(events.some((e) => e.type === 'tick.completed')).toBe(true);
  });

  it('sub-threshold notify is dropped before execution', async () => {
    const task = db.insertTask({ description: 'Low value chore', source: 'manual' })!;
    db.raw
      .prepare('UPDATE tasks SET created_at=? WHERE id=?')
      .run(new Date(Date.now() - 5 * 3_600_000).toISOString(), task.id);
    const judgment: JudgmentOutput = {
      tickReasoning: 'meh',
      actions: [{ type: 'notify', taskId: task.id, score: 5, message: 'meh', reasoning: 'meh' }],
      skipped: [],
    };
    const { deps, macNotifier } = makeDeps(db, bus, heartbeat(), judgment);
    const id = await runTick(deps, { trigger: 'run-now' });

    expect(db.getTask(task.id)!.surfaceCount).toBe(0);
    expect(macNotifier).not.toHaveBeenCalled();
    const skipped = JSON.parse(db.getTick(id)!.skippedJson!) as { droppedActions: { reason: string }[] };
    expect(skipped.droppedActions[0]!.reason).toBe('below_threshold');
  });

  it('judgment failure retries once, then fails open: clean no-actions tick, error recorded', async () => {
    const task = db.insertTask({ description: 'Anything at all', source: 'manual' })!;
    db.raw
      .prepare('UPDATE tasks SET created_at=? WHERE id=?')
      .run(new Date(Date.now() - 5 * 3_600_000).toISOString(), task.id);
    const { deps } = makeDeps(db, bus, heartbeat(), skipAll);
    const failing = vi.fn(async () => {
      throw new Error('boom');
    });
    deps.llm = { ...deps.llm, structured: failing as unknown as typeof deps.llm.structured };
    const id = await runTick(deps, { trigger: 'run-now' });
    const tick = db.getTick(id)!;
    expect(failing).toHaveBeenCalledTimes(2); // one retry
    expect(tick.error).toContain('boom');
    // Fail-open (#6b): the tick still records its bookkeeping and zero actions.
    expect(tick.candidatesIn).toBe(1);
    expect(tick.candidatesAfterRules).toBe(1);
    expect(JSON.parse(tick.actionsJson!)).toEqual([]);
    expect(tick.skippedJson).toContain('judgment_error');
    expect(events.some((e) => e.type === 'tick.completed')).toBe(true);
  });
});
