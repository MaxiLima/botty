import { SourceEventSchema, type SourceEvent, type SourceId } from '@botty/shared';
import type { HistoryPage, SourceAdapter } from './index.js';

/**
 * Sim driver: thin HTTP client against @botty/sim.
 * GET ${simUrl}/<source>/events?since=<ISO> → { events: SourceEvent[] }.
 * Each event is validated with SourceEventSchema; invalid entries are dropped
 * (dedup + raw_log downstream make refetching safe).
 */
export function createSimAdapter(source: SourceId, simUrl: string): SourceAdapter {
  return {
    source,
    async fetch(since: string | null): Promise<SourceEvent[]> {
      const url = new URL(`/${source}/events`, simUrl);
      if (since) url.searchParams.set('since', since);
      let res: Response;
      try {
        res = await fetch(url);
      } catch (err) {
        // undici's bare "fetch failed" hides the cause; say what to check.
        const code = (err as { cause?: { code?: string } }).cause?.code;
        throw new Error(
          `sim ${source} unreachable at ${url.origin}${code ? ` (${code})` : ''} — is the simulator running? (npm run dev:sim)`,
        );
      }
      if (!res.ok) {
        throw new Error(`sim ${source} fetch failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { events?: unknown };
      return parseEvents(body.events, source);
    },

    async fetchHistory(opts): Promise<HistoryPage> {
      const url = new URL(`/${source}/history`, simUrl);
      if (opts.cursor) url.searchParams.set('cursor', opts.cursor);
      url.searchParams.set('oldest', opts.oldest);
      url.searchParams.set('limit', String(opts.limit));
      let res: Response;
      try {
        res = await fetch(url);
      } catch (err) {
        const code = (err as { cause?: { code?: string } }).cause?.code;
        throw new Error(
          `sim ${source} unreachable at ${url.origin}${code ? ` (${code})` : ''} — is the simulator running? (npm run dev:sim)`,
        );
      }
      if (!res.ok) {
        throw new Error(`sim ${source} history fetch failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as { events?: unknown; nextCursor?: unknown };
      return {
        events: parseEvents(body.events, source),
        nextCursor: typeof body.nextCursor === 'string' ? body.nextCursor : null,
      };
    },
  };
}

function parseEvents(raw: unknown, source: SourceId): SourceEvent[] {
  const rawEvents = Array.isArray(raw) ? raw : [];
  const events: SourceEvent[] = [];
  for (const item of rawEvents) {
    const parsed = SourceEventSchema.safeParse(item);
    if (parsed.success && parsed.data.source === source) events.push(parsed.data);
  }
  return events;
}
