import { describe, expect, it } from 'vitest';
import type { JudgmentOutput } from '@botty/shared';
import { formatLocalIsoWithOffsetAndWeekday } from '../../src/chat/commitments.js';
import { Db } from '../../src/db/index.js';
import { MockLlmClient } from '../../src/llm/mock.js';
import { makeModelResolver } from '../../src/llm/index.js';
import {
  applyHourlyBudget,
  buildJudgmentPrompt,
  JUDGMENT_SYSTEM,
  runJudgment,
  validateJudgment,
} from '../../src/loop/judgment.js';

const action = (
  over: Partial<JudgmentOutput['actions'][number]>,
): JudgmentOutput['actions'][number] => ({
  type: 'notify',
  taskId: 't1',
  score: 8,
  reasoning: 'because',
  ...over,
});

const output = (actions: JudgmentOutput['actions']): JudgmentOutput => ({
  tickReasoning: 'r',
  actions,
  skipped: [],
});

describe('validateJudgment', () => {
  const validTaskIds = new Set(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']);

  it('drops notify actions scoring under the surfacing threshold', () => {
    const res = validateJudgment(
      output([action({ taskId: 't1', score: 6 }), action({ taskId: 't2', score: 7 })]),
      { surfacingThreshold: 7, validTaskIds },
    );
    expect(res.actions.map((a) => a.taskId)).toEqual(['t2']);
    expect(res.dropped).toEqual([{ taskId: 't1', type: 'notify', reason: 'below_threshold' }]);
  });

  it('does not apply the score threshold to snooze/update_priority', () => {
    const res = validateJudgment(
      output([
        action({ taskId: 't1', type: 'snooze', score: 2, snoozeDays: 3 }),
        action({ taskId: 't2', type: 'update_priority', score: 1, priority: 4 }),
      ]),
      { surfacingThreshold: 7, validTaskIds },
    );
    expect(res.actions).toHaveLength(2);
    expect(res.dropped).toHaveLength(0);
  });

  it('caps snoozes per tick (default 5)', () => {
    const snoozes = [1, 2, 3, 4, 5, 6, 7].map((i) =>
      action({ taskId: `t${i}`, type: 'snooze', score: 5, snoozeDays: 2 }),
    );
    const res = validateJudgment(output(snoozes), { surfacingThreshold: 7, validTaskIds });
    expect(res.actions).toHaveLength(5);
    expect(res.dropped.map((d) => d.reason)).toEqual(['snooze_cap', 'snooze_cap']);
  });

  it('caps notify actions at one per tick, exempting tasks due within 24h', () => {
    const res = validateJudgment(
      output([
        action({ taskId: 't1', score: 9 }),
        action({ taskId: 't2', score: 8 }),
        action({ taskId: 't3', score: 8 }),
      ]),
      { surfacingThreshold: 7, validTaskIds, dueSoonTaskIds: new Set(['t3']) },
    );
    expect(res.actions.map((a) => a.taskId)).toEqual(['t1', 't3']);
    expect(res.dropped).toEqual([{ taskId: 't2', type: 'notify', reason: 'notify_cap' }]);
  });

  it('drops actions referencing task ids that were not candidates', () => {
    const res = validateJudgment(output([action({ taskId: 'hallucinated', score: 9 })]), {
      surfacingThreshold: 7,
      validTaskIds,
    });
    expect(res.actions).toHaveLength(0);
    expect(res.dropped).toEqual([
      { taskId: 'hallucinated', type: 'notify', reason: 'unknown_task' },
    ]);
  });

  // Loop MEDIUM finding: two notify actions for the same task would otherwise
  // fire two banners and bump surface_count by 2 (loop/actions.ts has no
  // dedup of its own) — dedupe by (taskId, type), keeping the highest score.
  it('dedupes two notify actions for the same task, keeping the higher score', () => {
    const res = validateJudgment(
      output([
        action({ taskId: 't1', score: 6, message: 'low' }),
        action({ taskId: 't1', score: 9, message: 'high' }),
      ]),
      { surfacingThreshold: 5, validTaskIds },
    );
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]).toMatchObject({ taskId: 't1', score: 9, message: 'high' });
    expect(res.dropped).toEqual([{ taskId: 't1', type: 'notify', reason: 'duplicate' }]);
  });

  it('keeps the first of two same-task/same-type actions when scores tie', () => {
    const res = validateJudgment(
      output([
        action({ taskId: 't1', score: 8, message: 'first' }),
        action({ taskId: 't1', score: 8, message: 'second' }),
      ]),
      { surfacingThreshold: 5, validTaskIds },
    );
    expect(res.actions).toHaveLength(1);
    expect(res.actions[0]!.message).toBe('first');
    expect(res.dropped).toEqual([{ taskId: 't1', type: 'notify', reason: 'duplicate' }]);
  });

  it('does not dedupe a notify + snooze for the same task — different action kinds', () => {
    const res = validateJudgment(
      output([
        action({ taskId: 't1', score: 8, type: 'notify' }),
        action({ taskId: 't1', score: 4, type: 'snooze', snoozeDays: 2 }),
      ]),
      { surfacingThreshold: 5, validTaskIds },
    );
    expect(res.actions.map((a) => a.type)).toEqual(['notify', 'snooze']);
    expect(res.dropped).toEqual([]);
  });

  it('duplicate dedup runs before the notify cap so a dropped duplicate does not eat the budget', () => {
    // t1 has two notify actions (a duplicate); t2 has one, both due-soon-exempt
    // so both would otherwise count against the one-notify-per-tick cap.
    const res = validateJudgment(
      output([
        action({ taskId: 't1', score: 9 }),
        action({ taskId: 't1', score: 5 }),
        action({ taskId: 't2', score: 7 }),
      ]),
      { surfacingThreshold: 5, validTaskIds },
    );
    expect(res.actions.map((a) => a.taskId)).toEqual(['t1']);
    expect(res.dropped).toEqual([
      { taskId: 't1', type: 'notify', reason: 'duplicate' },
      { taskId: 't2', type: 'notify', reason: 'notify_cap' },
    ]);
  });
});

describe('JUDGMENT_SYSTEM — dismissed vs expired (finding 4)', () => {
  it('teaches the model to treat an explicit dismissal as a strong stop signal', () => {
    expect(JUDGMENT_SYSTEM).toMatch(/"dismissed".*strong/s);
  });

  it('teaches the model that an expired-unanswered surface is weak evidence, not a dismissal', () => {
    expect(JUDGMENT_SYSTEM).toMatch(/"expired".*weak evidence/s);
    expect(JUDGMENT_SYSTEM).toContain('NOT a dismissal');
  });
});

describe('applyHourlyBudget', () => {
  it('budget partially consumed: 1 of 2 used ⇒ only 1 of 2 notifies passes, lowest score dropped', () => {
    const res = applyHourlyBudget(
      [action({ taskId: 't1', score: 9 }), action({ taskId: 't2', score: 5 })],
      { remainingBudget: 1 },
    );
    expect(res.actions.map((a) => a.taskId)).toEqual(['t1']);
    expect(res.dropped).toEqual([{ taskId: 't2', type: 'notify', reason: 'hourly_budget' }]);
  });

  it('budget free: both notifies pass untouched', () => {
    const actions = [action({ taskId: 't1', score: 9 }), action({ taskId: 't2', score: 5 })];
    const res = applyHourlyBudget(actions, { remainingBudget: 2 });
    expect(res.actions).toEqual(actions);
    expect(res.dropped).toEqual([]);
  });

  it('budget exhausted: 0 remaining ⇒ all notifies dropped', () => {
    const res = applyHourlyBudget(
      [action({ taskId: 't1', score: 9 }), action({ taskId: 't2', score: 5 })],
      { remainingBudget: 0 },
    );
    expect(res.actions).toEqual([]);
    expect(res.dropped).toEqual([
      { taskId: 't1', type: 'notify', reason: 'hourly_budget' },
      { taskId: 't2', type: 'notify', reason: 'hourly_budget' },
    ]);
  });

  it('a negative remaining budget is clamped to zero', () => {
    const res = applyHourlyBudget([action({ taskId: 't1', score: 9 })], { remainingBudget: -3 });
    expect(res.actions).toEqual([]);
    expect(res.dropped).toEqual([{ taskId: 't1', type: 'notify', reason: 'hourly_budget' }]);
  });

  it('does not count snooze/update_priority actions against the notify budget', () => {
    const res = applyHourlyBudget(
      [
        action({ taskId: 't1', type: 'snooze', score: 9, snoozeDays: 2 }),
        action({ taskId: 't2', score: 8 }),
      ],
      { remainingBudget: 1 },
    );
    expect(res.actions.map((a) => a.taskId)).toEqual(['t1', 't2']);
    expect(res.dropped).toEqual([]);
  });

  it('exempts checklist/commitment candidate ids from the budget', () => {
    const res = applyHourlyBudget(
      [
        action({ taskId: 't1', score: 9 }),
        action({ taskId: 't2', score: 8 }),
        action({ taskId: 'checklist:c1', score: 5 }),
      ],
      { remainingBudget: 1, exemptTaskIds: new Set(['checklist:c1']) },
    );
    expect(res.actions.map((a) => a.taskId)).toEqual(['t1', 'checklist:c1']);
    expect(res.dropped).toEqual([{ taskId: 't2', type: 'notify', reason: 'hourly_budget' }]);
  });
});

describe('buildJudgmentPrompt', () => {
  it('embeds the context and current time', () => {
    const prompt = buildJudgmentPrompt('## Candidates (1)\n### Task abc', '2026-07-03T10:00:00Z');
    expect(prompt).toContain('### Task abc');
  });

  // H1 (2026-08-21 investigation): a bare UTC "Current time" line let the model
  // read digits as local wall-clock and misjudge imminence for negative-offset
  // users — see chat/commitments.ts formatLocalIsoWithOffsetAndWeekday.
  it('renders "Current time" as LOCAL wall-clock with numeric offset + weekday, never a bare UTC instant', () => {
    const now = '2026-07-03T10:00:00Z';
    const tz = 'America/Argentina/Buenos_Aires';
    const prompt = buildJudgmentPrompt('## Candidates (1)\n### Task abc', now, tz);
    expect(prompt).toContain(`Current time: ${formatLocalIsoWithOffsetAndWeekday(now, tz)}`);
    expect(prompt).not.toContain('Current time: 2026-07-03T10:00:00Z');
  });
});

describe('runJudgment', () => {
  it('records the ai_decision with the tick id and recovers its id', async () => {
    const db = new Db(':memory:');
    const llm = new MockLlmClient({
      db,
      modelFor: makeModelResolver(db),
      record: (input) => db.insertAiDecision(input).id,
    });
    const { output: out, decisionId } = await runJudgment(
      { llm, db },
      { context: '## Candidates (0)', now: '2026-07-03T10:00:00Z', tickId: 'tick-42' },
    );
    expect(out.actions).toEqual([]);
    expect(decisionId).not.toBeNull();
    const decision = db.getAiDecision(decisionId!);
    expect(decision?.kind).toBe('judgment');
    expect(decision?.relatedRef).toBe('tick-42');
    db.close();
  });
});
