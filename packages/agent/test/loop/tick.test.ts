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

    it('inactive day skips inside the time window, and says so', async () => {
      // 2026-07-05 is a Sunday; activeDays default Mon-Fri. The reason is
      // 'inactive_day', not 'off_hours' — a weekend skip and a 3am skip are
      // different facts in the tick log.
      const { deps, structured } = makeDeps(
        db,
        bus,
        heartbeat({ workingHours: { start: '08:00', end: '19:00' }, activeDays: [1, 2, 3, 4, 5] }),
        skipAll,
      );
      const id = await runTick(deps, { trigger: 'schedule', now: '2026-07-05T12:00:00' });
      expect(db.getTick(id)!.skippedJson).toContain('inactive_day');
      expect(structured).not.toHaveBeenCalled();
    });

    it('an active day outside the window is off_hours, not inactive_day', async () => {
      // 2026-07-06 is a Monday, 03:00 — inside the active days, outside the window.
      const { deps } = makeDeps(
        db,
        bus,
        heartbeat({ workingHours: { start: '08:00', end: '19:00' }, activeDays: [1, 2, 3, 4, 5] }),
        skipAll,
      );
      const id = await runTick(deps, { trigger: 'schedule', now: '2026-07-06T03:00:00' });
      expect(db.getTick(id)!.skippedJson).toContain('off_hours');
    });

    it('a weekend skip does not collapse into the previous off_hours row', async () => {
      // The "one row per off window" dedup keys on the reason, so Friday night's
      // off_hours row can't swallow Saturday's inactive_day row.
      const { deps } = makeDeps(
        db,
        bus,
        heartbeat({ workingHours: { start: '08:00', end: '19:00' }, activeDays: [1, 2, 3, 4, 5] }),
        skipAll,
      );
      await runTick(deps, { trigger: 'schedule', now: '2026-07-03T22:00:00' }); // Friday night
      const weekend = await runTick(deps, { trigger: 'schedule', now: '2026-07-04T12:00:00' });
      expect(db.getTick(weekend)!.skippedJson).toContain('inactive_day');
      expect(db.listTicks(10)).toHaveLength(2);
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

    it('manual run-now inside quiet hours still keeps its candidates', async () => {
      // The working-hours gate was already bypassed for run-now, but every
      // candidate was then silently rejected by the rules filter's quiet-hours
      // gate — a user-triggered run gathered candidates and nudged nobody.
      const task = db.insertTask({ description: 'Quiet-hours manual check', source: 'manual' })!;
      const old = new Date(Date.parse(offNow) - 5 * 3_600_000).toISOString();
      db.raw.prepare('UPDATE tasks SET created_at=?, updated_at=? WHERE id=?').run(old, old, task.id);
      const { deps, structured } = makeDeps(
        db,
        bus,
        heartbeat({ quietHours: { start: '00:00', end: '23:59' } }),
        skipAll,
      );

      const id = await runTick(deps, { trigger: 'run-now', now: offNow });
      const tick = db.getTick(id)!;
      expect(tick.candidatesIn).toBe(1);
      expect(tick.candidatesAfterRules).toBe(1);
      expect(structured).toHaveBeenCalledTimes(1);
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

  describe('hourly nudge budget (step 9.5)', () => {
    // Three due-soon tasks (dueDate < 24h away) so validateJudgment's one-notify-
    // per-tick cap exempts all three notify actions — the only thing left to
    // enforce max_proactive_per_hour is the step-9.5 budget under test here.
    function dueSoonTasks(db: Db, n: number) {
      return Array.from({ length: n }, (_, i) =>
        db.insertTask({
          description: `Due-soon task ${i + 1}`,
          source: 'manual',
          dueDate: new Date(Date.now() + (i + 1) * 3_600_000).toISOString(),
        })!,
      );
    }

    it('budget free (2 of 2 fit): both notifies pass, nothing dropped for budget', async () => {
      const tasks = dueSoonTasks(db, 2);
      const judgment: JudgmentOutput = {
        tickReasoning: 'both matter',
        actions: [
          { type: 'notify', taskId: tasks[0]!.id, score: 9, message: 'a', reasoning: 'r' },
          { type: 'notify', taskId: tasks[1]!.id, score: 8, message: 'b', reasoning: 'r' },
        ],
        skipped: [],
      };
      const { deps, macNotifier } = makeDeps(db, bus, heartbeat(), judgment);
      const id = await runTick(deps, { trigger: 'run-now' });

      const tick = db.getTick(id)!;
      const actions = JSON.parse(tick.actionsJson!) as { type: string; taskId: string }[];
      expect(actions.map((a) => a.taskId).sort()).toEqual([tasks[0]!.id, tasks[1]!.id].sort());
      const skipped = JSON.parse(tick.skippedJson!) as { droppedActions: { reason: string }[] };
      expect(skipped.droppedActions.filter((d) => d.reason === 'hourly_budget')).toHaveLength(0);
      expect(macNotifier).toHaveBeenCalledTimes(2);
    });

    it('budget partially consumed (1 of 2 already used): only 1 notify passes, lowest score dropped', async () => {
      // One nudge already logged in the trailing hour (but older than the 30min
      // min-gap, so gate 6 doesn't block candidates outright) ⇒ only 1 slot
      // remains of max_proactive_per_hour (default 2).
      db.insertProactiveLog({
        taskId: null,
        surfaceKind: 'nudge',
        message: 'earlier nudge',
        surfacedAt: new Date(Date.now() - 35 * 60_000).toISOString(),
      });
      const tasks = dueSoonTasks(db, 2);
      const judgment: JudgmentOutput = {
        tickReasoning: 'both matter',
        actions: [
          { type: 'notify', taskId: tasks[0]!.id, score: 9, message: 'high score', reasoning: 'r' },
          { type: 'notify', taskId: tasks[1]!.id, score: 7, message: 'low score', reasoning: 'r' },
        ],
        skipped: [],
      };
      const { deps, macNotifier } = makeDeps(db, bus, heartbeat(), judgment);
      const id = await runTick(deps, { trigger: 'run-now' });

      const tick = db.getTick(id)!;
      const actions = JSON.parse(tick.actionsJson!) as { type: string; taskId: string }[];
      expect(actions.map((a) => a.taskId)).toEqual([tasks[0]!.id]);
      const skipped = JSON.parse(tick.skippedJson!) as {
        droppedActions: { taskId: string; reason: string }[];
      };
      expect(skipped.droppedActions).toContainEqual({
        taskId: tasks[1]!.id,
        type: 'notify',
        reason: 'hourly_budget',
      });
      expect(macNotifier).toHaveBeenCalledTimes(1);
      expect(macNotifier).toHaveBeenCalledWith('botty', 'high score');
    });

    // NOTE: a runTick-level "budget already fully exhausted before judgment runs"
    // case is NOT reachable through this path — rules-filter's own gate 8
    // (hourly_cap) shares the exact same nudgesLastHour/maxProactivePerHour
    // comparison, so any candidate that would see a 0-remaining budget here is
    // already rejected at the rules-filter stage first (structured() is never
    // even called; see the zero-cost floor, tick.ts step 6). That is by design:
    // the two layers must never disagree about when the budget is gone. The
    // exhausted-budget behavior of the capping logic itself (0 remaining ⇒ every
    // notify dropped) is covered directly at the unit level in judgment.test.ts
    // ('applyHourlyBudget' > 'budget exhausted').

    it('reproduces the reported bug: a single judgment call returning 3 notifies is capped to 2, lowest score dropped', async () => {
      const tasks = dueSoonTasks(db, 3);
      const judgment: JudgmentOutput = {
        tickReasoning: 'all three matter, allegedly',
        actions: [
          { type: 'notify', taskId: tasks[0]!.id, score: 9, message: 'a', reasoning: 'r' },
          { type: 'notify', taskId: tasks[1]!.id, score: 8, message: 'b', reasoning: 'r' },
          { type: 'notify', taskId: tasks[2]!.id, score: 7, message: 'c', reasoning: 'r' },
        ],
        skipped: [],
      };
      const { deps, macNotifier } = makeDeps(db, bus, heartbeat(), judgment);
      const id = await runTick(deps, { trigger: 'run-now' });

      const tick = db.getTick(id)!;
      const actions = JSON.parse(tick.actionsJson!) as { type: string; taskId: string }[];
      expect(actions.map((a) => a.taskId).sort()).toEqual([tasks[0]!.id, tasks[1]!.id].sort());
      const skipped = JSON.parse(tick.skippedJson!) as {
        droppedActions: { taskId: string; reason: string }[];
      };
      expect(skipped.droppedActions).toContainEqual({
        taskId: tasks[2]!.id,
        type: 'notify',
        reason: 'hourly_budget',
      });
      expect(macNotifier).toHaveBeenCalledTimes(2); // NOT 3 — the bug is fixed.
    });
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

  // H2 bug class (2026-08-21 investigation), one-line follow-up handed over
  // from the H1 agent: dueSoonTaskIds (the 24h notify-cap exemption, step 9)
  // used raw Date.parse(dueDate) instead of dueDateInstant (loop/time.ts). A
  // date-only dueDate is UTC midnight under Date.parse — for this repo's
  // negative-offset (UTC-3) dev/test environment that instant reads several
  // hours EARLIER than the date's real local end-of-day, so the old code
  // could wrongly treat a date-only due date that's actually ~25h away as
  // already due (trivially "< 24h"), over-exempting it from the
  // one-notify-per-tick cap.
  it('a date-only due date ~25h out (per dueDateInstant) is NOT exempt from the one-notify cap', async () => {
    const now = '2026-07-05T02:00:00.000Z';
    // Date.parse('2026-07-05') = 2026-07-05T00:00:00Z — 2h in the PAST
    // relative to `now`; the old buggy code read this as already overdue and
    // wrongly exempted it. dueDateInstant reads a date-only value as the end
    // of LOCAL 2026-07-05 (23:59:59 in America/Argentina/Buenos_Aires,
    // UTC-3) = 2026-07-06T02:59:59Z, ~25h after `now` — correctly NOT due
    // within 24h.
    const dateOnlyDue = db.insertTask({
      description: 'date-only due date',
      source: 'manual',
      dueDate: '2026-07-05',
    })!;
    // Full ISO timestamp (unambiguous either way) 30h out: a DUE_SOON
    // candidate, but genuinely NOT within the 24h exemption window — the
    // control that should always consume the one-notify slot.
    const laterButUnambiguous = db.insertTask({
      description: 'due in 30h, unambiguous',
      source: 'manual',
      dueDate: new Date(Date.parse(now) + 30 * 3_600_000).toISOString(),
    })!;
    const judgment: JudgmentOutput = {
      tickReasoning: 'two due-soon candidates',
      actions: [
        { type: 'notify', taskId: dateOnlyDue.id, score: 9, message: 'a', reasoning: 'r' },
        { type: 'notify', taskId: laterButUnambiguous.id, score: 8, message: 'b', reasoning: 'r' },
      ],
      skipped: [],
    };
    const { deps, macNotifier } = makeDeps(db, bus, heartbeat(), judgment);
    const id = await runTick(deps, { trigger: 'run-now', now });

    const tick = db.getTick(id)!;
    const actions = JSON.parse(tick.actionsJson!) as { taskId: string }[];
    // Only ONE notify goes through — proves dateOnlyDue was NOT treated as
    // due-soon-exempt. Under the old raw-Date.parse bug both would have
    // passed with nothing dropped for notify_cap.
    expect(actions).toHaveLength(1);
    const skipped = JSON.parse(tick.skippedJson!) as {
      droppedActions: { taskId: string; reason: string }[];
    };
    expect(skipped.droppedActions).toContainEqual(
      expect.objectContaining({ reason: 'notify_cap' }),
    );
    expect(macNotifier).toHaveBeenCalledTimes(1);
  });
});
