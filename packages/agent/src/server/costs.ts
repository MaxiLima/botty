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
      const entry = p as { inputPerMTok?: unknown; outputPerMTok?: unknown } | null;
      if (
        entry &&
        typeof entry === 'object' &&
        typeof entry.inputPerMTok === 'number' &&
        typeof entry.outputPerMTok === 'number' &&
        Number.isFinite(entry.inputPerMTok) &&
        Number.isFinite(entry.outputPerMTok)
      ) {
        out[model] = { inputPerMTok: entry.inputPerMTok, outputPerMTok: entry.outputPerMTok };
      }
    }
  }
  return out;
}

function emptyTotals(): CostTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0 };
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

function add(t: CostTotals, row: CostRollupRow, costUsd: number, priced: boolean): void {
  t.calls += row.calls;
  t.inputTokens += row.inputTokens;
  t.outputTokens += row.outputTokens;
  t.costUsd += costUsd;
  if (!priced) t.unpricedCalls += row.calls;
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
    const price = pricing[row.model];
    const priced = price !== undefined;
    const costUsd = priced
      ? (row.inputTokens * price.inputPerMTok + row.outputTokens * price.outputPerMTok) / 1e6
      : 0;
    const category: CostCategory = COST_CATEGORY_BY_KIND[row.kind] ?? 'other';

    const applies: WindowAcc[] = [windows.allTime];
    if (row.day >= since30) applies.push(windows.last30d);
    if (row.day >= since7) applies.push(windows.last7d);
    if (row.day === today) applies.push(windows.today);
    for (const w of applies) {
      add(w.totals, row, costUsd, priced);
      add(w.byCategory[category]!, row, costUsd, priced);
      let m = w.byModel.get(row.model);
      if (!m) {
        m = { totals: emptyTotals(), priced };
        w.byModel.set(row.model, m);
      }
      add(m.totals, row, costUsd, priced);
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
    pricing,
  };
}
