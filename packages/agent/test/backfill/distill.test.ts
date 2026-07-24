import { describe, expect, it } from 'vitest';
import type { SourceEvent } from '@botty/shared';
import { processHistoricalEvent } from '../../src/backfill/process.js';
import { runDistillPhase, type DistillOpts } from '../../src/backfill/distill.js';
import type { LlmClient, StructuredRequest } from '../../src/llm/types.js';
import { makeEvent, makeHarness, type Harness } from '../ingest/helpers.js';

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

const distillOpts = (over: Partial<DistillOpts> = {}): DistillOpts => ({
  sources: ['slack', 'gmail'],
  callCap: 50,
  isCancelled: () => false,
  onProgress: () => {},
  ...over,
});

/** Seed a backfilled slack thread: a decision message + a chatter reply. */
function seedDecisionThread(h: Harness, ref = 'H-vendor'): SourceEvent[] {
  const events = [
    makeEvent({
      externalId: `${ref}-0`,
      threadRef: ref,
      text: 'we decided to go with VendorPay for MX',
      occurredAt: daysAgo(10),
      actor: { handle: '@marian', displayName: 'Marian' },
    }),
    makeEvent({
      externalId: `${ref}-1`,
      threadRef: ref,
      text: 'sounds great',
      occurredAt: daysAgo(9),
      actor: { handle: '@diego', displayName: 'Diego Paz' },
    }),
  ];
  for (const e of events) processHistoricalEvent(h.ctx, e);
  return events;
}

describe('runDistillPhase', () => {
  it('creates #bf decisions with historical decided_at, FTS-indexed, and stamps the thread', async () => {
    const h = makeHarness();
    const events = seedDecisionThread(h);

    const p1 = await runDistillPhase(h.ctx, distillOpts());
    expect(p1).toMatchObject({ threadsSeen: 1, threadsDistilled: 1, callsUsed: 1, errors: 0, done: true });
    expect(p1.decisionsCreated).toBeGreaterThan(0);

    const decisions = h.db.listDecisionRows(100);
    expect(decisions.length).toBe(p1.decisionsCreated);
    const d = decisions.find((row) => row.sourceRef === 'H-vendor#bf1')!;
    expect(d.description).toContain('VendorPay');
    expect(d.decidedAt).toBe(events[1]!.occurredAt); // newest thread event's occurredAt
    expect(h.db.ftsSearch('VendorPay', 5).some((hit) => hit.kind === 'decision')).toBe(true);
    // the distill call is recorded in ai_decisions under its own kind
    expect(h.db.listAiDecisions({ kind: 'distill' })).toHaveLength(1);

    // second run: thread stamped ⇒ full no-op, no new LLM call
    const p2 = await runDistillPhase(h.ctx, distillOpts());
    expect(p2).toMatchObject({ threadsSeen: 0, callsUsed: 0 });
    expect(h.db.listDecisionRows(100)).toHaveLength(decisions.length);
    expect(h.db.listAiDecisions({ kind: 'distill' })).toHaveLength(1);
  });

  it('prefilter skips chatter-only threads without an LLM call', async () => {
    const h = makeHarness();
    processHistoricalEvent(h.ctx, makeEvent({ externalId: 'noise-0', threadRef: 'H-noise', text: 'jaja buenísimo 😂', occurredAt: daysAgo(3) }));
    const p = await runDistillPhase(h.ctx, distillOpts());
    expect(p).toMatchObject({ threadsSeen: 1, threadsDistilled: 0, callsUsed: 0 });
    expect(h.db.listAiDecisions({ kind: 'distill' })).toHaveLength(0);
  });

  it('honors the call cap and resumes the remaining threads on the next run', async () => {
    const h = makeHarness();
    seedDecisionThread(h, 'H-a');
    seedDecisionThread(h, 'H-b');
    seedDecisionThread(h, 'H-c');

    const p1 = await runDistillPhase(h.ctx, distillOpts({ callCap: 2 }));
    expect(p1.callsUsed).toBe(2);
    expect(p1.threadsDistilled).toBe(2);
    expect(p1.done).toBe(false); // cap hit — work remains

    const p2 = await runDistillPhase(h.ctx, distillOpts({ callCap: 2 }));
    expect(p2.threadsDistilled).toBe(1);
    expect(p2.done).toBe(true);
  });

  it('callCap 0 skips the phase entirely', async () => {
    const h = makeHarness();
    seedDecisionThread(h);
    const p = await runDistillPhase(h.ctx, distillOpts({ callCap: 0 }));
    expect(p).toMatchObject({ threadsSeen: 0, callsUsed: 0, done: true });
  });

  it('appends distilled notes only to discovered people, never team_md', async () => {
    const h = makeHarness();
    seedDecisionThread(h);
    // LLM that returns people notes for a team person (Marian) and an unknown (Fer)
    const llm: LlmClient = {
      ...h.llm,
      structured: async <T>(req: StructuredRequest<T>): Promise<T> =>
        req.schema.parse({
          decisions: [],
          people: [
            { name: 'Marian', note: 'leads the fraud squad' },
            { name: 'Fer', note: 'VendorPay account manager' },
          ],
        }),
    };
    const p = await runDistillPhase({ ...h.ctx, llm }, distillOpts());
    expect(p.notesAdded).toBe(1);
    expect(h.db.getPersonByName('Marian')!.notes).toBeNull(); // team_md — untouched
    const fer = h.db.getPersonByName('Fer')!;
    expect(fer.source).toBe('discovered');
    expect(fer.notes).toBe('VendorPay account manager');
  });

  it('an LLM error leaves the thread unstamped for retry and never throws', async () => {
    const h = makeHarness();
    seedDecisionThread(h);
    const failing: LlmClient = {
      ...h.llm,
      structured: async () => {
        throw new Error('boom');
      },
    };
    const p1 = await runDistillPhase({ ...h.ctx, llm: failing }, distillOpts());
    expect(p1).toMatchObject({ errors: 1, threadsDistilled: 0 });

    // next run (healthy LLM) picks the thread up again
    const p2 = await runDistillPhase(h.ctx, distillOpts());
    expect(p2.threadsDistilled).toBe(1);
  });
});
