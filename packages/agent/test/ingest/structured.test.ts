import { describe, expect, it } from 'vitest';
import { processEvent } from '../../src/ingest/funnel.js';
import { meetingPrepCandidates } from '../../src/ingest/structured.js';
import { makeEvent, makeHarness, outcomeInRawLog } from './helpers.js';

describe('gcal', () => {
  it('upserts calendar_events (not tasks) and raw-logs the event', async () => {
    const h = makeHarness();
    const startAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const event = makeEvent({
      source: 'gcal',
      kind: 'event',
      externalId: 'cal-1',
      actor: {},
      text: 'Sprint planning',
      meta: {
        startAt,
        endAt: new Date(Date.now() + 90 * 60_000).toISOString(),
        attendees: ['marian@acme.example', 'yo@maxolabs.io'],
        location: 'Room 3',
      },
    });

    expect(await processEvent(h.ctx, event)).toBe('UPSERTED');
    expect(h.db.listTasks()).toEqual([]); // never a task

    const rows = h.db.eventsStartingBetween('0000', '9999');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Sprint planning');
    expect(rows[0]!.startAt).toBe(startAt);
    expect(rows[0]!.location).toBe('Room 3');
    expect(JSON.parse(rows[0]!.attendees!)).toEqual(['marian@acme.example', 'yo@maxolabs.io']);
    expect(outcomeInRawLog(h.db, 'cal-1')).toBe('UPSERTED');

    // re-delivery: raw_log dedup, but the upsert stays idempotent
    expect(await processEvent(h.ctx, event)).toBe('DUPLICATE');
    expect(h.db.eventsStartingBetween('0000', '9999')).toHaveLength(1);
  });

  it('meetingPrepCandidates: upcoming events with a tier-1 attendee within the lead window', async () => {
    const h = makeHarness();
    const now = Date.now();
    const soon = new Date(now + 30 * 60_000).toISOString();
    const far = new Date(now + 5 * 3_600_000).toISOString();

    await processEvent(h.ctx, makeEvent({
      source: 'gcal', kind: 'event', externalId: 'cal-soon', actor: {},
      text: '1:1 with Marian',
      meta: { startAt: soon, attendees: ['marian@acme.example', 'yo@maxolabs.io'] },
    }));
    await processEvent(h.ctx, makeEvent({
      source: 'gcal', kind: 'event', externalId: 'cal-far', actor: {},
      text: 'Way later sync',
      meta: { startAt: far, attendees: ['marian@acme.example'] },
    }));
    await processEvent(h.ctx, makeEvent({
      source: 'gcal', kind: 'event', externalId: 'cal-tier2', actor: {},
      text: 'Coffee with Rai',
      meta: { startAt: soon, attendees: ['rai@acme.example'] }, // tier 2 only
    }));

    const candidates = meetingPrepCandidates(h.db, { now: new Date(now).toISOString(), leadMin: 60 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.event.title).toBe('1:1 with Marian');
    expect(candidates[0]!.tier1Attendees.map((p) => p.name)).toEqual(['Marian']);
  });
});

describe('jira', () => {
  it('open assigned issue upserts a task directly (source_ref = issue key)', async () => {
    const h = makeHarness();
    const event = makeEvent({
      source: 'jira',
      kind: 'issue',
      externalId: 'jira-ev-1',
      actor: {},
      text: 'FRAUD-123: tighten velocity rules\nLong body here',
      meta: { key: 'FRAUD-123', status: 'In Progress', url: 'https://jira/FRAUD-123' },
    });

    expect(await processEvent(h.ctx, event)).toBe('UPSERTED');

    const task = h.db.getTaskBySourceRef('jira', 'FRAUD-123');
    expect(task).toBeDefined();
    expect(task!.status).toBe('open');
    expect(task!.description).toBe('FRAUD-123: tighten velocity rules'); // first line only
    expect(h.db.listAiDecisions()).toEqual([]); // skipped classifier/extractor
    expect(h.broadcasts.some((e) => e.type === 'tasks.updated')).toBe(true);
  });

  it('status sync: upstream Done closes the task via task_history changed_by=funnel', async () => {
    const h = makeHarness();
    await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-ev-open', actor: {},
      text: 'FRAUD-123: tighten velocity rules',
      meta: { key: 'FRAUD-123', status: 'To Do' },
    }));
    // upstream state change arrives as a new event (new externalId, same key)
    expect(await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-ev-done', actor: {},
      text: 'FRAUD-123: tighten velocity rules',
      meta: { key: 'FRAUD-123', status: 'Done' },
    }))).toBe('UPSERTED');

    const task = h.db.getTaskBySourceRef('jira', 'FRAUD-123')!;
    expect(task.status).toBe('done');
    expect(task.doneAt).not.toBeNull();
    expect(h.db.listTasks()).toHaveLength(1); // no second task created

    const history = h.db.taskHistory(task.id);
    const close = history.find((row) => row.field === 'status' && row.newValue === 'done');
    expect(close).toBeDefined();
    expect(close!.changedBy).toBe('funnel');
  });

  it('already-closed upstream issue with no local task creates nothing', async () => {
    const h = makeHarness();
    await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-ev-closed', actor: {},
      text: 'OLD-1: ancient issue',
      meta: { key: 'OLD-1', status: 'Closed' },
    }));
    expect(h.db.listTasks()).toEqual([]);
  });
});

describe('github', () => {
  it('assigned PR upserts a task with repo#number ref; merged state closes it', async () => {
    const h = makeHarness();
    await processEvent(h.ctx, makeEvent({
      source: 'github', kind: 'pr', externalId: 'gh-ev-1', actor: {},
      text: 'Fix flaky checkout test',
      meta: { repo: 'acme-example/checkout', number: 88, state: 'open', url: 'https://gh/88' },
    }));

    const task = h.db.getTaskBySourceRef('github', 'acme-example/checkout#88');
    expect(task).toBeDefined();
    expect(task!.status).toBe('open');

    await processEvent(h.ctx, makeEvent({
      source: 'github', kind: 'pr', externalId: 'gh-ev-2', actor: {},
      text: 'Fix flaky checkout test',
      meta: { repo: 'acme-example/checkout', number: 88, state: 'merged' },
    }));

    const closed = h.db.getTaskBySourceRef('github', 'acme-example/checkout#88')!;
    expect(closed.status).toBe('done');
    expect(h.db.taskHistory(closed.id).some((r) => r.changedBy === 'funnel' && r.newValue === 'done')).toBe(true);
  });
});

describe('cross-source dedup on the structured path (live repro: slack first, github second)', () => {
  it('a slack-extracted PR-review task dedups the later github event for the same PR', async () => {
    const h = makeHarness();

    // slack check-now first: Marian's DM goes through the full funnel and becomes a task
    const slackEvent = makeEvent({
      externalId: 'slack-repro-482',
      text: 'Hola! Can you review the fraud-rules PR #482 when you get a chance?',
    });
    expect(await processEvent(h.ctx, slackEvent)).toBe('EXTRACTED');
    expect(h.db.listTasks()).toHaveLength(1);
    const slackTaskId = h.db.listTasks()[0]!.id;

    // github check-now second: the structured event for the SAME PR must not
    // become a second open task (this exact order was the live e2e gap)
    const githubEvent = makeEvent({
      source: 'github',
      kind: 'pr',
      externalId: 'gh-repro-482',
      actor: {},
      text: 'Review requested: acme-example/fraud-rules#482',
      meta: { repo: 'acme-example/fraud-rules', number: 482, state: 'open' },
    });
    expect(await processEvent(h.ctx, githubEvent)).toBe('DEDUPED');
    expect(h.db.listTasks()).toHaveLength(1);

    // the stamp names the surviving task for the Inspector
    const row = h.db.listRawLog().find((r) => r.externalId === 'gh-repro-482')!;
    const body = JSON.parse(row.body) as {
      meta: { funnelDetail?: { dedupedTasks?: { existingTaskId: string }[] } };
    };
    expect(body.meta.funnelDetail?.dedupedTasks?.[0]?.existingTaskId).toBe(slackTaskId);
  });

  it('a github event for a DIFFERENT PR number is not deduped — both tasks survive', async () => {
    const h = makeHarness();
    expect(
      await processEvent(h.ctx, makeEvent({
        externalId: 'slack-repro-482b',
        text: 'Hola! Can you review the fraud-rules PR #482 when you get a chance?',
      })),
    ).toBe('EXTRACTED');

    expect(
      await processEvent(h.ctx, makeEvent({
        source: 'github', kind: 'pr', externalId: 'gh-repro-483', actor: {},
        text: 'Review requested: acme-example/fraud-rules#483',
        meta: { repo: 'acme-example/fraud-rules', number: 483, state: 'open' },
      })),
    ).toBe('UPSERTED');

    expect(h.db.listTasks()).toHaveLength(2);
  });

  it('jira symmetric: a slack-extracted task naming ACME-123 dedups the later jira issue event', async () => {
    const h = makeHarness();
    expect(
      await processEvent(h.ctx, makeEvent({
        externalId: 'slack-acme-123',
        text: 'Can you look at ACME-123 velocity rules today please?',
      })),
    ).toBe('EXTRACTED');
    const slackTaskId = h.db.listTasks()[0]!.id;

    expect(
      await processEvent(h.ctx, makeEvent({
        source: 'jira', kind: 'issue', externalId: 'jira-acme-123', actor: {},
        text: 'ACME-123: tighten velocity rules',
        meta: { key: 'ACME-123', status: 'To Do' },
      })),
    ).toBe('DEDUPED');

    expect(h.db.listTasks()).toHaveLength(1);
    expect(h.db.listTasks()[0]!.id).toBe(slackTaskId);
    // no jira task row was created for the ref (accepted v1 trade-off: upstream
    // status sync for ACME-123 won't attach — see handleTaskSource comment)
    expect(h.db.getTaskBySourceRef('jira', 'ACME-123')).toBeUndefined();
  });

  it('jira negative: a different issue key still inserts its own task', async () => {
    const h = makeHarness();
    expect(
      await processEvent(h.ctx, makeEvent({
        externalId: 'slack-acme-123b',
        text: 'Can you look at ACME-123 velocity rules today please?',
      })),
    ).toBe('EXTRACTED');

    expect(
      await processEvent(h.ctx, makeEvent({
        source: 'jira', kind: 'issue', externalId: 'jira-acme-999', actor: {},
        text: 'ACME-999: tighten velocity rules',
        meta: { key: 'ACME-999', status: 'To Do' },
      })),
    ).toBe('UPSERTED');

    expect(h.db.listTasks()).toHaveLength(2);
  });
});
