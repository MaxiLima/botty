import { describe, expect, it } from 'vitest';
import type { StructuredRequest } from '../../src/llm/types.js';
import type { LlmClient } from '../../src/llm/types.js';
import { processEvent } from '../../src/ingest/funnel.js';
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

describe('funnel — task ownership (ISSUE 1: Diego latency-doc bug)', () => {
  it('mock: a message whose only signal is the sender\'s own commitment ("I\'ll…") tags owner=them', async () => {
    const h = makeHarness();
    const event = makeEvent({ text: "I'll send you the report tomorrow" });

    expect(await processEvent(h.ctx, event)).toBe('EXTRACTED');
    const tasks = h.db.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.owner).toBe('them');
    // priority is NOT bumped to P1 just because Marian (tier 1) is the requester —
    // this is a "waiting on" reminder, not urgent work for the user.
    expect(tasks[0]!.priority).toBe(2);
  });

  it('mock: a plain request ("can you…") tags owner=me, unaffected by the new logic', async () => {
    const h = makeHarness();
    const event = makeEvent({ text: 'can you review the fraud-rules PR by friday?' });

    expect(await processEvent(h.ctx, event)).toBe('EXTRACTED');
    const tasks = h.db.listTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.owner).toBe('me');
    expect(tasks[0]!.priority).toBe(1); // requester (Marian) is tier 1 — unchanged for 'me' tasks
  });

  it('live repro: Diego\'s DM extracts BOTH a "me" feedback-ask and a "them" send-doc promise, correctly tagged and priced', async () => {
    const h2 = makeHarness((base) =>
      overrideStructured(base, (req) => {
        if (req.task === 'classification') return { worthExtracting: true, confidence: 1, reason: 'ok' };
        if (req.task === 'extraction') {
          return {
            tasks: [
              {
                description: 'Provide feedback on latency doc before Wednesday refinement',
                owner: 'me',
              },
              {
                description: 'Send latency doc',
                owner: 'them',
                dueDate: '2026-07-10',
              },
            ],
            decisions: [],
            people: [],
          };
        }
        return undefined;
      }),
    );
    h2.db.upsertTeamPerson({ name: 'Diego', weight: 'HIGH', slackHandle: '@diego' });

    const event = makeEvent({
      actor: { handle: '@diego' },
      text: "I'll send you the latency doc tomorrow — quiero tu feedback antes del refinement del miércoles",
    });

    expect(await processEvent(h2.ctx, event)).toBe('EXTRACTED');
    const tasks = h2.db.listTasks();
    expect(tasks).toHaveLength(2);

    const feedbackTask = tasks.find((t) => t.description.startsWith('Provide feedback'))!;
    const sendDocTask = tasks.find((t) => t.description.startsWith('Send latency doc'))!;

    expect(feedbackTask.owner).toBe('me');
    expect(feedbackTask.priority).toBe(1); // Diego (tier 1) asked the user directly — stays P1

    expect(sendDocTask.owner).toBe('them'); // Diego's own promise, NOT the user's to-do
    expect(sendDocTask.priority).toBe(2); // never defaults to P1 for a 'them' task
  });
});

describe('funnel — cross-source dedup (ISSUE 2: Marian\'s PR #482 via Slack + GitHub)', () => {
  it('a GitHub review-request and a later Slack "can you review PR #482" DM produce ONE task, not two', async () => {
    const h = makeHarness();

    const githubEvent = makeEvent({
      source: 'github',
      kind: 'pr',
      externalId: 'gh-482',
      actor: { displayName: 'github-actions' },
      text: 'Review requested: acme-example/fraud-rules#482',
      meta: { repo: 'acme-example/fraud-rules', number: 482, state: 'open' },
    });
    expect(await processEvent(h.ctx, githubEvent)).toBe('UPSERTED');
    expect(h.db.listTasks()).toHaveLength(1);
    const existingTaskId = h.db.listTasks()[0]!.id;

    const slackEvent = makeEvent({
      source: 'slack',
      externalId: 'slack-marian-482',
      text: 'can you review the fraud-rules PR #482',
    });
    expect(await processEvent(h.ctx, slackEvent)).toBe('DEDUPED');

    // still exactly one open task — the slack ask did NOT spawn a second one
    expect(h.db.listTasks()).toHaveLength(1);

    // the dedup decision names the existing task so the Inspector can explain it
    const row = h.db.listRawLog().find((r) => r.externalId === 'slack-marian-482')!;
    const body = JSON.parse(row.body) as {
      meta: { funnelDetail?: { dedupedTasks?: { existingTaskId: string }[] } };
    };
    expect(body.meta.funnelDetail?.dedupedTasks?.[0]?.existingTaskId).toBe(existingTaskId);

    // ...and the actor still gets an interaction row (evidence isn't lost, just not a 2nd task)
    const marian = h.db.getPersonByName('Marian')!;
    expect(h.db.interactionsForPerson(marian.id).length).toBeGreaterThan(0);
  });

  it('a different PR number is NOT deduped — two distinct open tasks survive', async () => {
    const h = makeHarness();

    const githubEvent = makeEvent({
      source: 'github',
      kind: 'pr',
      externalId: 'gh-483',
      actor: { displayName: 'github-actions' },
      text: 'Review requested: acme-example/fraud-rules#483',
      meta: { repo: 'acme-example/fraud-rules', number: 483, state: 'open' },
    });
    expect(await processEvent(h.ctx, githubEvent)).toBe('UPSERTED');

    const slackEvent = makeEvent({
      source: 'slack',
      externalId: 'slack-marian-482b',
      text: 'can you review the fraud-rules PR #482',
    });
    expect(await processEvent(h.ctx, slackEvent)).toBe('EXTRACTED');

    expect(h.db.listTasks()).toHaveLength(2);
  });
});
