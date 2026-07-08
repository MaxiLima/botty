import { describe, expect, it } from 'vitest';
import type { StructuredRequest } from '../../src/llm/types.js';
import type { LlmClient } from '../../src/llm/types.js';
import { processEvent, retryErroredEvents } from '../../src/ingest/funnel.js';
import { makeEvent, makeHarness, outcomeInRawLog } from './helpers.js';

/** Wrap a base client, overriding classification (and optionally extraction). */
function overrideStructured(
  base: LlmClient,
  handler: (req: StructuredRequest<unknown>) => Promise<unknown> | unknown,
): LlmClient {
  return {
    chatTurn: base.chatTurn.bind(base),
    interrupt: base.interrupt.bind(base),
    async structured<T>(req: StructuredRequest<T>): Promise<T> {
      const out = await handler(req as StructuredRequest<unknown>);
      if (out === undefined) return base.structured(req);
      return req.schema.parse(out);
    },
  };
}

describe('funnel', () => {
  it('DUPLICATE: same (source, externalId) is processed once', async () => {
    const h = makeHarness();
    const event = makeEvent({ externalId: 'dup-1', text: 'can you check the deploy?' });

    expect(await processEvent(h.ctx, event)).toBe('EXTRACTED');
    expect(await processEvent(h.ctx, event)).toBe('DUPLICATE');

    expect(h.db.listRawLog().filter((r) => r.externalId === 'dup-1')).toHaveLength(1);
    expect(h.db.listTasks()).toHaveLength(1); // no second task
    // first outcome stays stamped
    expect(outcomeInRawLog(h.db, 'dup-1')).toBe('EXTRACTED');
  });

  it('INTERACTION_ONLY: tier-2 person gets an interaction row, no LLM, no task', async () => {
    const h = makeHarness();
    const event = makeEvent({ actor: { handle: '@rai' }, text: 'can you review this please?' });

    expect(await processEvent(h.ctx, event)).toBe('INTERACTION_ONLY');

    const rai = h.db.getPersonByName('Rai')!;
    const interactions = h.db.interactionsForPerson(rai.id);
    expect(interactions).toHaveLength(1);
    expect(interactions[0]!.snippet).toContain('can you review');
    expect(h.db.listTasks()).toEqual([]);
    expect(h.db.listAiDecisions()).toEqual([]); // never reached the LLM
    expect(outcomeInRawLog(h.db, event.externalId)).toBe('INTERACTION_ONLY');
  });

  it('INTERACTION_ONLY: unknown actor is upserted as a discovered tier-2 person', async () => {
    const h = makeHarness();
    const event = makeEvent({
      actor: { handle: '@rando', displayName: 'Rando Calrissian' },
      text: 'can you help me?',
    });

    expect(await processEvent(h.ctx, event)).toBe('INTERACTION_ONLY');

    const rando = h.db.getPersonByName('Rando Calrissian');
    expect(rando).toBeDefined();
    expect(rando!.tier).toBe(2);
    expect(rando!.source).toBe('discovered');
    expect(h.db.interactionsForPerson(rando!.id)).toHaveLength(1);
  });

  it('NO_SIGNAL: tier-1 social noise stops at the heuristic gate', async () => {
    const h = makeHarness();
    const event = makeEvent({ text: 'jaja buenísimo' });

    expect(await processEvent(h.ctx, event)).toBe('NO_SIGNAL');

    const marian = h.db.getPersonByName('Marian')!;
    expect(h.db.interactionsForPerson(marian.id)).toHaveLength(1);
    expect(h.db.listTasks()).toEqual([]);
    expect(h.db.listAiDecisions()).toEqual([]);
    expect(outcomeInRawLog(h.db, event.externalId)).toBe('NO_SIGNAL');
  });

  it('outbound (my own reply) is evidence only: interaction row, no LLM, no task', async () => {
    const h = makeHarness();
    // Signal-heavy text that WOULD extract if it were inbound.
    const event = makeEvent({
      direction: 'outbound',
      actor: { displayName: 'me' },
      text: 'done — can you check I did not miss anything? I will follow up',
      threadRef: 'T-OUT',
    });

    expect(await processEvent(h.ctx, event)).toBe('INTERACTION_ONLY');

    expect(h.db.listTasks()).toEqual([]);
    expect(h.db.listAiDecisions()).toEqual([]); // never reached the LLM
    expect(outcomeInRawLog(h.db, event.externalId)).toBe('INTERACTION_ONLY');
    // Raw-logged under its threadRef so the resolution sweep can read it.
    expect(h.db.threadEvents('slack', 'T-OUT')).toHaveLength(1);
    const interaction = h.db.raw.prepare("SELECT direction FROM interactions").get() as { direction: string };
    expect(interaction.direction).toBe('outbound');
  });

  it('CLASSIFIED_OUT: classifier rejects a heuristic false-positive', async () => {
    const h = makeHarness((base) =>
      overrideStructured(base, (req) =>
        req.task === 'classification'
          ? { worthExtracting: false, confidence: 0.8, reason: 'rhetorical question' }
          : undefined,
      ),
    );
    const event = makeEvent({ text: 'can you believe this weather?' });

    expect(await processEvent(h.ctx, event)).toBe('CLASSIFIED_OUT');

    const marian = h.db.getPersonByName('Marian')!;
    expect(h.db.interactionsForPerson(marian.id)).toHaveLength(1);
    expect(h.db.listTasks()).toEqual([]);
    expect(outcomeInRawLog(h.db, event.externalId)).toBe('CLASSIFIED_OUT');
    // detail carries the classifier's reason for the Inspector
    const body = JSON.parse(h.db.listRawLog()[0]!.body) as { meta: { funnelDetail?: { reason?: string } } };
    expect(body.meta.funnelDetail?.reason).toBe('rhetorical question');
  });

  it('EXTRACTED: tier-1 ask becomes a P1 task, interaction, FTS entry, and tasks.updated', async () => {
    const h = makeHarness();
    const event = makeEvent({
      externalId: 'slack-42',
      threadRef: 'T-1001',
      text: 'Can you review the fraud-rules PR by friday? It is blocking the release.',
    });

    expect(await processEvent(h.ctx, event)).toBe('EXTRACTED');

    const marian = h.db.getPersonByName('Marian')!;
    const tasks = h.db.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.priority).toBe(1); // requester is tier 1
    expect(tasks[0]!.requestedBy).toBe(marian.id);
    expect(tasks[0]!.sourceRef).toBe('T-1001'); // threadRef || externalId
    expect(tasks[0]!.rawText).toBe(event.text);

    expect(h.db.interactionsForPerson(marian.id)).toHaveLength(1);
    expect(outcomeInRawLog(h.db, 'slack-42')).toBe('EXTRACTED');
    // ...and surfaced as a first-class field on the read path (Inspector funnel column)
    expect(h.db.listRawLog()[0]!.outcome).toBe('EXTRACTED');

    // both LLM stages recorded against the raw_log row
    const rawLogId = h.db.listRawLog()[0]!.id;
    const kinds = h.db.listAiDecisions().map((d) => [d.kind, d.relatedRef]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['classification', rawLogId],
        ['extraction', rawLogId],
      ]),
    );

    // FTS indexed the extracted task
    const hits = h.db.ftsSearch('fraud-rules');
    expect(hits.some((hit) => hit.kind === 'task')).toBe(true);

    // tasks.updated broadcast after the task write
    const updated = h.broadcasts.find((e) => e.type === 'tasks.updated');
    expect(updated).toBeDefined();
    expect(updated!.type === 'tasks.updated' && updated!.payload.tasks).toHaveLength(1);
  });

  it('classifier failure degrades to extraction (heuristics already passed)', async () => {
    const h = makeHarness((base) =>
      overrideStructured(base, (req) => {
        if (req.task === 'classification') throw new Error('llm down');
        return undefined;
      }),
    );
    const event = makeEvent({ text: 'please ship the report by monday' });

    expect(await processEvent(h.ctx, event)).toBe('EXTRACTED');
    expect(h.db.listTasks()).toHaveLength(1);
  });

  it('extractor failure lands as ERROR with an interaction row', async () => {
    const h = makeHarness((base) =>
      overrideStructured(base, (req) => {
        if (req.task === 'extraction') throw new Error('llm exploded');
        return undefined;
      }),
    );
    const event = makeEvent({ text: 'can you rotate the API keys please?' });

    expect(await processEvent(h.ctx, event)).toBe('ERROR');
    expect(h.db.listTasks()).toEqual([]);
    const marian = h.db.getPersonByName('Marian')!;
    expect(h.db.interactionsForPerson(marian.id)).toHaveLength(1);
    expect(outcomeInRawLog(h.db, event.externalId)).toBe('ERROR');
  });

  it('two distinct asks in the same thread both persist; an identical re-send dedups', async () => {
    const h = makeHarness();
    // Two DIFFERENT asks sharing a threadRef (sim channel messages use the channel).
    expect(
      await processEvent(h.ctx, makeEvent({ threadRef: 'C-fraud', text: 'can you check the deploy?' })),
    ).toBe('EXTRACTED');
    expect(
      await processEvent(h.ctx, makeEvent({ threadRef: 'C-fraud', text: 'can you rotate the API keys please?' })),
    ).toBe('EXTRACTED');

    const tasks = h.db.listTasks();
    expect(tasks).toHaveLength(2); // second distinct ask is NOT swallowed by the thread key
    expect(tasks.map((t) => t.sourceRef).sort()).toEqual(['C-fraud', 'C-fraud#2']);

    // Identical re-send (new externalId, same text — a repeated nag) still dedups.
    expect(
      await processEvent(h.ctx, makeEvent({ threadRef: 'C-fraud', text: 'can you check the deploy?' })),
    ).toBe('EXTRACTED');
    expect(h.db.listTasks()).toHaveLength(2);
  });

  it('two distinct decisions in the same thread both persist; a restated one dedups', async () => {
    // one harness; the extracted decision text is driven via a closure
    let description = 'Going with option B';
    const h = makeHarness((base) =>
      overrideStructured(base, (req) => {
        if (req.task === 'classification') return { worthExtracting: true, confidence: 1, reason: 'ok' };
        if (req.task === 'extraction') return { tasks: [], decisions: [{ description }], people: [] };
        return undefined;
      }),
    );

    await processEvent(h.ctx, makeEvent({ threadRef: 'C-arch', text: 'we decided option B' }));
    description = 'Cutover moves to Friday';
    await processEvent(h.ctx, makeEvent({ threadRef: 'C-arch', text: 'we decided to move the cutover' }));

    const decisions = h.db.listDecisionRows();
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.sourceRef).sort()).toEqual(['C-arch', 'C-arch#d2']);

    // restating the same decision in the thread does not duplicate it
    await processEvent(h.ctx, makeEvent({ threadRef: 'C-arch', text: 'we decided to move the cutover!' }));
    expect(h.db.listDecisionRows()).toHaveLength(2);
  });

  it('ERROR rows are retried on later checks and recover once the LLM is back', async () => {
    let failing = true;
    let extractionCalls = 0;
    const h = makeHarness((base) =>
      overrideStructured(base, (req) => {
        if (req.task === 'extraction') {
          extractionCalls += 1;
          if (failing) throw new Error('llm down');
        }
        return undefined;
      }),
    );
    const event = makeEvent({ text: 'can you rotate the API keys please?', threadRef: 'T-RETRY' });

    expect(await processEvent(h.ctx, event)).toBe('ERROR');
    expect(h.db.listTasks()).toEqual([]);

    // still down: stays ERROR, attempt counted
    expect(await retryErroredEvents(h.ctx, 'slack')).toBe(0);
    expect(outcomeInRawLog(h.db, event.externalId)).toBe('ERROR');
    expect(extractionCalls).toBe(2);

    // back up: the ask is recovered, not dropped forever
    failing = false;
    expect(await retryErroredEvents(h.ctx, 'slack')).toBe(1);
    expect(outcomeInRawLog(h.db, event.externalId)).toBe('EXTRACTED');
    expect(h.db.listTasks()).toHaveLength(1);
    expect(h.db.listTasks()[0]!.sourceRef).toBe('T-RETRY');

    // interaction row from the first pass is not duplicated by the retry
    const marian = h.db.getPersonByName('Marian')!;
    expect(h.db.interactionsForPerson(marian.id)).toHaveLength(1);

    // recovered rows leave the retry pool
    expect(await retryErroredEvents(h.ctx, 'slack')).toBe(0);
    expect(extractionCalls).toBe(3);
  });

  it('ERROR retries are bounded (3 extraction attempts total)', async () => {
    let extractionCalls = 0;
    const h = makeHarness((base) =>
      overrideStructured(base, (req) => {
        if (req.task === 'extraction') {
          extractionCalls += 1;
          throw new Error('llm still down');
        }
        return undefined;
      }),
    );
    const event = makeEvent({ text: 'please ship the report by monday' });

    expect(await processEvent(h.ctx, event)).toBe('ERROR'); // attempt 1
    await retryErroredEvents(h.ctx, 'slack'); // attempt 2
    await retryErroredEvents(h.ctx, 'slack'); // attempt 3
    await retryErroredEvents(h.ctx, 'slack'); // capped — no further LLM call
    expect(extractionCalls).toBe(3);
    expect(outcomeInRawLog(h.db, event.externalId)).toBe('ERROR');
  });

  it('persists extractor people and decisions (people → tasks → decisions)', async () => {
    const h = makeHarness((base) =>
      overrideStructured(base, (req) => {
        if (req.task === 'classification') return { worthExtracting: true, confidence: 1, reason: 'ok' };
        if (req.task === 'extraction') {
          return {
            tasks: [
              { description: 'Review fraud PR', requesterName: 'Marian' },
              { description: 'Ping Sofi about rollout', requesterName: 'Sofi' },
            ],
            decisions: [{ description: 'Going with option B', rationale: 'cheaper' }],
            people: [{ name: 'Sofi', slackHandle: '@sofi' }],
          };
        }
        return undefined;
      }),
    );
    const event = makeEvent({ externalId: 'multi-1', text: 'we decided... can you...?' });

    expect(await processEvent(h.ctx, event)).toBe('EXTRACTED');

    const sofi = h.db.getPersonByName('Sofi');
    expect(sofi).toBeDefined();
    expect(sofi!.tier).toBe(2);

    const tasks = h.db.listTasks();
    expect(tasks).toHaveLength(2); // second task got a suffixed sourceRef instead of colliding
    const refs = tasks.map((t) => t.sourceRef).sort();
    expect(refs).toEqual(['multi-1', 'multi-1#2']);
    const sofiTask = tasks.find((t) => t.requestedBy === sofi!.id)!;
    expect(sofiTask.priority).toBe(2); // tier-2 requester

    const decisions = h.db.listDecisionRows();
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.rationale).toBe('cheaper');
    expect(h.db.ftsSearch('option').some((hit) => hit.kind === 'decision')).toBe(true);
  });
});
