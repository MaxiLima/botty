import {
  BACKFILL_SOURCES,
  BackfillStateSchema,
  type BackfillSourceProgress,
  type BackfillStartRequest,
  type BackfillStartResponse,
  type BackfillState,
} from '@botty/shared';
import type { Bus } from '../bus/index.js';
import { nowIso, type Db } from '../db/index.js';
import type { HeartbeatConfig } from '../config/parse.js';
import type { AdapterMap } from '../ingest/adapters/index.js';
import type { LlmClient } from '../llm/types.js';
import { processHistoricalEvent } from './process.js';
import { runDistillPhase } from './distill.js';

export { processHistoricalEvent } from './process.js';
export { DISTILL_SOURCES, DISTILL_SYSTEM, buildDistillPrompt, runDistillPhase } from './distill.js';

/** Agent-owned settings key for the persisted state blob — deliberately NOT in
 * SETTABLE_SETTINGS_KEYS (server/routes.ts), like onboarding.completedAt. */
export const BACKFILL_STATE_KEY = 'backfill.state';

/** Events requested per fetchHistory page. */
const PAGE_LIMIT = 100;
/** Pause between pages so a long run never starves the event loop. */
const PAGE_PAUSE_MS = 50;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BackfillCtx {
  db: Db;
  llm: LlmClient;
  bus: Bus;
  config: { heartbeat(): HeartbeatConfig };
}

export interface Backfill {
  /** Launch a run (fire-and-forget). `alreadyRunning: true` when one is live. */
  start(opts: BackfillStartRequest): BackfillStartResponse;
  status(): BackfillState;
  /** Cooperative cancel — the run stops between pages/LLM calls. Idempotent. */
  cancel(): BackfillState;
}

const IDLE_STATE: BackfillState = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  window: null,
  sources: {},
  distill: {
    threadsSeen: 0,
    threadsDistilled: 0,
    callsUsed: 0,
    callCap: 0,
    decisionsCreated: 0,
    notesAdded: 0,
    errors: 0,
    done: false,
  },
};

const freshSourceProgress = (): BackfillSourceProgress => ({
  cursor: null,
  fetched: 0,
  newEvents: 0,
  duplicates: 0,
  done: false,
  error: null,
});

/**
 * One-shot, manual, context-only historical ingest (docs/specs/backfill.md).
 * Runs concurrently with live polling by design: raw_log UNIQUE(source,
 * external_id) makes overlap dedup-safe, and this module never reads or writes
 * the scheduler's `ingest.lastCheck.<source>` cursors. No working-hours gate —
 * backfill is a manual path, like checkNow/run-now.
 */
export function createBackfill(ctx: BackfillCtx, adapters: AdapterMap): Backfill {
  let running = false;
  let cancelRequested = false;

  function persist(state: BackfillState): void {
    ctx.db.setSetting(BACKFILL_STATE_KEY, state);
    ctx.bus.broadcast({ type: 'backfill.progress', payload: { state } });
  }

  function readState(): BackfillState {
    const raw = ctx.db.getSetting<unknown>(BACKFILL_STATE_KEY);
    const parsed = BackfillStateSchema.safeParse(raw);
    if (!parsed.success) return structuredClone(IDLE_STATE);
    const state = parsed.data;
    // A persisted 'running' with no live run means the agent crashed mid-backfill —
    // normalize lazily so status/resume see a terminal state.
    if (state.status === 'running' && !running) {
      state.status = 'error';
      state.finishedAt = state.finishedAt ?? nowIso();
      ctx.db.setSetting(BACKFILL_STATE_KEY, state);
    }
    return state;
  }

  async function run(state: BackfillState, requested: string[]): Promise<void> {
    const oldest = state.window!.oldest;
    for (const source of requested) {
      if (cancelRequested) break;
      const progress = state.sources[source]!;
      if (progress.done) continue; // resume: source already finished
      const adapter = adapters[source as keyof AdapterMap];
      if (!adapter?.fetchHistory) {
        progress.error = `${source} has no history driver`;
        progress.done = true;
        persist(state);
        continue;
      }
      if (!ctx.config.heartbeat().sources[source as keyof HeartbeatConfig['sources']]?.enabled) {
        progress.error = `${source} is disabled in heartbeat.md`;
        progress.done = true;
        persist(state);
        continue;
      }
      try {
        for (;;) {
          if (cancelRequested) break;
          const page = await adapter.fetchHistory({ cursor: progress.cursor, oldest, limit: PAGE_LIMIT });
          for (const event of page.events) {
            if (processHistoricalEvent(ctx, event) === 'new') progress.newEvents += 1;
            else progress.duplicates += 1;
          }
          progress.fetched += page.events.length;
          progress.cursor = page.nextCursor;
          if (!page.nextCursor) {
            progress.done = true;
            persist(state);
            break;
          }
          persist(state);
          await sleep(PAGE_PAUSE_MS);
        }
      } catch (err) {
        // Per-source failure (e.g. the real M4 stub) — record it, keep going.
        progress.error = err instanceof Error ? err.message : String(err);
        persist(state);
      }
    }

    if (!cancelRequested) {
      state.distill = await runDistillPhase(ctx, {
        sources: requested,
        callCap: state.distill.callCap,
        isCancelled: () => cancelRequested,
        onProgress: (p) => {
          state.distill = p;
          persist(state);
        },
      });
    }

    const sourceStates = Object.values(state.sources);
    const allFailed = sourceStates.length > 0 && sourceStates.every((s) => s.error !== null);
    state.status = cancelRequested ? 'cancelled' : allFailed ? 'error' : 'done';
    state.finishedAt = nowIso();
    persist(state);
  }

  return {
    start(opts) {
      if (running) return { started: false, alreadyRunning: true, state: readState() };

      const prior = readState();
      const resumable =
        opts.resume && prior.window !== null && (prior.status === 'error' || prior.status === 'cancelled');

      let state: BackfillState;
      let requested: string[];
      if (resumable) {
        state = prior;
        requested = Object.keys(state.sources);
        for (const p of Object.values(state.sources)) p.error = null; // errored sources retry
        state.distill.callCap = opts.maxLlmCalls;
        state.distill.done = false;
      } else {
        requested = [...(opts.sources ?? BACKFILL_SOURCES)];
        state = {
          ...structuredClone(IDLE_STATE),
          window: {
            days: opts.days,
            oldest: new Date(Date.now() - opts.days * 86_400_000).toISOString(),
          },
          sources: Object.fromEntries(requested.map((s) => [s, freshSourceProgress()])),
        };
        state.distill.callCap = opts.maxLlmCalls;
      }
      state.status = 'running';
      state.startedAt = nowIso();
      state.finishedAt = null;

      running = true;
      cancelRequested = false;
      persist(state);
      // Fire-and-forget (mirrors check-now): the HTTP caller polls GET /api/backfill.
      void run(state, requested)
        .catch((err) => {
          state.status = 'error';
          state.finishedAt = nowIso();
          persist(state);
          console.error('[botty] backfill run failed:', err);
        })
        .finally(() => {
          running = false;
        });

      return { started: true, state };
    },

    status() {
      return readState();
    },

    cancel() {
      if (running) cancelRequested = true;
      return readState();
    },
  };
}
