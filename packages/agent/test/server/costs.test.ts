import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_PRICING } from '@botty/shared';
import { Db, type CostRollupRow } from '../../src/db/index.js';
import { buildCostsReport, pricingWithOverrides } from '../../src/server/costs.js';

const NOW = new Date('2026-07-08T15:00:00.000Z');
const PRICING = {
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

function row(partial: Partial<CostRollupRow>): CostRollupRow {
  return {
    kind: 'chat_turn',
    model: 'claude-sonnet-5',
    day: '2026-07-08',
    calls: 1,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    ...partial,
  };
}

describe('buildCostsReport', () => {
  it('prices tokens per model and splits by category', () => {
    const report = buildCostsReport(
      [
        row({ kind: 'chat_turn', model: 'claude-sonnet-5' }), // 3 + 15 = $18
        row({ kind: 'classification', model: 'claude-haiku-4-5' }), // 1 + 5 = $6
        row({ kind: 'extraction', model: 'claude-haiku-4-5' }), // $6
        row({ kind: 'judgment', model: 'claude-sonnet-5' }), // $18
      ],
      PRICING,
      NOW,
    );
    expect(report.windows.allTime.totals.costUsd).toBeCloseTo(48);
    expect(report.windows.allTime.byCategory.chat!.costUsd).toBeCloseTo(18);
    expect(report.windows.allTime.byCategory.intake!.costUsd).toBeCloseTo(12);
    expect(report.windows.allTime.byCategory.proactive!.costUsd).toBeCloseTo(18);
    expect(report.windows.allTime.byCategory.resolution!.costUsd).toBe(0);
    expect(report.windows.allTime.byModel[0]).toMatchObject({
      model: 'claude-sonnet-5',
      costUsd: 36,
      priced: true,
    });
  });

  it('buckets by time window on UTC day boundaries', () => {
    const report = buildCostsReport(
      [
        row({ day: '2026-07-08' }), // today
        row({ day: '2026-07-02' }), // inside 7d (>= 2026-07-02)
        row({ day: '2026-07-01' }), // outside 7d, inside 30d
        row({ day: '2026-06-01' }), // outside 30d
      ],
      PRICING,
      NOW,
    );
    expect(report.windows.today.totals.calls).toBe(1);
    expect(report.windows.last7d.totals.calls).toBe(2);
    expect(report.windows.last30d.totals.calls).toBe(3);
    expect(report.windows.allTime.totals.calls).toBe(4);
    expect(report.windows.last7d.byModel[0]!.calls).toBe(2);
  });

  it('counts unknown models as unpriced ($0) and unknown kinds as other', () => {
    const report = buildCostsReport(
      [row({ kind: 'mystery', model: 'some-future-model', calls: 3 })],
      PRICING,
      NOW,
    );
    expect(report.windows.allTime.totals.costUsd).toBe(0);
    expect(report.windows.allTime.totals.unpricedCalls).toBe(3);
    expect(report.windows.allTime.byCategory.other!.calls).toBe(3);
    expect(report.windows.allTime.byModel[0]).toMatchObject({ model: 'some-future-model', priced: false });
  });

  it('emits a continuous zero-filled 30-day series, oldest first', () => {
    const report = buildCostsReport([row({ day: '2026-07-07' })], PRICING, NOW);
    expect(report.byDay).toHaveLength(30);
    expect(report.byDay[0]!.date).toBe('2026-06-09');
    expect(report.byDay[29]!.date).toBe('2026-07-08');
    const hit = report.byDay.find((d) => d.date === '2026-07-07')!;
    expect(hit.costUsd).toBeCloseTo(18);
    expect(hit.byCategory.chat).toBeCloseTo(18);
    expect(report.byDay.filter((d) => d.calls === 0)).toHaveLength(29);
  });
});

describe('pricingWithOverrides', () => {
  it('merges valid overrides over defaults and drops malformed entries', () => {
    const pricing = pricingWithOverrides({
      'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
      'custom-model': { inputPerMTok: 7, outputPerMTok: 70 },
      broken: { inputPerMTok: 'nope' },
    });
    expect(pricing['claude-sonnet-5']).toEqual({ inputPerMTok: 2, outputPerMTok: 10 });
    expect(pricing['custom-model']).toEqual({ inputPerMTok: 7, outputPerMTok: 70 });
    expect(pricing.broken).toBeUndefined();
    expect(pricing['claude-haiku-4-5']).toEqual(DEFAULT_MODEL_PRICING['claude-haiku-4-5']);
  });

  it('ignores non-object overrides', () => {
    expect(pricingWithOverrides(undefined)).toEqual(DEFAULT_MODEL_PRICING);
    expect(pricingWithOverrides('gibberish')).toEqual(DEFAULT_MODEL_PRICING);
    expect(pricingWithOverrides([1, 2])).toEqual(DEFAULT_MODEL_PRICING);
  });
});

describe('Db.costRollup', () => {
  it('groups ai_decisions by kind, model and UTC day, treating NULL tokens as 0', () => {
    const db = new Db(':memory:');
    db.insertAiDecision({
      kind: 'chat_turn',
      input: {},
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
    });
    db.insertAiDecision({
      kind: 'chat_turn',
      input: {},
      model: 'claude-sonnet-5',
      inputTokens: 10,
      outputTokens: null, // stream died before usage arrived
    });
    db.insertAiDecision({
      kind: 'classification',
      input: {},
      model: 'claude-haiku-4-5',
      inputTokens: 5,
      outputTokens: 5,
    });

    const rows = db.costRollup();
    db.close();

    expect(rows).toHaveLength(2);
    const chat = rows.find((r) => r.kind === 'chat_turn')!;
    expect(chat).toMatchObject({
      model: 'claude-sonnet-5',
      calls: 2,
      inputTokens: 110,
      outputTokens: 50,
    });
    expect(chat.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows.find((r) => r.kind === 'classification')).toMatchObject({ calls: 1, inputTokens: 5 });
  });
});
