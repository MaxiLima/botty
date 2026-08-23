import { SOURCES, type SourceEvent, type SourceId } from '@botty/shared';
import type { AgentEnv } from '../../env.js';
import type { Bus } from '../../bus/index.js';
import type { Db } from '../../db/index.js';
import { createSimAdapter } from './sim.js';

export { createSimAdapter } from './sim.js';

/** One page of historical events for backfill (newest-first). */
export interface HistoryPage {
  events: SourceEvent[];
  /** Adapter-opaque continuation cursor; null when history is exhausted. */
  nextCursor: string | null;
}

/**
 * Result of a watermark-aware fetch (see `fetchWindow` below): the events plus
 * the safe `since` to persist afterward, computed by the adapter itself.
 */
export interface FetchWindowResult {
  events: SourceEvent[];
  /**
   * Safe value for the caller to persist as the new watermark. Must never be
   * later than the oldest item the adapter didn't manage to fetch this check
   * — i.e. it may equal the check's start time when the window was fully
   * drained, but must stay pinned at (or behind) the floor that was searched
   * when paging was cut short, so nothing between the old watermark and that
   * floor is ever silently skipped.
   */
  nextSince: string;
  /** True when the check ended before the window was fully drained (hit the
   * per-check page cap) — some events for this window may remain unfetched. */
  truncated: boolean;
}

/** Deterministic fetch boundary — the only thing that talks to a source. */
export interface SourceAdapter {
  readonly source: SourceId;
  /** Fetch events newer than `since` (ISO). Must be idempotent; dedup happens downstream. */
  fetch(since: string | null): Promise<SourceEvent[]>;
  /**
   * Watermark-aware variant of `fetch`, for sources that may need to page
   * through a backlog larger than one connector call can return (H5): the
   * adapter computes the safe `since` to persist itself instead of the caller
   * assuming "check succeeded ⇒ fully drained ⇒ advance to now". Optional —
   * the scheduler falls back to `fetch` + advance-to-check-start when absent
   * (sim/stub adapters, and gcal, which ignores `since` altogether and always
   * re-lists its lookahead window).
   */
  fetchWindow?(since: string | null): Promise<FetchWindowResult>;
  /**
   * Backfill: page backwards through history, newest-first (docs/specs/backfill.md).
   * The cursor is adapter-opaque (sim: engine cursor; real M4: Slack cursor /
   * Gmail pageToken); `oldest` (ISO) bounds the window. Must be idempotent —
   * raw_log dedup makes refetching a page safe. Optional: an adapter without it
   * cannot backfill.
   */
  fetchHistory?(opts: { cursor: string | null; oldest: string; limit: number }): Promise<HistoryPage>;
}

export type AdapterMap = Record<SourceId, SourceAdapter>;

/** Per-source explanation for real drivers that still need user-supplied credentials. */
const REAL_STUB_REASONS: Partial<Record<SourceId, string>> = {
  slack: 'needs a Slack MCP server + bot token configured (no claude.ai Slack connector exists)',
  jira: 'needs a Jira API token configured',
  github: 'needs a GitHub token configured',
};

/** Sources without a credential-free real driver fail loudly per check. */
function createRealAdapterStub(source: SourceId): SourceAdapter {
  const reason = REAL_STUB_REASONS[source] ?? 'not implemented yet';
  return {
    source,
    async fetch(): Promise<SourceEvent[]> {
      throw new Error(`real ${source} driver ${reason} — disable it in heartbeat.md sources for now`);
    },
    async fetchHistory(): Promise<HistoryPage> {
      throw new Error(`real ${source} history driver ${reason}`);
    },
  };
}

/** Dependencies the real (connector-backed) adapter family needs. Optional so
 * sim-only consumers (and existing tests) can keep calling createAdapters(env). */
export interface RealAdapterDeps {
  db: Db;
  bus: Bus;
}

async function loadRealAdapters(
  env: Pick<AgentEnv, 'mockLlm'>,
  deps: RealAdapterDeps | undefined,
): Promise<Partial<Record<SourceId, SourceAdapter>>> {
  if (env.mockLlm || !deps) {
    const why = env.mockLlm
      ? 'BOTTY_MOCK_LLM is set — connector fetches need the real LLM'
      : 'adapter dependencies not wired';
    const failing = (source: SourceId): SourceAdapter => ({
      source,
      async fetch(): Promise<SourceEvent[]> {
        throw new Error(`real ${source} driver unavailable: ${why}`);
      },
    });
    return { gmail: failing('gmail'), gcal: failing('gcal') };
  }
  // Lazy imports keep the Agent SDK (and its cost) out of sim/mock runs.
  const [{ createConnectorFetch }, { createGmailAdapter }, { createGcalAdapter }, llm] = await Promise.all([
    import('./real/connector.js'),
    import('./real/gmail.js'),
    import('./real/gcal.js'),
    import('../../llm/index.js'),
  ]);
  const fetchViaConnector = createConnectorFetch({
    queryFn: await llm.loadSdkQueryFn(),
    modelFor: llm.makeModelResolver(deps.db),
    record: llm.makeDecisionRecorder(deps.db, deps.bus),
  });
  return {
    gmail: createGmailAdapter(fetchViaConnector),
    gcal: createGcalAdapter(fetchViaConnector),
  };
}

/**
 * Wrap a one-shot loader in a lazy, memoizing cache — but only cache success.
 * (LOW finding: `realFamily ??=` used to cache a REJECTED promise forever,
 * since `??=` only reassigns on null/undefined and a rejected promise is
 * neither — one transient SDK import failure made every subsequent real poll
 * fail until restart.) A rejection clears the cache so the next call retries
 * `load()` instead of replaying the same rejection.
 */
export function makeRealFamilyLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached) {
      cached = load().catch((err: unknown) => {
        cached = null;
        throw err;
      });
    }
    return cached;
  };
}

/**
 * One adapter per source, family selected by BOTTY_MODE. Real mode: gmail/gcal
 * poll through the user's claude.ai MCP connectors (docs/specs/ingestion.md);
 * slack/jira/github stay credential-gated stubs. The connector family loads
 * lazily on first fetch so startup never blocks on the Agent SDK import.
 */
export function createAdapters(
  env: Pick<AgentEnv, 'mode' | 'simUrl' | 'mockLlm'>,
  deps?: RealAdapterDeps,
): AdapterMap {
  if (env.mode === 'sim') {
    return Object.fromEntries(
      SOURCES.map((source) => [source, createSimAdapter(source, env.simUrl)]),
    ) as AdapterMap;
  }
  const real = makeRealFamilyLoader(() => loadRealAdapters(env, deps));
  const lazy = (source: SourceId): SourceAdapter => ({
    source,
    async fetch(since: string | null): Promise<SourceEvent[]> {
      const adapter = (await real())[source] ?? createRealAdapterStub(source);
      return adapter.fetch(since);
    },
    async fetchHistory(opts): Promise<HistoryPage> {
      const adapter = (await real())[source] ?? createRealAdapterStub(source);
      if (!adapter.fetchHistory) {
        throw new Error(`real ${source} driver does not support backfill yet`);
      }
      return adapter.fetchHistory(opts);
    },
  });
  return Object.fromEntries(SOURCES.map((source) => [source, lazy(source)])) as AdapterMap;
}
