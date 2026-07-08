import { SOURCES, type SourceId } from '@botty/shared';
import type { ConfigManager } from '../config/index.js';
import { nowIso } from '../db/index.js';
import { isWithinWorkingHours } from '../loop/time.js';
import type { AdapterMap } from './adapters/index.js';
import { processEvent, retryErroredEvents } from './funnel.js';
import type { FunnelCtx } from './util.js';

/** Stagger between per-source first checks (~5 s apart per spec). */
const STAGGER_MS = 5_000;

/** settings key holding the last successful check ISO per source. */
export const sinceKey = (source: SourceId): string => `ingest.lastCheck.${source}`;

export interface SchedulerCtx extends FunnelCtx {
  config: Pick<ConfigManager, 'heartbeat'>;
}

export interface SourceScheduler {
  start(): void;
  stop(): void;
  /** Run one immediate check of a source; resolves to the source_check_log id. */
  checkNow(source: SourceId): Promise<string>;
}

/**
 * Polls each enabled source on its HEARTBEAT.md interval (SOURCE_INTERVALS_SIM /
 * _REAL defaults are baked into parseHeartbeat). Intervals + enabled flags are
 * re-read from config before every run, so hot-reload takes effect at the next
 * cycle. Polling ignores quiet hours (only *surfacing* respects them) but NOT
 * working hours: outside the working-hours window (or on inactive days)
 * scheduled polls are skipped entirely — no fetch, no source_check_log row —
 * with a single console line when entering the off window. `checkNow`
 * (manual) bypasses the gate.
 */
export function createScheduler(ctx: SchedulerCtx, adapters: AdapterMap): SourceScheduler {
  const timers = new Map<SourceId, NodeJS.Timeout>();
  let running = false;
  let offHoursLogged = false;

  async function runCheck(source: SourceId): Promise<string> {
    const since = ctx.db.getSetting<string>(sinceKey(source)) ?? null;
    const startedAt = nowIso();
    let eventsFetched = 0;
    let eventsNew = 0;
    let error: string | null = null;
    try {
      // Second-chance pass first: re-run extraction for raw events stamped
      // ERROR (e.g. transient LLM failure) — they are never refetched.
      const recovered = await retryErroredEvents(ctx, source);
      if (recovered > 0) console.log(`[ingest] ${source}: recovered ${recovered} ERROR event(s) on retry`);
      const events = await adapters[source].fetch(since);
      eventsFetched = events.length;
      for (const event of events) {
        const outcome = await processEvent(ctx, event);
        if (outcome !== 'DUPLICATE') eventsNew += 1;
      }
      // Only a fully successful check advances `since` (refetch is dedup-safe).
      ctx.db.setSetting(sinceKey(source), startedAt);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const check = ctx.db.insertSourceCheck({ source, eventsFetched, eventsNew, error });
    ctx.bus.broadcast({ type: 'source.checked', payload: { check } });
    return check.id;
  }

  function schedule(source: SourceId, delayMs: number): void {
    if (!running) return;
    const timer = setTimeout(() => {
      void (async () => {
        // HARD working-hours gate: off-hours ⇒ zero work, zero log spam.
        if (isWithinWorkingHours(nowIso(), ctx.config.heartbeat())) {
          offHoursLogged = false;
          if (ctx.config.heartbeat().sources[source].enabled) {
            await runCheck(source); // runCheck never throws — errors land in source_check_log
          }
        } else if (!offHoursLogged) {
          offHoursLogged = true;
          console.log('[ingest] outside working hours — source polls paused');
        }
        const intervalMin = Math.max(1, ctx.config.heartbeat().sources[source].intervalMin);
        schedule(source, intervalMin * 60_000);
      })();
    }, delayMs);
    timer.unref?.();
    timers.set(source, timer);
  }

  return {
    start() {
      if (running) return;
      running = true;
      SOURCES.forEach((source, i) => schedule(source, i * STAGGER_MS));
    },
    stop() {
      running = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
    checkNow(source: SourceId): Promise<string> {
      return runCheck(source);
    },
  };
}
