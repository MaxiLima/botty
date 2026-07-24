import { SOURCES, type SourceEvent, type SourceId } from '@botty/shared';
import type { AgentEnv } from '../../env.js';
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

/** Real drivers land in M4 — until then real mode fails loudly per check. */
function createRealAdapterStub(source: SourceId): SourceAdapter {
  return {
    source,
    async fetch(): Promise<SourceEvent[]> {
      throw new Error(`real ${source} driver not implemented yet (M4) — run with BOTTY_MODE=sim`);
    },
    async fetchHistory(): Promise<HistoryPage> {
      throw new Error(`real ${source} history driver not implemented yet (M4) — run with BOTTY_MODE=sim`);
    },
  };
}

/** One adapter per source, family selected by BOTTY_MODE. */
export function createAdapters(env: Pick<AgentEnv, 'mode' | 'simUrl'>): AdapterMap {
  return Object.fromEntries(
    SOURCES.map((source) => [
      source,
      env.mode === 'sim' ? createSimAdapter(source, env.simUrl) : createRealAdapterStub(source),
    ]),
  ) as AdapterMap;
}
