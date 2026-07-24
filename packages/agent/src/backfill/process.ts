import type { SourceEvent } from '@botty/shared';
import { handleGcal } from '../ingest/structured.js';
import {
  discoverActor,
  insertEventRawLog,
  logInteraction,
  stampOutcome,
  type FunnelCtx,
} from '../ingest/util.js';

/**
 * Deterministic per-event path for backfilled history (docs/specs/backfill.md).
 * Context only — no funnel, no LLM, NO tasks: raw_log (marked meta.backfill),
 * people discovery, interactions with the event's true occurred_at, calendar
 * upserts, and FTS via logInteraction. The marker rides in event.meta so it
 * lands in raw_log.body at insert AND survives stampOutcome's meta spread; the
 * resolution sweep uses it to exclude these rows from evidence.
 */
export function processHistoricalEvent(ctx: FunnelCtx, event: SourceEvent): 'new' | 'duplicate' {
  const marked: SourceEvent = { ...event, meta: { ...event.meta, backfill: true } };

  if (marked.source === 'gcal') {
    // Same deterministic upsert as live ingest; a historical start_at is harmless
    // (meeting-prep candidates only look forward from now).
    return handleGcal(ctx, marked) === 'DUPLICATE' ? 'duplicate' : 'new';
  }

  const rawLog = insertEventRawLog(ctx.db, marked);
  if (!rawLog) return 'duplicate';

  // Mirror the funnel's interaction stamps: outbound rows (the user's own
  // replies) never discover a person; inbound rows attach to a known person or
  // a tier-2 'discovered' one so historical interaction counts accrue.
  const person =
    marked.direction === 'outbound'
      ? undefined
      : (ctx.db.findPersonByActor(marked.actor) ?? discoverActor(ctx.db, marked.actor));
  logInteraction(ctx, marked, rawLog.id, person?.id ?? null);
  stampOutcome(ctx.db, rawLog, marked, 'INTERACTION_ONLY', { backfill: true });
  return 'new';
}
