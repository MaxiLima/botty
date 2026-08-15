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

/** Deterministic fetch boundary — the only thing that talks to a source. */
export interface SourceAdapter {
  readonly source: SourceId;
  /** Fetch events newer than `since` (ISO). Must be idempotent; dedup happens downstream. */
  fetch(since: string | null): Promise<SourceEvent[]>;
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

/** Per-source explanation for real drivers still lacking a connector-backed driver.
 * Empty now that slack/gmail/gcal/jira/github all poll through claude.ai connectors;
 * the stub stays as a defensive fallback for any future source. */
const REAL_STUB_REASONS: Partial<Record<SourceId, string>> = {};

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
    return Object.fromEntries(SOURCES.map((s) => [s, failing(s)])) as Partial<
      Record<SourceId, SourceAdapter>
    >;
  }
  // Lazy imports keep the Agent SDK (and its cost) out of sim/mock runs.
  const [
    { createConnectorFetch },
    { createGmailAdapter },
    { createGcalAdapter },
    { createSlackAdapter },
    { createJiraAdapter },
    { createGithubAdapter },
    llm,
  ] = await Promise.all([
    import('./real/connector.js'),
    import('./real/gmail.js'),
    import('./real/gcal.js'),
    import('./real/slack.js'),
    import('./real/jira.js'),
    import('./real/github.js'),
    import('../../llm/index.js'),
  ]);
  const fetchViaConnector = createConnectorFetch({
    queryFn: await llm.loadSdkQueryFn(),
    modelFor: llm.makeModelResolver(deps.db),
    record: llm.makeDecisionRecorder(deps.db, deps.bus),
  });
  return {
    slack: createSlackAdapter(fetchViaConnector),
    gmail: createGmailAdapter(fetchViaConnector),
    gcal: createGcalAdapter(fetchViaConnector),
    jira: createJiraAdapter(fetchViaConnector),
    github: createGithubAdapter(fetchViaConnector),
  };
}

/**
 * One adapter per source, family selected by BOTTY_MODE. Real mode: every source
 * (slack/gmail/gcal/jira/github) polls through the user's claude.ai MCP connectors
 * (docs/specs/ingestion.md). The connector family loads lazily on first fetch so
 * startup never blocks on the Agent SDK import.
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
  let realFamily: Promise<Partial<Record<SourceId, SourceAdapter>>> | null = null;
  const real = (): Promise<Partial<Record<SourceId, SourceAdapter>>> =>
    (realFamily ??= loadRealAdapters(env, deps));
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
