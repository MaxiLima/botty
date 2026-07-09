import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JudgmentOutput } from '@botty/shared';
import { createBus, type Bus } from '../../src/bus/index.js';
import { parseHeartbeat, type HeartbeatConfig } from '../../src/config/parse.js';
import { Db } from '../../src/db/index.js';
import type { LlmClient, StructuredRequest } from '../../src/llm/types.js';
import { createMemory } from '../../src/memory/index.js';
import { createResponseTracker } from '../../src/loop/response-tracker.js';
import { runTick, type TickDeps } from '../../src/loop/tick.js';

/**
 * Regression for the bug where tick.ts always looked back only 24h for recent
 * surfaces, so min_gap_between_nudges_min configured above 1440 (24h) was
 * silently capped at 24h — the last nudge fell out of the lookback window and
 * the min_gap gate never saw it. docs/specs/loop.md §5 gate 6.
 */

function heartbeat(over: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    ...parseHeartbeat('', 'sim'), // defaults for every knob
    workingHours: { start: '00:00', end: '00:00' },
    quietHours: { start: '00:00', end: '00:00' },
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    maxProactivePerHour: 5,
    ...over,
  };
}

function stubLlm(db: Db, judgment: JudgmentOutput): { llm: LlmClient; structured: ReturnType<typeof vi.fn> } {
  const structured = vi.fn(async (req: StructuredRequest<unknown>) => {
    const value = req.schema.parse(judgment);
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
  const deps: TickDeps = { db, bus, config, llm, memory, tracker };
  return { deps, structured };
}

const skipAll: JudgmentOutput = { tickReasoning: 'skip', actions: [], skipped: [] };

describe('runTick — min-gap lookback window (bug A)', () => {
  let db: Db;
  let bus: Bus;

  beforeEach(() => {
    db = new Db(':memory:');
    bus = createBus();
  });

  it('honors a min_gap_between_nudges_min configured above 24h (2880 = 48h)', async () => {
    const task = db.insertTask({ description: 'Nudge-worthy task', source: 'manual' })!;
    // NEVER_SURFACED requires created_at older than 4h.
    db.raw
      .prepare('UPDATE tasks SET created_at=?, updated_at=? WHERE id=?')
      .run(
        new Date(Date.now() - 5 * 3_600_000).toISOString(),
        new Date(Date.now() - 5 * 3_600_000).toISOString(),
        task.id,
      );

    // A nudge fired 30h ago — outside the old hardcoded 24h lookback, but well
    // inside a configured 48h min gap.
    db.insertProactiveLog({
      taskId: null,
      surfaceKind: 'nudge',
      message: 'earlier nudge',
      surfacedAt: new Date(Date.now() - 30 * 3_600_000).toISOString(),
    });

    const hb = heartbeat({ minGapBetweenNudgesMin: 2880 });
    const { deps, structured } = makeDeps(db, bus, hb, skipAll);

    const id = await runTick(deps, { trigger: 'run-now' });
    const tick = db.getTick(id)!;

    expect(tick.candidatesIn).toBe(1);
    // The gate must reject the candidate before judgment ever runs.
    expect(tick.candidatesAfterRules).toBe(0);
    expect(structured).not.toHaveBeenCalled();
    const skipped = JSON.parse(tick.skippedJson!) as { rules: { taskId: string; gate: string }[] };
    expect(skipped.rules).toEqual([{ taskId: task.id, gate: 'min_gap' }]);
  });

  it('still surfaces once the configured 48h gap has actually elapsed', async () => {
    const task = db.insertTask({ description: 'Nudge-worthy task', source: 'manual' })!;
    db.raw
      .prepare('UPDATE tasks SET created_at=?, updated_at=? WHERE id=?')
      .run(
        new Date(Date.now() - 5 * 3_600_000).toISOString(),
        new Date(Date.now() - 5 * 3_600_000).toISOString(),
        task.id,
      );
    db.insertProactiveLog({
      taskId: null,
      surfaceKind: 'nudge',
      message: 'earlier nudge',
      surfacedAt: new Date(Date.now() - 49 * 3_600_000).toISOString(),
    });

    const hb = heartbeat({ minGapBetweenNudgesMin: 2880 });
    const { deps, structured } = makeDeps(db, bus, hb, skipAll);

    const id = await runTick(deps, { trigger: 'run-now' });
    const tick = db.getTick(id)!;
    expect(tick.candidatesAfterRules).toBe(1);
    expect(structured).toHaveBeenCalledTimes(1);
  });
});
