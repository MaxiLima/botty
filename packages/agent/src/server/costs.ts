// Costs report assembly: prices the ai_decisions usage rollup at per-model
// USD/MTok rates. Every LLM call botty makes lands in ai_decisions, so this is
// a complete picture of spend, split by activity (chat, source intake, …).
import {
  COST_CATEGORIES,
  COST_CATEGORY_BY_KIND,
  DEFAULT_MODEL_PRICING,
  type CostCategory,
  type CostTotals,
  type CostWindow,
  type CostsReport,
  type ModelPricing,
} from '@botty/shared';
import type { CostRollupRow } from '../db/index.js';

const DAY_MS = 86_400_000;
const REPORT_DAYS = 30;

/** Defaults merged with the `llm.pricing` settings value; malformed entries are ignored. */
export function pricingWithOverrides(override: unknown): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = { ...DEFAULT_MODEL_PRICING };
  if (override && typeof override === 'object' && !Array.isArray(override)) {
    for (const [model, p] of Object.entries(override as Record<string, unknown>)) {
      const entry = p as {
        inputPerMTok?: unknown;
        outputPerMTok?: unknown;
        cacheReadPerMTok?: unknown;
        cacheCreationPerMTok?: unknown;
      } | null;
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.inputPerMTok === 'number' &&
        typeof entry.outputPerMTok === 'number' &&
        Number.isFinite(entry.inputPerMTok) &&
        Number.isFinite(entry.outputPerMTok)
      ) {
        out[model] = {
          inputPerMTok: entry.inputPerMTok,
          outputPerMTok: entry.outputPerMTok,
          // Cache rates are optional on an override too — resolvePricing() below fills
          // in the standard 0.1x/1.25x multiplier when a hand-written entry omits them.
          ...(typeof entry.cacheReadPerMTok === 'number' && Number.isFinite(entry.cacheReadPerMTok)
            ? { cacheReadPerMTok: entry.cacheReadPerMTok }
            : {}),
          ...(typeof entry.cacheCreationPerMTok === 'number' && Number.isFinite(entry.cacheCreationPerMTok)
            ? { cacheCreationPerMTok: entry.cacheCreationPerMTok }
            : {}),
        };
      }
    }
  }
  return out;
}

/** Anthropic's list-price cache multipliers over a model's own inputPerMTok (5-minute TTL —
 * the only TTL botty's Agent SDK calls use; see DEFAULT_MODEL_PRICING for the source). */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_CREATION_MULTIPLIER = 1.25;

interface ResolvedModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheCreationPerMTok: number;
}

/** Fill in default cache rates for any pricing entry that didn't specify its own. */
function resolvePricing(pricing: Record<string, ModelPricing>): Record<string, ResolvedModelPricing> {
  const out: Record<string, ResolvedModelPricing> = {};
  for (const [model, p] of Object.entries(pricing)) {
    out[model] = {
      inputPerMTok: p.inputPerMTok,
      outputPerMTok: p.outputPerMTok,
      cacheReadPerMTok: p.cacheReadPerMTok ?? p.inputPerMTok * CACHE_READ_MULTIPLIER,
      cacheCreationPerMTok: p.cacheCreationPerMTok ?? p.inputPerMTok * CACHE_CREATION_MULTIPLIER,
    };
  }
  return out;
}

function emptyTotals(): CostTotals {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUsd: 0,
    unpricedCalls: 0,
  };
}

interface WindowAcc {
  totals: CostTotals;
  byCategory: Record<string, CostTotals>;
  byModel: Map<string, { totals: CostTotals; priced: boolean }>;
}

function emptyWindow(): WindowAcc {
  const byCategory: Record<string, CostTotals> = {};
  for (const c of COST_CATEGORIES) byCategory[c] = emptyTotals();
  return { totals: emptyTotals(), byCategory, byModel: new Map() };
}

function add(t: CostTotals, row: CostRollupRow, costUsd: number, unpricedCalls: number): void {
  t.calls += row.calls;
  t.inputTokens += row.inputTokens;
  t.outputTokens += row.outputTokens;
  t.cacheReadInputTokens += row.cacheReadInputTokens;
  t.cacheCreationInputTokens += row.cacheCreationInputTokens;
  t.costUsd += costUsd;
  t.unpricedCalls += unpricedCalls;
}

function finishWindow(w: WindowAcc): CostWindow {
  return {
    totals: w.totals,
    byCategory: w.byCategory,
    byModel: [...w.byModel.entries()]
      .map(([model, m]) => ({ model, priced: m.priced, ...m.totals }))
      .sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls),
  };
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function buildCostsReport(
  rows: CostRollupRow[],
  pricing: Record<string, ModelPricing>,
  now: Date = new Date(),
): CostsReport {
  const resolvedPricing = resolvePricing(pricing);
  const nowMs = now.getTime();
  const today = utcDay(nowMs);
  const since7 = utcDay(nowMs - 6 * DAY_MS);
  const since30 = utcDay(nowMs - (REPORT_DAYS - 1) * DAY_MS);

  const windows = {
    today: emptyWindow(),
    last7d: emptyWindow(),
    last30d: emptyWindow(),
    allTime: emptyWindow(),
  };
  const byDay = new Map<string, { calls: number; costUsd: number; byCategory: Record<string, number> }>();
  for (let i = 0; i < REPORT_DAYS; i++) {
    const byCategory: Record<string, number> = {};
    for (const c of COST_CATEGORIES) byCategory[c] = 0;
    byDay.set(utcDay(nowMs - (REPORT_DAYS - 1 - i) * DAY_MS), { calls: 0, costUsd: 0, byCategory });
  }

  for (const row of rows) {
    const price = resolvedPricing[row.model];
    const modelPriced = price !== undefined;
    // Calls that carried the SDK's own total_cost_usd are summed as-is — authoritative,
    // no per-model pricing entry required. Everything else is estimated at USD/MTok
    // rates (0 when the model has no pricing entry). recordedCostUsd covers the
    // recorded calls' tokens already, so the estimate only spans unrecorded* sums —
    // see costRollup()'s doc comment for why the split avoids double-counting.
    const estimatedUsd = modelPriced
      ? (row.unrecordedInputTokens * price.inputPerMTok +
          row.unrecordedOutputTokens * price.outputPerMTok +
          row.unrecordedCacheReadInputTokens * price.cacheReadPerMTok +
          row.unrecordedCacheCreationInputTokens * price.cacheCreationPerMTok) /
        1e6
      : 0;
    const costUsd = row.recordedCostUsd + estimatedUsd;
    // Unpriced only covers calls with neither a recorded SDK cost nor a priced model —
    // those are the ones actually contributing nothing to costUsd.
    const unrecordedCalls = row.calls - row.recordedCostCalls;
    const unpricedCalls = modelPriced ? 0 : unrecordedCalls;
    // "priced" for the byModel row/UI: true whenever costUsd is a real figure, even
    // without a pricing-table entry (e.g. every call recorded its own total_cost_usd).
    const priced = modelPriced || row.recordedCostCalls > 0;
    const category: CostCategory = COST_CATEGORY_BY_KIND[row.kind] ?? 'other';

    const applies: WindowAcc[] = [windows.allTime];
    if (row.day >= since30) applies.push(windows.last30d);
    if (row.day >= since7) applies.push(windows.last7d);
    if (row.day === today) applies.push(windows.today);
    for (const w of applies) {
      add(w.totals, row, costUsd, unpricedCalls);
      add(w.byCategory[category]!, row, costUsd, unpricedCalls);
      let m = w.byModel.get(row.model);
      if (!m) {
        m = { totals: emptyTotals(), priced };
        w.byModel.set(row.model, m);
      }
      m.priced = m.priced || priced;
      add(m.totals, row, costUsd, unpricedCalls);
    }

    const day = byDay.get(row.day);
    if (day) {
      day.calls += row.calls;
      day.costUsd += costUsd;
      day.byCategory[category] = (day.byCategory[category] ?? 0) + costUsd;
    }
  }

  return {
    generatedAt: now.toISOString(),
    windows: {
      today: finishWindow(windows.today),
      last7d: finishWindow(windows.last7d),
      last30d: finishWindow(windows.last30d),
      allTime: finishWindow(windows.allTime),
    },
    byDay: [...byDay.entries()].map(([date, d]) => ({ date, ...d })),
    // Effective rates, with any omitted cache multiplier resolved — see resolvePricing().
    pricing: resolvedPricing,
  };
}
