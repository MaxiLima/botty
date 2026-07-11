import type { FunnelOutcome, Person, RawLogRow, SourceEvent } from '@botty/shared';
import type { Bus } from '../bus/index.js';
import type { Db } from '../db/index.js';
import type { LlmClient } from '../llm/types.js';

/** The slice of AgentContext the funnel needs (kept narrow for tests). */
export interface FunnelCtx {
  db: Db;
  llm: LlmClient;
  bus: Bus;
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function actorLabel(actor: SourceEvent['actor']): string | null {
  return actor.handle ?? actor.email ?? actor.displayName ?? null;
}

/** Funnel step 1 — append to raw_log. Returns null on (source, externalId) conflict (DUPLICATE). */
export function insertEventRawLog(db: Db, event: SourceEvent): RawLogRow | null {
  return db.insertRawLog({
    source: event.source,
    externalId: event.externalId,
    kind: event.kind,
    actor: actorLabel(event.actor),
    body: JSON.stringify(event),
    occurredAt: event.occurredAt,
  });
}

/**
 * Write the funnel verdict back into raw_log.body.meta.funnelOutcome (plus an
 * optional funnelDetail blob) so the Inspector can answer "why didn't this
 * become a task?" for every raw event.
 */
export function stampOutcome(
  db: Db,
  rawLog: RawLogRow,
  event: SourceEvent,
  outcome: FunnelOutcome,
  detail?: Record<string, unknown>,
): void {
  const body = {
    ...event,
    meta: { ...event.meta, funnelOutcome: outcome, ...(detail ? { funnelDetail: detail } : {}) },
  };
  db.updateRawLogBody(rawLog.id, JSON.stringify(body));
}

/** Insert an interactions row for the event's actor + FTS-index the snippet. */
export function logInteraction(
  ctx: Pick<FunnelCtx, 'db'>,
  event: SourceEvent,
  rawLogId: string,
  personId: string | null,
): void {
  const snippet = clip(event.text.replace(/\s+/g, ' ').trim(), 200) || null;
  const interaction = ctx.db.insertInteraction({
    personId,
    source: event.source,
    kind: event.kind,
    direction: event.direction,
    snippet,
    threadRef: event.threadRef ?? null,
    rawLogId,
    occurredAt: event.occurredAt,
  });
  if (snippet) ctx.db.ftsIndex('interaction', interaction.id, snippet);
}

/**
 * Upsert a tier-2 'discovered' person for an unknown actor so interactions
 * attach to a person row (feeds the ≥5-in-14-days promotion-candidate query).
 * Returns undefined when the actor carries no usable identity.
 */
export function discoverActor(db: Db, actor: SourceEvent['actor']): Person | undefined {
  const name = actor.displayName ?? actor.handle?.replace(/^@/, '') ?? actor.email;
  if (!name) return undefined;
  return db.upsertDiscoveredPerson({
    name,
    slackHandle: actor.handle,
    email: actor.email,
  });
}

/** WS `tasks.updated` after any funnel/structured task write. */
export function broadcastTasksUpdated(ctx: Pick<FunnelCtx, 'db' | 'bus'>): void {
  ctx.bus.broadcast({ type: 'tasks.updated', payload: { tasks: ctx.db.listTasks('open') } });
}
