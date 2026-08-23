import { describe, expect, it } from 'vitest';
import { processEvent } from '../../src/ingest/funnel.js';
import { toUtcInstant } from '../../src/ingest/structured.js';
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
        attendees: ['marian@acme.example', 'yo@acme.example'],
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
    expect(JSON.parse(rows[0]!.attendees!)).toEqual(['marian@acme.example', 'yo@acme.example']);
    expect(outcomeInRawLog(h.db, 'cal-1')).toBe('UPSERTED');

    // re-delivery: raw_log dedup, but the upsert stays idempotent
    expect(await processEvent(h.ctx, event)).toBe('DUPLICATE');
    expect(h.db.eventsStartingBetween('0000', '9999')).toHaveLength(1);
  });

  // Report finding #1 (MEDIUM "Ingestion" / offset-TZ): a real gcal event can
  // carry an offset like `-03:00` instead of `Z`. start_at/end_at are compared
  // lexicographically in SQL (eventsStartingBetween), so an un-canonicalized
  // offset sorts wrong against its Z twin. handleGcal must canonicalize at the
  // write side.
  it('canonicalizes an offset start/end instant to UTC Z before storing it', async () => {
    const h = makeHarness();
    const event = makeEvent({
      source: 'gcal',
      kind: 'event',
      externalId: 'cal-offset-1',
      actor: {},
      text: 'Standup',
      meta: {
        startAt: '2026-08-22T10:00:00-03:00',
        endAt: '2026-08-22T10:30:00-03:00',
      },
    });

    expect(await processEvent(h.ctx, event)).toBe('UPSERTED');
    const rows = h.db.eventsStartingBetween('0000', '9999');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.startAt).toBe('2026-08-22T13:00:00.000Z');
    expect(rows[0]!.endAt).toBe('2026-08-22T13:30:00.000Z');

    // and it now sorts correctly against a Z-form instant for the "same" wall
    // clock moment — the whole point of canonicalizing at the write side.
    expect(h.db.eventsStartingBetween('2026-08-22T12:59:00Z', '2026-08-22T13:01:00Z')).toHaveLength(1);
  });

  it('leaves a date-only string untouched (not our job — see H2 dueDateInstant)', () => {
    expect(toUtcInstant('2026-08-22')).toBe('2026-08-22');
  });

  it('passes an unparseable instant through unchanged instead of dropping it', () => {
    expect(toUtcInstant('not-a-date')).toBe('not-a-date');
  });

  it('is idempotent on an already-canonical Z instant', () => {
    expect(toUtcInstant('2026-08-22T13:00:00.000Z')).toBe('2026-08-22T13:00:00.000Z');
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

  // Report finding #2: "no jira/github reopen ... once done — a reopened
  // issue leaves the task closed forever."
  it('reopen: upstream un-closing a funnel-closed task reopens it', async () => {
    const h = makeHarness();
    await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-reopen-1', actor: {},
      text: 'FRAUD-500: tighten velocity rules',
      meta: { key: 'FRAUD-500', status: 'To Do' },
    }));
    await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-reopen-2', actor: {},
      text: 'FRAUD-500: tighten velocity rules',
      meta: { key: 'FRAUD-500', status: 'Done' },
    }));
    const closed = h.db.getTaskBySourceRef('jira', 'FRAUD-500')!;
    expect(closed.status).toBe('done');

    // upstream reopens the issue
    await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-reopen-3', actor: {},
      text: 'FRAUD-500: tighten velocity rules',
      meta: { key: 'FRAUD-500', status: 'In Progress' },
    }));
    const reopened = h.db.getTaskBySourceRef('jira', 'FRAUD-500')!;
    expect(reopened.status).toBe('open');
    expect(reopened.doneAt).toBeNull();
    expect(h.db.listTasks()).toHaveLength(1); // no second task created
    const history = h.db.taskHistory(reopened.id);
    expect(history.filter((r) => r.field === 'status' && r.newValue === 'open').at(-1)?.changedBy).toBe('funnel');
  });

  it('reopen does NOT override a task the user completed manually', async () => {
    const h = makeHarness();
    await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-manual-1', actor: {},
      text: 'FRAUD-501: tighten velocity rules',
      meta: { key: 'FRAUD-501', status: 'To Do' },
    }));
    const task = h.db.getTaskBySourceRef('jira', 'FRAUD-501')!;
    h.db.updateTask(task.id, { status: 'done', doneAt: new Date().toISOString() }, 'user');

    await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-manual-2', actor: {},
      text: 'FRAUD-501: tighten velocity rules',
      meta: { key: 'FRAUD-501', status: 'In Progress' },
    }));
    expect(h.db.getTaskBySourceRef('jira', 'FRAUD-501')!.status).toBe('done');
  });

  // Report finding #2 (title sync): "a retitled issue keeps the stale title."
  it('title sync: an upstream retitle updates the task description', async () => {
    const h = makeHarness();
    await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-retitle-1', actor: {},
      text: 'FRAUD-600: original title',
      meta: { key: 'FRAUD-600', status: 'To Do' },
    }));
    expect(h.db.getTaskBySourceRef('jira', 'FRAUD-600')!.description).toBe('FRAUD-600: original title');

    await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-retitle-2', actor: {},
      text: 'FRAUD-600: renamed to reflect the real scope',
      meta: { key: 'FRAUD-600', status: 'To Do' },
    }));
    expect(h.db.getTaskBySourceRef('jira', 'FRAUD-600')!.description).toBe(
      'FRAUD-600: renamed to reflect the real scope',
    );
  });

  // Report finding #3: "handleTaskSource creates a task for every new
  // jira/github key regardless of assignee — an issue assigned to someone
  // else becomes the user's task."
  it('assignee gating: an issue assigned to a known teammate does not become a task', async () => {
    const h = makeHarness();
    const outcome = await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-assignee-1', actor: {},
      text: 'FRAUD-700: not mine',
      meta: { key: 'FRAUD-700', status: 'To Do', assignee: { email: 'marian@acme.example' } },
    }));
    expect(outcome).toBe('CLASSIFIED_OUT');
    expect(h.db.getTaskBySourceRef('jira', 'FRAUD-700')).toBeUndefined();
    expect(h.db.listTasks()).toEqual([]);
    expect(outcomeInRawLog(h.db, 'jira-assignee-1')).toBe('CLASSIFIED_OUT');
  });

  it('assignee gating: an unresolvable/absent assignee keeps current behavior (task created)', async () => {
    const h = makeHarness();
    await processEvent(h.ctx, makeEvent({
      source: 'jira', kind: 'issue', externalId: 'jira-assignee-2', actor: {},
      text: 'FRAUD-701: assignee unknown to botty',
      meta: { key: 'FRAUD-701', status: 'To Do', assignee: { email: 'ghost@acme.example' } },
    }));
    expect(h.db.getTaskBySourceRef('jira', 'FRAUD-701')).toBeDefined();
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

  it('reopen: a merged PR reverted back to open reopens the task', async () => {
    const h = makeHarness();
    await processEvent(h.ctx, makeEvent({
      source: 'github', kind: 'pr', externalId: 'gh-reopen-1', actor: {},
      text: 'Fix flaky login test',
      meta: { repo: 'acme-example/checkout', number: 99, state: 'open' },
    }));
    await processEvent(h.ctx, makeEvent({
      source: 'github', kind: 'pr', externalId: 'gh-reopen-2', actor: {},
      text: 'Fix flaky login test',
      meta: { repo: 'acme-example/checkout', number: 99, state: 'closed' },
    }));
    expect(h.db.getTaskBySourceRef('github', 'acme-example/checkout#99')!.status).toBe('done');

    await processEvent(h.ctx, makeEvent({
      source: 'github', kind: 'pr', externalId: 'gh-reopen-3', actor: {},
      text: 'Fix flaky login test',
      meta: { repo: 'acme-example/checkout', number: 99, state: 'open' },
    }));
    expect(h.db.getTaskBySourceRef('github', 'acme-example/checkout#99')!.status).toBe('open');
    expect(h.db.listTasks()).toHaveLength(1);
  });

  it('assignee gating: a PR assigned to a known teammate does not become a task', async () => {
    const h = makeHarness();
    const outcome = await processEvent(h.ctx, makeEvent({
      source: 'github', kind: 'pr', externalId: 'gh-assignee-1', actor: {},
      text: 'Bump dependency',
      meta: {
        repo: 'acme-example/checkout',
        number: 123,
        state: 'open',
        assignee: { handle: '@rai' },
      },
    }));
    expect(outcome).toBe('CLASSIFIED_OUT');
    expect(h.db.getTaskBySourceRef('github', 'acme-example/checkout#123')).toBeUndefined();
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
