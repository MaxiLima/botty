import { SOURCES, type SourceEvent, type SourceId } from '@botty/shared';
import type { AgentEnv } from '../../env.js';
import { createSimAdapter } from './sim.js';

export { createSimAdapter } from './sim.js';

/** Deterministic fetch boundary — the only thing that talks to a source. */
export interface SourceAdapter {
  readonly source: SourceId;
  /** Fetch events newer than `since` (ISO). Must be idempotent; dedup happens downstream. */
  fetch(since: string | null): Promise<SourceEvent[]>;
}

export type AdapterMap = Record<SourceId, SourceAdapter>;

/** Real drivers land in M4 — until then real mode fails loudly per check. */
function createRealAdapterStub(source: SourceId): SourceAdapter {
  return {
    source,
    async fetch(): Promise<SourceEvent[]> {
      throw new Error(`real ${source} driver not implemented yet (M4) — run with BOTTY_MODE=sim`);
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
