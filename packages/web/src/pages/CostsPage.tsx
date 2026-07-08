import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CostCategory, CostDayRow, CostTotals, CostWindow, CostsReport } from '@botty/shared';
import { COST_CATEGORIES, COST_CATEGORY_LABELS } from '@botty/shared';
import { api } from '../lib/api.js';
import { useOnReconnect, useWsEvent } from '../lib/ws.js';
import '../styles/costs.css';

// Fixed category → hue assignment (validated for CVD separation and ≥3:1
// contrast on --surface; order is the safety mechanism — don't shuffle).
const CATEGORY_COLOR: Record<CostCategory, string> = {
  chat: '#9085e9',
  intake: '#199e70',
  proactive: '#c98500',
  resolution: '#3987e5',
  briefing: '#d55181',
  other: '#d95926',
};

const WINDOWS = [
  { key: 'today', label: 'today' },
  { key: 'last7d', label: 'last 7 days' },
  { key: 'last30d', label: 'last 30 days' },
  { key: 'allTime', label: 'all time' },
] as const;
type WindowKey = (typeof WINDOWS)[number]['key'];

function fmtUsd(v: number): string {
  if (v >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toPrecision(2)}`; // $0.73, $0.50, $0.055
  if (v > 0) return `$${parseFloat(v.toPrecision(2))}`; // $0.0007
  return '$0.00';
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

/** Clean axis ceiling: 1/2/5 × 10^k just above v. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

export function CostsPage() {
  const [report, setReport] = useState<CostsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [win, setWin] = useState<WindowKey>('last30d');

  const refetch = useCallback(async () => {
    try {
      setError(null);
      const { report } = await api.costs();
      setReport(report);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);
  useOnReconnect(() => void refetch());

  // Every LLM call broadcasts decision.recorded — refresh, lightly debounced.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useWsEvent('decision.recorded', () => {
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => void refetch(), 1500);
  });
  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);

  if (error) return <div className="page-error">{error}</div>;
  if (!report) return <div className="col-empty">loading…</div>;

  const empty = report.windows.allTime.totals.calls === 0;
  const selected = report.windows[win];

  return (
    <div className="costs-page">
      <p className="costs-note">
        Estimated at Claude API list prices — botty runs on your subscription, so this is what the
        recorded usage <em>would</em> cost, not a bill. Days are UTC.
      </p>

      {empty ? (
        <div className="col-empty">no LLM usage recorded yet — costs will appear as botty works</div>
      ) : (
        <>
          <div className="stat-row">
            {WINDOWS.map(({ key, label }) => (
              <StatTile key={key} label={label} totals={report.windows[key].totals} />
            ))}
          </div>

          <DailyChart days={report.byDay} />

          <div className="win-row" role="tablist" aria-label="breakdown window">
            <span className="win-label">breakdown for</span>
            {WINDOWS.map(({ key, label }) => (
              <button
                key={key}
                role="tab"
                aria-selected={win === key}
                className={`win-btn ${win === key ? 'active' : ''}`}
                onClick={() => setWin(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <CategoryTable window={selected} />
          <ModelTable window={selected} pricing={report.pricing} />

          {selected.totals.unpricedCalls > 0 && (
            <p className="costs-note costs-warn">
              {selected.totals.unpricedCalls} call{selected.totals.unpricedCalls === 1 ? '' : 's'} used
              models without a pricing entry (
              {selected.byModel
                .filter((m) => !m.priced)
                .map((m) => m.model)
                .join(', ')}
              ) and are counted at $0 — add rates via the <code>llm.pricing</code> setting.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function StatTile({ label, totals }: { label: string; totals: CostTotals }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{fmtUsd(totals.costUsd)}</span>
      <span className="stat-sub">
        {totals.calls.toLocaleString('en-US')} calls · {fmtTokens(totals.inputTokens)} in ·{' '}
        {fmtTokens(totals.outputTokens)} out
      </span>
    </div>
  );
}

// ---------- daily stacked columns ----------

function DailyChart({ days }: { days: CostDayRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = useMemo(() => niceCeil(Math.max(...days.map((d) => d.costUsd))), [days]);
  const hasSpend = days.some((d) => d.costUsd > 0);
  const ticks = [1, 2, 3, 4].map((i) => (max * i) / 4);
  const hovered = hover !== null ? days[hover] : undefined;

  return (
    <div className="chart-card">
      <div className="chart-title">Daily spend — last 30 days</div>
      {!hasSpend ? (
        <div className="col-empty">no priced spend in the last 30 days</div>
      ) : (
        <>
          <div className="chart-plot" onMouseLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <div key={t} className="chart-grid" style={{ bottom: `${(t / max) * 100}%` }}>
                <span className="chart-tick">{fmtUsd(t)}</span>
              </div>
            ))}
            <div className="chart-cols">
              {days.map((d, i) => (
                <div
                  key={d.date}
                  className={`chart-cell ${hover === i ? 'hovered' : ''}`}
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  tabIndex={d.costUsd > 0 ? 0 : -1}
                >
                  <div className="chart-col">
                    {COST_CATEGORIES.filter((c) => d.byCategory[c]! > 0).map((c) => (
                      <div
                        key={c}
                        className="chart-seg"
                        style={{
                          height: `${(d.byCategory[c]! / max) * 100}%`,
                          background: CATEGORY_COLOR[c],
                        }}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            {hovered && hovered.costUsd > 0 && (
              <div
                className="chart-tooltip"
                style={{
                  left: `${((hover! + 0.5) / days.length) * 100}%`,
                  transform: hover! > days.length / 2 ? 'translateX(-105%)' : 'translateX(5%)',
                }}
              >
                <div className="tip-head">
                  <strong>{fmtUsd(hovered.costUsd)}</strong>
                  <span className="muted"> {hovered.date}</span>
                </div>
                {COST_CATEGORIES.filter((c) => hovered.byCategory[c]! > 0).map((c) => (
                  <div key={c} className="tip-row">
                    <span className="tip-key" style={{ background: CATEGORY_COLOR[c] }} />
                    <strong>{fmtUsd(hovered.byCategory[c]!)}</strong>
                    <span className="muted">{COST_CATEGORY_LABELS[c].toLowerCase()}</span>
                  </div>
                ))}
                <div className="tip-row muted">{hovered.calls} calls</div>
              </div>
            )}
          </div>
          <div className="chart-legend">
            {COST_CATEGORIES.map((c) => (
              <span key={c} className="legend-item">
                <span className="legend-swatch" style={{ background: CATEGORY_COLOR[c] }} />
                {COST_CATEGORY_LABELS[c].toLowerCase()}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------- breakdown tables ----------

function CategoryTable({ window: w }: { window: CostWindow }) {
  const total = w.totals.costUsd;
  const rows = COST_CATEGORIES.map((c) => ({ category: c, t: w.byCategory[c]! })).sort(
    (a, b) => b.t.costUsd - a.t.costUsd || b.t.calls - a.t.calls,
  );
  return (
    <div className="costs-card">
      <div className="chart-title">By activity</div>
      <table className="costs-table">
        <thead>
          <tr>
            <th>activity</th>
            <th className="meter-col" aria-hidden />
            <th className="num">cost</th>
            <th className="num">share</th>
            <th className="num">in</th>
            <th className="num">out</th>
            <th className="num">calls</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ category, t }) => (
            <tr key={category} className={t.calls === 0 ? 'zero' : ''}>
              <td>
                <span className="legend-swatch" style={{ background: CATEGORY_COLOR[category] }} />
                {COST_CATEGORY_LABELS[category]}
              </td>
              <td className="meter-col">
                <div className="meter-track">
                  <div
                    className="meter-fill"
                    style={{
                      width: total > 0 ? `${(t.costUsd / total) * 100}%` : 0,
                      background: CATEGORY_COLOR[category],
                    }}
                  />
                </div>
              </td>
              <td className="num">{fmtUsd(t.costUsd)}</td>
              <td className="num">{total > 0 ? `${Math.round((t.costUsd / total) * 100)}%` : '—'}</td>
              <td className="num">{fmtTokens(t.inputTokens)}</td>
              <td className="num">{fmtTokens(t.outputTokens)}</td>
              <td className="num">{t.calls.toLocaleString('en-US')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ModelTable({
  window: w,
  pricing,
}: {
  window: CostWindow;
  pricing: CostsReport['pricing'];
}) {
  return (
    <div className="costs-card">
      <div className="chart-title">By model</div>
      {w.byModel.length === 0 ? (
        <div className="col-empty">no calls in this window</div>
      ) : (
        <table className="costs-table">
          <thead>
            <tr>
              <th>model</th>
              <th className="num">rate in/out ($/MTok)</th>
              <th className="num">cost</th>
              <th className="num">in</th>
              <th className="num">out</th>
              <th className="num">calls</th>
            </tr>
          </thead>
          <tbody>
            {w.byModel.map((m) => (
              <tr key={m.model}>
                <td className="mono">{m.model}</td>
                <td className="num">
                  {m.priced && pricing[m.model]
                    ? `${pricing[m.model]!.inputPerMTok} / ${pricing[m.model]!.outputPerMTok}`
                    : 'no pricing'}
                </td>
                <td className="num">{m.priced ? fmtUsd(m.costUsd) : '—'}</td>
                <td className="num">{fmtTokens(m.inputTokens)}</td>
                <td className="num">{fmtTokens(m.outputTokens)}</td>
                <td className="num">{m.calls.toLocaleString('en-US')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
