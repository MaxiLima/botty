import { nanoid } from 'nanoid';
import {
  SourceEventSchema,
  type Scenario,
  type ScenarioEvent,
  type SourceEvent,
  type SourceId,
} from '@botty/shared';
import type { InjectTemplate } from './templates.js';

/** A scenario event still waiting for the clock to reach its atMinute. */
interface PendingEvent {
  idx: number;
  event: ScenarioEvent;
}

/** A released event plus the wall-clock instant it became visible to pollers. */
interface ReleasedEvent {
  event: SourceEvent;
  /**
   * Wall-clock ms at release (inject or clock crossing atMinute). The agent's
   * `since` watermark is wall-clock time, so delivery filters on this — never
   * on `occurredAt`, which lives on the scenario timeline and can be far
   * behind (paused clock) or ahead (fast play) of wall time.
   */
  releasedAtMs: number;
}

/** Validated body of POST /control/inject (occurredAt/externalId optional). */
export interface InjectInput {
  source: SourceId;
  kind: string;
  externalId?: string;
  actor?: { handle?: string; email?: string; displayName?: string };
  /** 'outbound' simulates the user's own reply in a thread. */
  direction?: 'inbound' | 'outbound';
  text: string;
  threadRef?: string;
  occurredAt?: string;
  meta?: Record<string, unknown>;
}

/** One page of historical events for the agent's backfill (newest-first). */
export interface HistoryPage {
  events: SourceEvent[];
  /** Opaque continuation cursor; null when the page exhausted the history. */
  nextCursor: string | null;
}

export interface EngineState {
  scenario: { name: string; description?: string; eventCount: number; historyCount: number } | null;
  clock: {
    minutes: number;
    playing: boolean;
    speed: number;
    startedAt: string | null;
    simNow: string | null;
  };
  released: SourceEvent[];
  pending: Array<{
    atMinute: number;
    source: SourceId;
    kind: string;
    text: string;
    actor?: { handle?: string; email?: string; displayName?: string };
  }>;
  people: Scenario['people'];
}

const TICK_MS = 250;

/**
 * In-memory scenario engine. Holds the loaded scenario, a scenario clock
 * (minutes since scenario start), released events (already visible to the
 * agent's pollers) and pending events (waiting on the clock).
 */
export class SimEngine {
  private scenario: Scenario | null = null;
  private scenarioTemplates: InjectTemplate[] = [];
  /** Wall-clock ms at scenario load; anchor for atMinute → occurredAt. */
  private startedAtMs: number | null = null;
  private clockMinutes = 0;
  private playing = false;
  private speed = 60;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: PendingEvent[] = [];
  private released: ReleasedEvent[] = [];
  /**
   * Backfill history (scenario `history` block, atMinute < 0), materialized at
   * load and served only by historyFor() — never clock-released to pollers.
   * Kept newest-first with the original index as tie-break so cursors are stable.
   */
  private history: Array<{ idx: number; event: SourceEvent }> = [];
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  loadScenario(scenario: Scenario, templates: InjectTemplate[] = []): void {
    this.reset();
    this.scenario = scenario;
    this.scenarioTemplates = templates;
    this.startedAtMs = this.now();
    this.pending = scenario.events
      .map((event, idx) => ({ idx, event }))
      .sort((a, b) => a.event.atMinute - b.event.atMinute || a.idx - b.idx);
    this.history = scenario.history
      .map((event, idx) => ({ idx, event: this.toSourceEvent(event, idx, 'hist') }))
      .sort(
        (a, b) =>
          Date.parse(b.event.occurredAt) - Date.parse(a.event.occurredAt) || b.idx - a.idx,
      );
    this.releaseDue();
  }

  reset(): void {
    this.pause();
    this.scenario = null;
    this.scenarioTemplates = [];
    this.startedAtMs = null;
    this.clockMinutes = 0;
    this.speed = 60;
    this.pending = [];
    this.released = [];
    this.history = [];
  }

  play(speed?: number): void {
    if (speed !== undefined) {
      if (!Number.isFinite(speed) || speed <= 0) throw new Error('speed must be a positive number');
      this.speed = speed;
    }
    if (this.playing) return;
    this.playing = true;
    this.timer = setInterval(() => {
      this.clockMinutes += (this.speed * TICK_MS) / 60_000;
      this.releaseDue();
    }, TICK_MS);
    // Don't keep the process alive just for playback.
    this.timer.unref?.();
  }

  pause(): void {
    this.playing = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  advance(minutes: number): void {
    if (!Number.isFinite(minutes) || minutes < 0) throw new Error('minutes must be >= 0');
    this.clockMinutes += minutes;
    this.releaseDue();
  }

  /** Validate, absolutize and immediately release an injected event. */
  inject(input: InjectInput): SourceEvent {
    const meta: Record<string, unknown> = { ...(input.meta ?? {}) };
    const baseMs = this.simNowMs();
    if (input.source === 'gcal' && typeof meta.startAtMinute === 'number') {
      this.absolutizeGcalMeta(meta, baseMs);
    }
    const event = SourceEventSchema.parse({
      source: input.source,
      externalId: input.externalId ?? `inject-${nanoid(8)}`,
      kind: input.kind,
      actor: input.actor ?? {},
      direction: input.direction,
      text: input.text,
      threadRef: input.threadRef,
      occurredAt: input.occurredAt ?? new Date(baseMs).toISOString(),
      meta,
    });
    this.released.push({ event, releasedAtMs: this.now() });
    this.sortReleased();
    return event;
  }

  /**
   * Released events for one source, released (wall clock) strictly after
   * `since`. Filtering on release time — not `occurredAt` — keeps delivery
   * correct however the sim clock skews from wall time; refetch of an event
   * released in the same instant as a check is dedup-safe downstream.
   */
  eventsFor(source: SourceId, since?: string | null): SourceEvent[] {
    const sinceMs = since ? Date.parse(since) : Number.NaN;
    return this.released
      .filter((r) => {
        if (r.event.source !== source) return false;
        if (!Number.isNaN(sinceMs)) return r.releasedAtMs > sinceMs;
        return true;
      })
      .map((r) => r.event);
  }

  /**
   * Page backwards through the scenario's history block, newest first. The
   * cursor is engine-minted ("<occurredAtIso>|<idx>") and opaque to callers;
   * `oldest` (ISO) bounds the window. Never touches released/pending events.
   */
  historyFor(
    source: SourceId,
    opts: { cursor?: string | null; oldest?: string | null; limit: number },
  ): HistoryPage {
    const oldestMs = opts.oldest ? Date.parse(opts.oldest) : Number.NaN;
    let rows = this.history.filter((h) => {
      if (h.event.source !== source) return false;
      if (!Number.isNaN(oldestMs)) return Date.parse(h.event.occurredAt) >= oldestMs;
      return true;
    });
    if (opts.cursor) {
      const [cIso, cIdxRaw] = opts.cursor.split('|');
      const cMs = Date.parse(cIso ?? '');
      const cIdx = Number(cIdxRaw);
      if (Number.isNaN(cMs) || !Number.isFinite(cIdx)) throw new Error(`bad cursor: ${opts.cursor}`);
      // Strictly after the cursor entry in (occurredAt desc, idx desc) order.
      rows = rows.filter((h) => {
        const ms = Date.parse(h.event.occurredAt);
        return ms < cMs || (ms === cMs && h.idx < cIdx);
      });
    }
    const page = rows.slice(0, opts.limit);
    const last = page[page.length - 1];
    return {
      events: page.map((h) => h.event),
      nextCursor: rows.length > page.length && last ? `${last.event.occurredAt}|${last.idx}` : null,
    };
  }

  templates(): InjectTemplate[] {
    return this.scenarioTemplates;
  }

  state(): EngineState {
    return {
      scenario: this.scenario
        ? {
            name: this.scenario.name,
            description: this.scenario.description,
            eventCount: this.scenario.events.length,
            historyCount: this.history.length,
          }
        : null,
      clock: {
        minutes: Math.round(this.clockMinutes * 100) / 100,
        playing: this.playing,
        speed: this.speed,
        startedAt: this.startedAtMs !== null ? new Date(this.startedAtMs).toISOString() : null,
        simNow: this.startedAtMs !== null ? new Date(this.simNowMs()).toISOString() : null,
      },
      released: this.released.map((r) => r.event),
      pending: this.pending.map(({ event }) => ({
        atMinute: event.atMinute,
        source: event.source,
        kind: event.kind,
        text: event.text,
        actor: event.actor,
      })),
      people: this.scenario?.people ?? [],
    };
  }

  /** Current moment on the scenario timeline (wall now when no scenario). */
  private simNowMs(): number {
    return this.startedAtMs !== null ? this.startedAtMs + this.clockMinutes * 60_000 : this.now();
  }

  private releaseDue(): void {
    if (this.startedAtMs === null) return;
    let releasedAny = false;
    const releasedAtMs = this.now();
    while (this.pending.length > 0 && this.pending[0]!.event.atMinute <= this.clockMinutes) {
      const { idx, event } = this.pending.shift()!;
      this.released.push({ event: this.toSourceEvent(event, idx), releasedAtMs });
      releasedAny = true;
    }
    if (releasedAny) this.sortReleased();
  }

  private toSourceEvent(ev: ScenarioEvent, idx: number, idKind: 'evt' | 'hist' = 'evt'): SourceEvent {
    const startedAtMs = this.startedAtMs!;
    const meta: Record<string, unknown> = { ...(ev.meta ?? {}) };
    // Scenario authors can pin externalId in meta (e.g. to script a DUPLICATE delivery).
    const externalId =
      typeof meta.externalId === 'string' ? meta.externalId : `${this.scenario!.name}-${idKind}-${idx}`;
    delete meta.externalId;
    if (ev.source === 'gcal' && typeof meta.startAtMinute === 'number') {
      this.absolutizeGcalMeta(meta, startedAtMs);
    }
    return SourceEventSchema.parse({
      source: ev.source,
      externalId,
      kind: ev.kind,
      actor: ev.actor ?? {},
      direction: ev.direction,
      text: ev.text,
      threadRef: ev.threadRef,
      occurredAt: new Date(startedAtMs + ev.atMinute * 60_000).toISOString(),
      meta,
    });
  }

  /** meta.startAtMinute/durationMin → absolute ISO startAt/endAt anchored at baseMs. */
  private absolutizeGcalMeta(meta: Record<string, unknown>, baseMs: number): void {
    const startMs = baseMs + (meta.startAtMinute as number) * 60_000;
    const durationMin = typeof meta.durationMin === 'number' ? meta.durationMin : 30;
    meta.startAt = new Date(startMs).toISOString();
    meta.endAt = new Date(startMs + durationMin * 60_000).toISOString();
    delete meta.startAtMinute;
    delete meta.durationMin;
  }

  private sortReleased(): void {
    this.released.sort((a, b) => Date.parse(a.event.occurredAt) - Date.parse(b.event.occurredAt));
  }
}
