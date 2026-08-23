import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL_PRICING } from '@botty/shared';
import { Db, type CostRollupRow } from '../../src/db/index.js';
import { buildCostsReport, pricingWithOverrides } from '../../src/server/costs.js';

const NOW = new Date('2026-07-08T15:00:00.000Z');
const PRICING = {
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Defaults to the "nothing recorded" shape — every token in the bucket still needs
 * the USD/MTok estimate, matching how costRollup() looks before any call carries an
 * SDK total_cost_usd (all pre-migration-008 rows, forever). unrecorded* mirror the
 * (possibly overridden) token counts unless the caller opts into a partially- or
 * fully-recorded bucket by passing recordedCostUsd/recordedCostCalls/unrecorded* directly.
 */
function row(partial: Partial<CostRollupRow>): CostRollupRow {
  const base = {
    kind: 'chat_turn',
    model: 'claude-sonnet-5',
    day: '2026-07-08',
    calls: 1,
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    recordedCostUsd: 0,
    recordedCostCalls: 0,
    ...partial,
  };
  return {
    unrecordedInputTokens: base.inputTokens,
    unrecordedOutputTokens: base.outputTokens,
    unrecordedCacheReadInputTokens: base.cacheReadInputTokens,
    unrecordedCacheCreationInputTokens: base.cacheCreationInputTokens,
    ...base,
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

  it('buckets distill calls under the backfill category', () => {
    const report = buildCostsReport([row({ kind: 'distill', model: 'claude-haiku-4-5' })], PRICING, NOW);
    expect(report.windows.allTime.byCategory.backfill!.costUsd).toBeCloseTo(6);
    expect(report.windows.allTime.byCategory.other!.costUsd).toBe(0);
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

  it('prices cache reads and cache-creation writes at their own (non-input) rates', () => {
    // sonnet-5 @ $3/MTok in: default cache rates are 0.1x read ($0.3) and 1.25x creation ($3.75).
    const report = buildCostsReport(
      [
        row({
          model: 'claude-sonnet-5',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 1_000_000,
          cacheCreationInputTokens: 1_000_000,
        }),
      ],
      PRICING,
      NOW,
    );
    // 1M cache-read tokens @ $0.3/MTok + 1M cache-creation tokens @ $3.75/MTok = $4.05,
    // nowhere near the $3 (plain input rate) it would be without cache-aware pricing.
    expect(report.windows.allTime.totals.costUsd).toBeCloseTo(4.05);
    expect(report.windows.allTime.totals.cacheReadInputTokens).toBe(1_000_000);
    expect(report.windows.allTime.totals.cacheCreationInputTokens).toBe(1_000_000);
    const resolved = report.pricing['claude-sonnet-5']!;
    expect(resolved.inputPerMTok).toBe(3);
    expect(resolved.outputPerMTok).toBe(15);
    expect(resolved.cacheReadPerMTok).toBeCloseTo(0.3);
    expect(resolved.cacheCreationPerMTok).toBeCloseTo(3.75);
  });

  it('a row with NULL cache columns (cacheRead/cacheCreation both 0) prices exactly as before', () => {
    // This is the existing "prices tokens per model" case in disguise — cache tokens
    // absent must contribute nothing, so the estimate is exactly input+output at their
    // plain rates, unchanged from pre-migration-008 behavior.
    const report = buildCostsReport([row({ model: 'claude-sonnet-5' })], PRICING, NOW);
    expect(report.windows.allTime.totals.costUsd).toBeCloseTo(18);
  });

  it('prefers a recorded SDK total_cost_usd over the computed estimate', () => {
    const report = buildCostsReport(
      [
        row({
          model: 'claude-sonnet-5',
          calls: 1,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          recordedCostUsd: 99, // deliberately far from the $18 the tokens would price at
          recordedCostCalls: 1,
          unrecordedInputTokens: 0,
          unrecordedOutputTokens: 0,
          unrecordedCacheReadInputTokens: 0,
          unrecordedCacheCreationInputTokens: 0,
        }),
      ],
      PRICING,
      NOW,
    );
    expect(report.windows.allTime.totals.costUsd).toBeCloseTo(99);
    expect(report.windows.allTime.totals.unpricedCalls).toBe(0);
    expect(report.windows.allTime.byModel[0]).toMatchObject({ model: 'claude-sonnet-5', priced: true });
  });

  it('sums a recorded cost alongside an estimate for the unrecorded remainder in the same bucket', () => {
    // e.g. a UTC day straddling the migration-008 deploy: one old row (no total_cost_usd)
    // and one new row (recorded) land in the same (kind, model, day) bucket.
    const report = buildCostsReport(
      [
        row({
          model: 'claude-sonnet-5',
          calls: 2,
          inputTokens: 2_000_000, // 1M recorded + 1M unrecorded
          outputTokens: 0,
          recordedCostUsd: 5, // the recorded call's actual SDK cost
          recordedCostCalls: 1,
          unrecordedInputTokens: 1_000_000, // only the unrecorded call's tokens
          unrecordedOutputTokens: 0,
          unrecordedCacheReadInputTokens: 0,
          unrecordedCacheCreationInputTokens: 0,
        }),
      ],
      PRICING,
      NOW,
    );
    // $5 recorded + (1M input @ $3/MTok) estimated for the other call = $8, not
    // $6 (2M @ $3/MTok, which would double-count the recorded call's tokens).
    expect(report.windows.allTime.totals.costUsd).toBeCloseTo(8);
  });

  it('a model without a pricing entry still counts a recorded SDK cost (only unrecorded calls are unpriced)', () => {
    const report = buildCostsReport(
      [
        row({
          model: 'some-future-model',
          calls: 2,
          recordedCostUsd: 7,
          recordedCostCalls: 1,
          unrecordedInputTokens: 1_000_000,
          unrecordedOutputTokens: 1_000_000,
        }),
      ],
      PRICING,
      NOW,
    );
    expect(report.windows.allTime.totals.costUsd).toBeCloseTo(7);
    expect(report.windows.allTime.totals.unpricedCalls).toBe(1); // only the unrecorded call
    expect(report.windows.allTime.byModel[0]).toMatchObject({ model: 'some-future-model', priced: true });
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

  it('carries an explicit cache-rate override through untouched', () => {
    const pricing = pricingWithOverrides({
      'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.5, cacheCreationPerMTok: 2 },
    });
    expect(pricing['claude-sonnet-5']).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.5,
      cacheCreationPerMTok: 2,
    });
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

  it('splits recorded (SDK total_cost_usd) calls from unrecorded ones within the same bucket', () => {
    const db = new Db(':memory:');
    // A recorded call — carries cache tokens and its own SDK-computed cost.
    db.insertAiDecision({
      kind: 'chat_turn',
      input: {},
      model: 'claude-sonnet-5',
      inputTokens: 4,
      outputTokens: 20,
      cacheReadInputTokens: 8_000,
      cacheCreationInputTokens: 500,
      totalCostUsd: 0.0031,
    });
    // An unrecorded call in the same (kind, model, day) bucket — e.g. a pre-migration-008
    // row, or any call whose stream died before a 'result' message arrived.
    db.insertAiDecision({
      kind: 'chat_turn',
      input: {},
      model: 'claude-sonnet-5',
      inputTokens: 100,
      outputTokens: 50,
    });

    const rows = db.costRollup();
    db.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      calls: 2,
      inputTokens: 104,
      outputTokens: 70,
      cacheReadInputTokens: 8_000,
      cacheCreationInputTokens: 500,
      recordedCostCalls: 1,
      unrecordedInputTokens: 100,
      unrecordedOutputTokens: 50,
      unrecordedCacheReadInputTokens: 0,
      unrecordedCacheCreationInputTokens: 0,
    });
    expect(rows[0]!.recordedCostUsd).toBeCloseTo(0.0031);
  });
});
