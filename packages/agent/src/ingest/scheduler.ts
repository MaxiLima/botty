import { SOURCES, type SourceEvent, type SourceId } from '@botty/shared';
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
  // Test gap closed (scheduler concurrency): a manual `checkNow` landing while
  // a scheduled tick for the SAME source is already mid-flight used to race
  // on `since` — each run reads the watermark at ITS OWN start, so whichever
  // run finishes last simply overwrites it, silently reverting any forward
  // progress the other run made (H5 paging made this worse: a truncated run's
  // carefully-computed partial-drain watermark could be clobbered back by a
  // concurrent run that started from the older floor). One in-flight run per
  // source, shared rather than raced.
  const inFlight = new Map<SourceId, Promise<string>>();

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
      const adapter = adapters[source];
      // Paging-aware adapters (gmail today) report the safe watermark
      // themselves — never past mail they didn't fetch — instead of us
      // blindly assuming "check succeeded ⇒ fully drained ⇒ jump to
      // startedAt" (H5: that assumption is what silently dropped backlog
      // past the first MAX_EVENTS_PER_FETCH messages). Adapters without
      // fetchWindow (sim/stub/gcal) keep the old behavior.
      const result: { events: SourceEvent[]; nextSince: string; truncated: boolean } = adapter.fetchWindow
        ? await adapter.fetchWindow(since)
        : { events: await adapter.fetch(since), nextSince: startedAt, truncated: false };
      eventsFetched = result.events.length;
      for (const event of result.events) {
        const outcome = await processEvent(ctx, event);
        if (outcome !== 'DUPLICATE') eventsNew += 1;
      }
      // Only a fully successful check advances `since` (refetch is dedup-safe).
      ctx.db.setSetting(sinceKey(source), result.nextSince);
      if (result.truncated) {
        console.warn(
          `[ingest] ${source}: window not fully drained this check (page cap hit) — ` +
            `watermark pinned, will keep draining on the next poll`,
        );
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const check = ctx.db.insertSourceCheck({ source, eventsFetched, eventsNew, error });
    ctx.bus.broadcast({ type: 'source.checked', payload: { check } });
    return check.id;
  }

  /** Run `source`'s check, joining an already in-flight run instead of racing it. */
  function guardedRunCheck(source: SourceId): Promise<string> {
    const existing = inFlight.get(source);
    if (existing) return existing;
    const p = runCheck(source).finally(() => {
      if (inFlight.get(source) === p) inFlight.delete(source);
    });
    inFlight.set(source, p);
    return p;
  }

  function schedule(source: SourceId, delayMs: number): void {
    if (!running) return;
    const timer = setTimeout(() => {
      void (async () => {
        // HARD working-hours gate: off-hours ⇒ zero work, zero log spam.
        if (isWithinWorkingHours(nowIso(), ctx.config.heartbeat())) {
          offHoursLogged = false;
          if (ctx.config.heartbeat().sources[source].enabled) {
            await guardedRunCheck(source); // runCheck never throws — errors land in source_check_log
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
      return guardedRunCheck(source);
    },
  };
}
