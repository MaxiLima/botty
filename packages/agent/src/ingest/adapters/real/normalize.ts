import { z } from 'zod';
import { SourceEventSchema, type SourceEvent, type SourceId } from '@botty/shared';

/**
 * What the fetch model returns per event — SourceEvent minus `source` (stamped
 * by the adapter, never trusted from model output). Lenient where safe:
 * unparseable/absent fields degrade instead of dropping the whole event.
 */
export const WireEventSchema = z.object({
  externalId: z.string().min(1),
  kind: z.string().min(1),
  actor: z
    .object({
      handle: z.string().optional(),
      email: z.string().optional(),
      displayName: z.string().optional(),
    })
    .default({}),
  direction: z.enum(['inbound', 'outbound']).default('inbound'),
  text: z.string().min(1),
  threadRef: z.string().optional(),
  occurredAt: z.string(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type WireEvent = z.infer<typeof WireEventSchema>;

export const WireBatchSchema = z.object({ events: z.array(WireEventSchema).default([]) });
export type WireBatch = z.infer<typeof WireBatchSchema>;

/** Defensive cap on events per poll, whatever the model returns. */
export const MAX_EVENTS_PER_FETCH = 30;

/**
 * Stamp the source and re-validate against the shared contract. Model output is
 * untrusted: events that still fail SourceEventSchema are dropped, and an
 * unparseable occurredAt is coerced to `now` (better a slightly-misdated event
 * than a silently dropped ask).
 */
export function toSourceEvents(source: SourceId, wire: WireEvent[], now: string): SourceEvent[] {
  const out: SourceEvent[] = [];
  for (const item of wire.slice(0, MAX_EVENTS_PER_FETCH)) {
    const occurredAt = Number.isNaN(Date.parse(item.occurredAt)) ? now : item.occurredAt;
    const parsed = SourceEventSchema.safeParse({ ...item, occurredAt, source });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
