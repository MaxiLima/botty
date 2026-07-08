import { describe, expect, it } from 'vitest';
import type { SourceEvent } from '@botty/shared';
import { processEvent } from '../../src/ingest/funnel.js';
import { parseHeartbeat } from '../../src/config/parse.js';
import {
  createSweepState,
  runResolutionSweep,
  type SweepDeps,
  type SweepState,
} from '../../src/loop/resolution-sweep.js';
import type { LlmClient, StructuredRequest } from '../../src/llm/types.js';
import { makeEvent, makeHarness, type Harness } from '../ingest/helpers.js';

/** Sweep deps on top of the ingest harness (MockLlm unless overridden). */
function sweepDeps(h: Harness, over: { autoResolveTasks?: boolean } = {}): SweepDeps {
  const hb = parseHeartbeat('', 'sim');
  if (over.autoResolveTasks !== undefined) hb.autoResolveTasks = over.autoResolveTasks;
  return { db: h.db, bus: h.bus, llm: h.llm, config: { heartbeat: () => hb } };
}

/** Count structured() calls by wrapping the harness's LLM. */
function spyLlm(base: LlmClient): { llm: LlmClient; calls: StructuredRequest<unknown>[] } {
  const calls: StructuredRequest<unknown>[] = [];
  return {
    calls,
    llm: {
      chatTurn: base.chatTurn.bind(base),
      interrupt: base.interrupt.bind(base),
      async structured<T>(req: StructuredRequest<T>): Promise<T> {
        calls.push(req as StructuredRequest<unknown>);
        return base.structured(req);
      },
    },
  };
}

const T0 = '2026-07-03T10:00:00.000Z';
const T1 = '2026-07-03T11:00:00.000Z';
const T2 = '2026-07-03T12:00:00.000Z';

/** Tier-1 ask that the funnel turns into a task (thread T-PR). */
function ask(text = 'can you review PR 42 please?', threadRef = 'T-PR'): SourceEvent {
  return makeEvent({ actor: { handle: '@marian' }, text, threadRef, occurredAt: T0 });
}

/** The user's own reply in the same thread. */
function myReply(text: string, threadRef = 'T-PR', occurredAt = T1): SourceEvent {
  return makeEvent({
    direction: 'outbound',
    actor: { displayName: 'me' },
    text,
    threadRef,
    occurredAt,
  });
}

async function seedTask(h: Harness, event = ask()): Promise<string> {
  expect(await processEvent(h.ctx, event)).toBe('EXTRACTED');
  const task = h.db.listTasks('open')[0]!;
  expect(task.sourceRef).toBe(event.threadRef);
  return task.id;
}

describe('runResolutionSweep', () => {
  it("closes the task when the user's outbound reply says it's done", async () => {
    const h = makeHarness();
    const taskId = await seedTask(h);
    await processEvent(h.ctx, myReply('review done ✅ left two comments'));

    const state = createSweepState();
    const result = await runResolutionSweep(sweepDeps(h), { state, trigger: 'sweep-now' });

    expect(result.checked).toBe(1);
    expect(result.closed).toHaveLength(1);
    expect(result.closed[0]!.taskId).toBe(taskId);

    const task = h.db.getTask(taskId)!;
    expect(task.status).toBe('done');
    expect(task.doneAt).not.toBeNull();
    expect(h.db.taskHistory(taskId).some((r) => r.field === 'status' && r.newValue === 'done' && r.changedBy === 'sweep')).toBe(true);

    const surfaces = h.db.surfacesForTask(taskId);
    expect(surfaces.some((s) => s.surfaceKind === 'auto_resolve')).toBe(true);
    expect(h.broadcasts.some((e) => e.type === 'notification' && e.payload.kind === 'auto_resolve')).toBe(true);
    expect(h.broadcasts.some((e) => e.type === 'tasks.updated')).toBe(true);
    expect(h.db.listAiDecisions({ kind: 'resolution' })).toHaveLength(1);
  });

  it("closes when the requester's inbound follow-up confirms it's handled", async () => {
    const h = makeHarness();
    const taskId = await seedTask(h);
    await processEvent(
      h.ctx,
      makeEvent({ actor: { handle: '@marian' }, text: 'ya está, gracias!', threadRef: 'T-PR', occurredAt: T1 }),
    );

    const result = await runResolutionSweep(sweepDeps(h), {
      state: createSweepState(),
      trigger: 'sweep-now',
    });
    expect(result.closed.map((c) => c.taskId)).toEqual([taskId]);
    expect(h.db.getTask(taskId)!.status).toBe('done');
  });

  it('no thread evidence ⇒ no LLM call', async () => {
    const h = makeHarness();
    const spy = spyLlm(h.llm);
    const taskId = await seedTask(h);

    const deps = { ...sweepDeps(h), llm: spy.llm };
    const result = await runResolutionSweep(deps, { state: createSweepState(), trigger: 'sweep-now' });

    expect(result.checked).toBe(0);
    expect(spy.calls).toHaveLength(0);
    expect(result.skipped).toEqual([{ taskId, reason: 'no_evidence' }]);
    expect(h.db.getTask(taskId)!.status).toBe('open');
  });

  it('unchanged thread is never re-judged (watermark) and fresh chatter honors the cooldown', async () => {
    const h = makeHarness();
    const taskId = await seedTask(h);
    await processEvent(h.ctx, myReply('will get to it after lunch'));

    const spy = spyLlm(h.llm);
    const deps = { ...sweepDeps(h), llm: spy.llm };
    const state: SweepState = createSweepState();

    const first = await runResolutionSweep(deps, { state, trigger: 'sweep-now' });
    expect(first.checked).toBe(1);
    expect(first.skipped).toEqual([expect.objectContaining({ taskId, reason: 'not_resolved' })]);
    expect(h.db.getTask(taskId)!.status).toBe('open');

    // Same thread, no new messages ⇒ watermark short-circuits before the LLM.
    const second = await runResolutionSweep(deps, { state, trigger: 'sweep-now' });
    expect(second.checked).toBe(0);
    expect(second.skipped).toEqual([{ taskId, reason: 'no_new_evidence' }]);

    // New message within the 10-min cooldown ⇒ still no LLM call.
    await processEvent(h.ctx, myReply('still on it', 'T-PR', T2));
    const third = await runResolutionSweep(deps, { state, trigger: 'sweep-now' });
    expect(third.checked).toBe(0);
    expect(third.skipped).toEqual([{ taskId, reason: 'cooldown' }]);
    expect(spy.calls).toHaveLength(1);
  });

  it('resolved below the confidence floor does NOT close', async () => {
    const h = makeHarness();
    const taskId = await seedTask(h);
    await processEvent(h.ctx, myReply('review done'));

    const lowConfidence: LlmClient = {
      chatTurn: h.llm.chatTurn.bind(h.llm),
      interrupt: h.llm.interrupt.bind(h.llm),
      structured: async <T>(req: StructuredRequest<T>): Promise<T> =>
        req.schema.parse({ resolved: true, confidence: 0.5, reason: 'maybe?' }),
    };
    const deps = { ...sweepDeps(h), llm: lowConfidence };
    const result = await runResolutionSweep(deps, { state: createSweepState(), trigger: 'sweep-now' });

    expect(result.closed).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ taskId, reason: 'below_confidence' })]);
    expect(h.db.getTask(taskId)!.status).toBe('open');
  });

  it('auto_resolve_tasks: off ⇒ the sweep is a no-op', async () => {
    const h = makeHarness();
    await seedTask(h);
    await processEvent(h.ctx, myReply('review done'));

    const result = await runResolutionSweep(sweepDeps(h, { autoResolveTasks: false }), {
      state: createSweepState(),
      trigger: 'sweep-now',
    });
    expect(result.checked).toBe(0);
    expect(h.db.listTasks('open')).toHaveLength(1);
  });

  it('caps LLM checks per sweep at 5', async () => {
    const h = makeHarness();
    for (let i = 0; i < 7; i++) {
      const thread = `T-CAP-${i}`;
      await processEvent(h.ctx, ask(`can you handle item ${i} please?`, thread));
      await processEvent(h.ctx, myReply(`item ${i} done`, thread));
    }
    expect(h.db.listTasks('open')).toHaveLength(7);

    const result = await runResolutionSweep(sweepDeps(h), {
      state: createSweepState(),
      trigger: 'sweep-now',
    });
    expect(result.checked).toBe(5);
    expect(result.closed).toHaveLength(5);
    expect(result.skipped.filter((s) => s.reason === 'sweep_cap')).toHaveLength(2);
  });

  it('ignores jira/github tasks (upstream sync owns those)', async () => {
    const h = makeHarness();
    await processEvent(
      h.ctx,
      makeEvent({
        source: 'jira',
        kind: 'issue',
        text: 'PROJ-7 Fix the flaky login test',
        meta: { key: 'PROJ-7', status: 'In Progress' },
        occurredAt: T0,
      }),
    );
    expect(h.db.listTasks('open')).toHaveLength(1);

    const result = await runResolutionSweep(sweepDeps(h), {
      state: createSweepState(),
      trigger: 'sweep-now',
    });
    expect(result.checked).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it('an LLM error on one task lands in skipped and does not abort the sweep', async () => {
    const h = makeHarness();
    await processEvent(h.ctx, ask('can you review PR 42 please?', 'T-A'));
    await processEvent(h.ctx, myReply('review done', 'T-A'));
    await processEvent(h.ctx, ask('can you send the report please?', 'T-B'));
    await processEvent(h.ctx, myReply('report sent', 'T-B', T2));

    let first = true;
    const flaky: LlmClient = {
      chatTurn: h.llm.chatTurn.bind(h.llm),
      interrupt: h.llm.interrupt.bind(h.llm),
      structured: async <T>(req: StructuredRequest<T>): Promise<T> => {
        if (first) {
          first = false;
          throw new Error('boom');
        }
        return h.llm.structured(req);
      },
    };
    const result = await runResolutionSweep(
      { ...sweepDeps(h), llm: flaky },
      { state: createSweepState(), trigger: 'sweep-now' },
    );
    expect(result.checked).toBe(2);
    expect(result.closed).toHaveLength(1);
    expect(result.skipped).toEqual([expect.objectContaining({ reason: 'error', detail: 'boom' })]);
  });

  it('a transient LLM error does not burn the evidence watermark — the task is re-checked next sweep', async () => {
    const h = makeHarness();
    const taskId = await seedTask(h);
    await processEvent(h.ctx, myReply('review done ✅'));

    let first = true;
    const flaky: LlmClient = {
      chatTurn: h.llm.chatTurn.bind(h.llm),
      interrupt: h.llm.interrupt.bind(h.llm),
      structured: async <T>(req: StructuredRequest<T>): Promise<T> => {
        if (first) {
          first = false;
          throw new Error('boom');
        }
        return h.llm.structured(req);
      },
    };
    const state = createSweepState();
    const deps = { ...sweepDeps(h), llm: flaky };

    const one = await runResolutionSweep(deps, { state, trigger: 'sweep-now', now: T1 });
    expect(one.skipped).toEqual([expect.objectContaining({ taskId, reason: 'error' })]);
    expect(h.db.getTask(taskId)!.status).toBe('open');

    // Same evidence, past the cooldown ⇒ the sweep retries the LLM call and closes.
    const two = await runResolutionSweep(deps, { state, trigger: 'sweep-now', now: T2 });
    expect(two.checked).toBe(1);
    expect(two.closed.map((c) => c.taskId)).toEqual([taskId]);
    expect(h.db.getTask(taskId)!.status).toBe('done');
  });
});
