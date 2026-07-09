import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AiDecision, FunnelOutcome, RawLogRow, SourceCheckRow, SourceId, TickLogRow } from '@botty/shared';
import { SOURCES } from '@botty/shared';
import { api } from '../lib/api.js';
import { shortDateTime, timeAgo, tryParseJson } from '../lib/format.js';
import { useOnReconnect, useWsEvent } from '../lib/ws.js';
import { JsonViewer } from '../components/JsonViewer.js';
import { SourceIcon } from '../components/SourceIcon.js';
import '../styles/inspector.css';

const TABS = ['funnel', 'ticks', 'decisions', 'sources'] as const;
type Tab = (typeof TABS)[number];

export function InspectorPage() {
  const [tab, setTab] = useState<Tab>('funnel');
  return (
    <div className="inspector-page">
      <nav className="tab-bar">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === 'funnel' && <FunnelTab />}
      {tab === 'ticks' && <TicksTab />}
      {tab === 'decisions' && <DecisionsTab />}
      {tab === 'sources' && <SourcesTab />}
    </div>
  );
}

// ---------- Funnel ----------

const OUTCOME_CLASS: Record<FunnelOutcome, string> = {
  EXTRACTED: 'oc-extracted',
  UPSERTED: 'oc-extracted',
  NO_SIGNAL: 'oc-nosignal',
  CLASSIFIED_OUT: 'oc-classifiedout',
  INTERACTION_ONLY: 'oc-interaction',
  DUPLICATE: 'oc-duplicate',
  ERROR: 'oc-error',
};

function OutcomeChip({ outcome }: { outcome?: FunnelOutcome }) {
  if (!outcome) return <span className="outcome-chip oc-unknown">—</span>;
  return <span className={`outcome-chip ${OUTCOME_CLASS[outcome]}`}>{outcome}</span>;
}

function FunnelTab() {
  const [events, setEvents] = useState<RawLogRow[]>([]);
  const [source, setSource] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<AiDecision[]>([]);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      const [raw, dec] = await Promise.all([
        api.rawLog({ source: source || undefined, limit: 100 }),
        api.decisions({ limit: 300 }),
      ]);
      setEvents(raw.events);
      setDecisions(dec.decisions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [source]);

  useEffect(() => {
    void refetch();
  }, [refetch]);
  useOnReconnect(() => void refetch());
  useWsEvent('source.checked', () => void refetch());

  const sorted = useMemo(
    () => [...events].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)),
    [events],
  );

  const linkedDecisions = (ev: RawLogRow): AiDecision[] =>
    decisions.filter(
      (d) =>
        d.relatedRef !== null &&
        (d.relatedRef === ev.id || d.relatedRef === ev.externalId || d.relatedRef === `${ev.source}:${ev.externalId}`),
    );

  return (
    <div className="tab-body">
      <div className="filter-row">
        <select value={source} onChange={(e) => setSource(e.target.value)}>
          <option value="">all sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost btn-mini" onClick={() => void refetch()}>
          ↻ refresh
        </button>
        {error && <span className="page-error inline">{error}</span>}
      </div>
      <div className="row-list">
        {sorted.map((ev) => {
          const open = openId === ev.id;
          const linked = open ? linkedDecisions(ev) : [];
          return (
            <div key={ev.id} className={`log-row ${open ? 'open' : ''}`}>
              <button className="log-row-head" onClick={() => setOpenId(open ? null : ev.id)}>
                <SourceIcon source={ev.source} />
                <span className="log-kind">{ev.kind}</span>
                <span className="log-actor">{ev.actor ?? '—'}</span>
                <span className="log-body-preview">{ev.body.slice(0, 120)}</span>
                <OutcomeChip outcome={ev.outcome} />
                <span className="muted log-time" title={ev.occurredAt}>
                  {timeAgo(ev.occurredAt)}
                </span>
              </button>
              {open && (
                <div className="log-row-detail">
                  <JsonViewer data={ev} label="raw event" startOpen />
                  <h4 className="detail-h">
                    linked ai_decisions <span className="muted">({linked.length})</span>
                  </h4>
                  {linked.length === 0 && (
                    <div className="muted">none linked (heuristic gate may have skipped the LLM)</div>
                  )}
                  {linked.map((d) => (
                    <DecisionBlock key={d.id} d={d} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {sorted.length === 0 && <div className="col-empty">no raw events captured yet</div>}
      </div>
    </div>
  );
}

function DecisionBlock({ d }: { d: AiDecision }) {
  return (
    <div className="decision-block">
      <div className="decision-head">
        <span className={`kind-chip kind-${d.kind}`}>{d.kind}</span>
        <span className="muted">{d.model}</span>
        {d.latencyMs != null && <span className="muted">{d.latencyMs}ms</span>}
        {(d.inputTokens != null || d.outputTokens != null) && (
          <span className="muted">
            {d.inputTokens ?? '?'}→{d.outputTokens ?? '?'} tok
          </span>
        )}
        <span className="muted" title={d.createdAt}>
          {timeAgo(d.createdAt)} ago
        </span>
        {d.error && <span className="outcome-chip oc-error">ERROR</span>}
      </div>
      {d.error && <div className="page-error inline">{d.error}</div>}
      <JsonViewer data={d.inputJson} label="prompt / input" />
      <JsonViewer data={d.outputJson} label="output" />
    </div>
  );
}

// ---------- Ticks ----------

function TicksTab() {
  const [ticks, setTicks] = useState<TickLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ tick: TickLogRow; judgment?: AiDecision } | null>(null);
  const [running, setRunning] = useState(false);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      setTicks((await api.ticks(50)).ticks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);
  useOnReconnect(() => void refetch());
  useWsEvent('tick.completed', (p) => {
    setTicks((prev) => [p.tick, ...prev.filter((t) => t.id !== p.tick.id)]);
  });

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .tick(openId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [openId]);

  const runNow = async () => {
    setRunning(true);
    try {
      await api.runLoopNow();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const actionCount = (t: TickLogRow): number => {
    const a = tryParseJson(t.actionsJson);
    return Array.isArray(a) ? a.length : 0;
  };

  return (
    <div className="tab-body">
      <div className="filter-row">
        <button className="btn btn-mini" onClick={() => void runNow()} disabled={running}>
          ▶ run tick now
        </button>
        {error && <span className="page-error inline">{error}</span>}
      </div>
      <div className="row-list">
        {ticks.map((t) => {
          const open = openId === t.id;
          return (
            <div key={t.id} className={`log-row ${open ? 'open' : ''} ${t.error ? 'row-error' : ''}`}>
              <button className="log-row-head" onClick={() => setOpenId(open ? null : t.id)}>
                <span className="log-kind">{t.trigger}</span>
                <span className="tick-funnel">
                  {t.candidatesIn ?? '–'} in → {t.candidatesAfterRules ?? '–'} after rules
                </span>
                <span className="tick-actions">{actionCount(t)} actions</span>
                {t.error && <span className="outcome-chip oc-error">ERROR</span>}
                <span className="muted log-time" title={t.startedAt}>
                  {shortDateTime(t.startedAt)}
                </span>
              </button>
              {open && (
                <div className="log-row-detail">
                  {t.error && <div className="page-error inline">{t.error}</div>}
                  <h4 className="detail-h">rules-filter rejections</h4>
                  <JsonViewer data={detail?.tick.skippedJson ?? t.skippedJson} label="skipped / rejection log" startOpen />
                  <h4 className="detail-h">actions</h4>
                  <JsonViewer data={detail?.tick.actionsJson ?? t.actionsJson} label="actions taken" startOpen />
                  <h4 className="detail-h">judgment</h4>
                  {detail?.judgment ? (
                    <DecisionBlock d={detail.judgment} />
                  ) : (
                    <div className="muted">
                      {t.judgmentDecisionId ? 'loading judgment…' : 'no judgment ran (nothing passed the rules filter)'}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {ticks.length === 0 && <div className="col-empty">no ticks yet</div>}
      </div>
    </div>
  );
}

// ---------- Decisions ----------

const DECISION_KINDS = ['', 'chat', 'judgment', 'classification', 'extraction', 'briefing', 'seal'];

function DecisionsTab() {
  const [decisions, setDecisions] = useState<AiDecision[]>([]);
  const [kind, setKind] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      setDecisions((await api.decisions({ kind: kind || undefined, limit: 50 })).decisions);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [kind]);

  useEffect(() => {
    void refetch();
  }, [refetch]);
  useOnReconnect(() => void refetch());
  useWsEvent('decision.recorded', (p) => {
    if (kind && p.decision.kind !== kind) return;
    void refetch();
  });

  const loadMore = async () => {
    const last = decisions[decisions.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.decisions({ kind: kind || undefined, limit: 50, before: last.createdAt });
      setDecisions((prev) => {
        const known = new Set(prev.map((d) => d.id));
        return [...prev, ...res.decisions.filter((d) => !known.has(d.id))];
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="tab-body">
      <div className="filter-row">
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {DECISION_KINDS.map((k) => (
            <option key={k} value={k}>
              {k || 'all kinds'}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost btn-mini" onClick={() => void refetch()}>
          ↻ refresh
        </button>
        {error && <span className="page-error inline">{error}</span>}
      </div>
      <div className="row-list">
        {decisions.map((d) => (
          <div key={d.id} className="log-row open decision-row">
            <DecisionBlock d={d} />
          </div>
        ))}
        {decisions.length === 0 && <div className="col-empty">no decisions recorded</div>}
        {decisions.length > 0 && (
          <button className="load-earlier" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'loading…' : '↓ load more'}
          </button>
        )}
      </div>
    </div>
  );
}

// ---------- Sources ----------

function SourcesTab() {
  const [checks, setChecks] = useState<SourceCheckRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busySource, setBusySource] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      setError(null);
      setChecks((await api.sourceChecks(100)).checks);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);
  useOnReconnect(() => void refetch());
  useWsEvent('source.checked', (p) => {
    setChecks((prev) => [p.check, ...prev.filter((c) => c.id !== p.check.id)]);
  });

  const checkNow = async (source: SourceId) => {
    setBusySource(source);
    try {
      await api.checkSourceNow(source);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySource(null);
    }
  };

  const lastBySource = new Map<string, SourceCheckRow>();
  for (const c of checks) {
    const prev = lastBySource.get(c.source);
    if (!prev || c.checkedAt > prev.checkedAt) lastBySource.set(c.source, c);
  }

  return (
    <div className="tab-body">
      {error && <div className="page-error">{error}</div>}
      <div className="source-grid">
        {SOURCES.map((s) => {
          const last = lastBySource.get(s);
          return (
            <div key={s} className={`source-card ${last?.error ? 'row-error' : ''}`}>
              <div className="source-card-head">
                <SourceIcon source={s} />
                <b>{s}</b>
                <button
                  className="btn btn-mini"
                  disabled={busySource === s}
                  onClick={() => void checkNow(s)}
                >
                  {busySource === s ? '…' : '⟳ check now'}
                </button>
              </div>
              {last ? (
                <div className="source-card-meta">
                  <span>last: {timeAgo(last.checkedAt)} ago</span>
                  <span>
                    {last.eventsNew}/{last.eventsFetched} new
                  </span>
                  {last.error && <span className="page-error inline">{last.error}</span>}
                </div>
              ) : (
                <div className="muted">never checked</div>
              )}
            </div>
          );
        })}
      </div>
      <h4 className="detail-h">check log</h4>
      <table className="checks-table">
        <thead>
          <tr>
            <th>source</th>
            <th>checked</th>
            <th className="num">fetched</th>
            <th className="num">new</th>
            <th>error</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id} className={c.error ? 'row-error' : ''}>
              <td>
                <SourceIcon source={c.source} /> {c.source}
              </td>
              <td className="muted" title={c.checkedAt}>
                {shortDateTime(c.checkedAt)}
              </td>
              <td className="num">{c.eventsFetched}</td>
              <td className="num">{c.eventsNew}</td>
              <td className="err-cell">{c.error ?? ''}</td>
            </tr>
          ))}
          {checks.length === 0 && (
            <tr>
              <td colSpan={5} className="col-empty">
                no checks logged
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
