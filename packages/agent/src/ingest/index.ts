import type { SourceId } from '@botty/shared';
import type { AgentContext } from '../context.js';
import { createAdapters } from './adapters/index.js';
import { createScheduler } from './scheduler.js';

export type { AdapterMap, RealAdapterDeps, SourceAdapter } from './adapters/index.js';
export { createAdapters, createSimAdapter } from './adapters/index.js';
export { HEURISTIC_PATTERNS, hasSignal, matchSignals } from './heuristics.js';
export type { HeuristicPattern, SignalKind } from './heuristics.js';
export { processEvent, runFunnel } from './funnel.js';
export type { FunnelCtx } from './util.js';
export { handleGcal, handleTaskSource, meetingPrepCandidates } from './structured.js';
export type { MeetingPrepCandidate } from './structured.js';
export { createScheduler, sinceKey } from './scheduler.js';
export type { SchedulerCtx, SourceScheduler } from './scheduler.js';

/** Ingestion subsystem: source polling scheduler + funnel. See docs/specs/ingestion.md. */
export interface Ingest {
  /** Start the per-source poll scheduler. */
  start(): void;
  stop(): void;
  /** Run one immediate check of a source; resolves to the source_check_log id. */
  checkNow(source: SourceId): Promise<string>;
}

/** Wire adapters (per BOTTY_MODE) + scheduler + funnel from the agent core.
 * Pass `adapters` to share one AdapterMap with other consumers (backfill). */
export function createIngest(
  ctx: AgentContext,
  adapters = createAdapters(ctx.env, { db: ctx.db, bus: ctx.bus }),
): Ingest {
  return createScheduler({ db: ctx.db, llm: ctx.llm, bus: ctx.bus, config: ctx.config }, adapters);
}
