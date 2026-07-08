import type { SourceEvent, WsEvent } from '@botty/shared';
import { createBus, type Bus } from '../../src/bus/index.js';
import { Db } from '../../src/db/index.js';
import { makeDecisionRecorder, makeModelResolver } from '../../src/llm/index.js';
import { MockLlmClient } from '../../src/llm/mock.js';
import type { LlmClient } from '../../src/llm/types.js';
import type { FunnelCtx } from '../../src/ingest/util.js';

export interface Harness {
  db: Db;
  bus: Bus;
  llm: LlmClient;
  ctx: FunnelCtx;
  broadcasts: WsEvent[];
}

/**
 * In-memory db + MockLlm harness. Seeds two team people:
 * Marian (CRITICAL, tier 1) and Rai (NORMAL, tier 2).
 */
export function makeHarness(llmFactory?: (base: LlmClient) => LlmClient): Harness {
  const db = new Db(':memory:');
  const bus = createBus();
  db.upsertTeamPerson({
    name: 'Marian',
    weight: 'CRITICAL',
    slackHandle: '@marian',
    email: 'marian@acme.example',
  });
  db.upsertTeamPerson({ name: 'Rai', weight: 'NORMAL', slackHandle: '@rai', email: 'rai@acme.example' });

  const mock = new MockLlmClient({ db, modelFor: makeModelResolver(db), record: makeDecisionRecorder(db, bus) });
  const llm = llmFactory ? llmFactory(mock) : mock;

  const broadcasts: WsEvent[] = [];
  bus.onBroadcast((e) => broadcasts.push(e));

  return { db, bus, llm, ctx: { db, bus, llm }, broadcasts };
}

let seq = 0;

/** Build a SourceEvent with sane defaults (unique externalId per call). */
export function makeEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
  seq += 1;
  return {
    source: 'slack',
    externalId: `ev-${seq}`,
    kind: 'dm',
    actor: { handle: '@marian' },
    direction: 'inbound',
    text: 'hello',
    occurredAt: new Date().toISOString(),
    meta: {},
    ...overrides,
  };
}

/** meta.funnelOutcome stamped into the raw_log body for an externalId. */
export function outcomeInRawLog(db: Db, externalId: string): unknown {
  const row = db
    .listRawLog({ limit: 1000 })
    .find((r) => r.externalId === externalId);
  if (!row) return undefined;
  const body = JSON.parse(row.body) as { meta?: Record<string, unknown> };
  return body.meta?.funnelOutcome;
}
