import { describe, expect, it } from 'vitest';
import type { JudgmentOutput } from '@botty/shared';
import { Db } from '../../src/db/index.js';
import { MockLlmClient } from '../../src/llm/mock.js';
import { makeModelResolver } from '../../src/llm/index.js';
import {
  buildJudgmentPrompt,
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
});

describe('buildJudgmentPrompt', () => {
  it('embeds the context and current time', () => {
    const prompt = buildJudgmentPrompt('## Candidates (1)\n### Task abc', '2026-07-03T10:00:00Z');
    expect(prompt).toContain('Current time: 2026-07-03T10:00:00Z');
    expect(prompt).toContain('### Task abc');
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
