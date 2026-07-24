import { describe, expect, it, vi } from 'vitest';
import { BACKFILL_SOURCES, type BackfillStartRequest, type SourceEvent } from '@botty/shared';
import { parseHeartbeat } from '../../src/config/parse.js';
import type { AdapterMap, HistoryPage, SourceAdapter } from '../../src/ingest/adapters/index.js';
import { sinceKey } from '../../src/ingest/scheduler.js';
import { BACKFILL_STATE_KEY, createBackfill, processHistoricalEvent, type Backfill, type BackfillCtx } from '../../src/backfill/index.js';
import { makeEvent, makeHarness, type Harness } from '../ingest/helpers.js';

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

const startReq = (over: Partial<BackfillStartRequest> = {}): BackfillStartRequest => ({
  days: 30,
  maxLlmCalls: 50,
  resume: false,
  ...over,
});

/** Adapter serving `pages` of history; records fetchHistory calls. */
function pagedAdapter(source: SourceAdapter['source'], pages: SourceEvent[][]): SourceAdapter {
  return {
    source,
    fetch: async () => [],
    async fetchHistory({ cursor }): Promise<HistoryPage> {
      const idx = cursor ? Number(cursor) : 0;
      return {
        events: pages[idx] ?? [],
        nextCursor: idx + 1 < pages.length ? String(idx + 1) : null,
      };
    },
  };
}

function makeAdapters(overrides: Partial<AdapterMap> = {}): AdapterMap {
  const empty = (source: SourceAdapter['source']): SourceAdapter =>
    pagedAdapter(source, []);
  return {
    slack: empty('slack'),
    gmail: empty('gmail'),
    gcal: empty('gcal'),
    jira: empty('jira'),
    github: empty('github'),
    ...overrides,
  };
}

function makeBackfill(h: Harness, adapters: AdapterMap, heartbeatMd = ''): { backfill: Backfill; ctx: BackfillCtx } {
  const heartbeat = parseHeartbeat(heartbeatMd, 'sim');
  const ctx: BackfillCtx = { db: h.db, llm: h.llm, bus: h.bus, config: { heartbeat: () => heartbeat } };
  return { backfill: createBackfill(ctx, adapters), ctx };
}

async function waitDone(backfill: Backfill, timeoutMs = 5_000): Promise<void> {
  const t0 = Date.now();
  while (backfill.status().status === 'running') {
    if (Date.now() - t0 > timeoutMs) throw new Error('backfill did not finish');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('processHistoricalEvent', () => {
  it('slack/gmail: raw_log marked, interaction with true occurred_at, discovered person, INTERACTION_ONLY stamp, no tasks', () => {
    const h = makeHarness();
    const event = makeEvent({
      externalId: 'hist-1',
      actor: { handle: '@newperson', displayName: 'New Person' },
      text: 'can you review the doc? we decided to ship Friday',
      occurredAt: daysAgo(10),
      threadRef: 'H-t1',
    });
    expect(processHistoricalEvent(h.ctx, event)).toBe('new');
    expect(processHistoricalEvent(h.ctx, event)).toBe('duplicate');

    const row = h.db.listRawLog({ source: 'slack' }).find((r) => r.externalId === 'hist-1')!;
    const body = JSON.parse(row.body) as { meta: Record<string, unknown> };
    expect(body.meta.backfill).toBe(true);
    expect(body.meta.funnelOutcome).toBe('INTERACTION_ONLY');
    expect((body.meta.funnelDetail as Record<string, unknown>).backfill).toBe(true);

    // despite task/decision signal text: NO task, NO LLM call — context only
    expect(h.db.listTasks('open')).toHaveLength(0);
    expect(h.db.listAiDecisions({ limit: 100 })).toHaveLength(0);

    const person = h.db.getPersonByName('New Person')!;
    expect(person.tier).toBe(2);
    expect(person.source).toBe('discovered');
    expect(person.lastInteractionAt).toBe(event.occurredAt);
  });

  it('outbound rows log a person-less interaction and never discover the user', () => {
    const h = makeHarness();
    const event = makeEvent({
      externalId: 'hist-out',
      direction: 'outbound',
      actor: { email: 'yo@maxolabs.io', displayName: 'Maxo' },
      text: 'done — sent it over',
      occurredAt: daysAgo(5),
    });
    expect(processHistoricalEvent(h.ctx, event)).toBe('new');
    expect(h.db.getPersonByName('Maxo')).toBeUndefined();
  });

  it('gcal history upserts calendar_events with past start times', () => {
    const h = makeHarness();
    const event = makeEvent({
      source: 'gcal',
      kind: 'event',
      externalId: 'hist-cal',
      text: 'Q1 retro',
      occurredAt: daysAgo(20),
      meta: { startAt: daysAgo(20), endAt: daysAgo(20), attendees: ['marian@acme.example'] },
    });
    expect(processHistoricalEvent(h.ctx, event)).toBe('new');
    const cal = h.db.eventsStartingBetween(daysAgo(21), daysAgo(19)).find((c) => c.externalId === 'hist-cal')!;
    expect(cal.title).toBe('Q1 retro');
    expect(h.db.listTasks('open')).toHaveLength(0);
  });
});

describe('backfill runner', () => {
  it('pages through sources, counts new/duplicates, never touches ingest.lastCheck, ends done', async () => {
    const h = makeHarness();
    const dupe = makeEvent({ externalId: 'dupe-1', occurredAt: daysAgo(3) });
    const adapters = makeAdapters({
      slack: pagedAdapter('slack', [
        [makeEvent({ occurredAt: daysAgo(2) }), dupe],
        [dupe, makeEvent({ occurredAt: daysAgo(9) })],
      ]),
      gmail: pagedAdapter('gmail', [[makeEvent({ source: 'gmail', kind: 'email', occurredAt: daysAgo(1) })]]),
    });
    const { backfill } = makeBackfill(h, adapters);

    const res = backfill.start(startReq({ sources: ['slack', 'gmail'], maxLlmCalls: 0 }));
    expect(res.started).toBe(true);
    expect(res.state.status).toBe('running');
    await waitDone(backfill);

    const state = backfill.status();
    expect(state.status).toBe('done');
    expect(state.finishedAt).not.toBeNull();
    expect(state.sources.slack).toMatchObject({ fetched: 4, newEvents: 3, duplicates: 1, done: true, error: null });
    expect(state.sources.gmail).toMatchObject({ fetched: 1, newEvents: 1, done: true });
    expect(state.distill.done).toBe(true); // cap 0 ⇒ phase skipped

    expect(h.db.listTasks('open')).toHaveLength(0);
    for (const s of BACKFILL_SOURCES) expect(h.db.getSetting(sinceKey(s))).toBeUndefined();
    // state persisted under the agent-owned key and progress broadcast
    expect(h.db.getSetting(BACKFILL_STATE_KEY)).toMatchObject({ status: 'done' });
    expect(h.broadcasts.some((e) => e.type === 'backfill.progress')).toBe(true);
  });

  it('a second start while running reports alreadyRunning', async () => {
    const h = makeHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: SourceAdapter = {
      source: 'slack',
      fetch: async () => [],
      async fetchHistory() {
        await gate;
        return { events: [], nextCursor: null };
      },
    };
    const { backfill } = makeBackfill(h, makeAdapters({ slack: slow }));
    expect(backfill.start(startReq({ sources: ['slack'] })).started).toBe(true);
    const second = backfill.start(startReq({ sources: ['slack'] }));
    expect(second.started).toBe(false);
    expect(second.alreadyRunning).toBe(true);
    release();
    await waitDone(backfill);
  });

  it('per-source error (real M4 stub shape) is recorded without aborting other sources', async () => {
    const h = makeHarness();
    const failing: SourceAdapter = {
      source: 'slack',
      fetch: async () => [],
      async fetchHistory(): Promise<HistoryPage> {
        throw new Error('real slack history driver not implemented yet (M4)');
      },
    };
    const adapters = makeAdapters({
      slack: failing,
      gmail: pagedAdapter('gmail', [[makeEvent({ source: 'gmail', kind: 'email', occurredAt: daysAgo(1) })]]),
    });
    const { backfill } = makeBackfill(h, adapters);
    backfill.start(startReq({ sources: ['slack', 'gmail'], maxLlmCalls: 0 }));
    await waitDone(backfill);

    const state = backfill.status();
    expect(state.status).toBe('done'); // one source still succeeded
    expect(state.sources.slack!.error).toMatch(/M4/);
    expect(state.sources.gmail).toMatchObject({ newEvents: 1, done: true });
  });

  it('all sources failing ends the run in error status', async () => {
    const h = makeHarness();
    const { backfill } = makeBackfill(h, makeAdapters({ slack: { source: 'slack', fetch: async () => [] } }));
    backfill.start(startReq({ sources: ['slack'], maxLlmCalls: 0 }));
    await waitDone(backfill);
    const state = backfill.status();
    expect(state.status).toBe('error');
    expect(state.sources.slack!.error).toMatch(/no history driver/);
  });

  it('a disabled source is skipped with an explanatory error', async () => {
    const h = makeHarness();
    const { backfill } = makeBackfill(
      h,
      makeAdapters({ slack: pagedAdapter('slack', [[makeEvent({ occurredAt: daysAgo(1) })]]) }),
      '## Sources\nslack: off\n',
    );
    backfill.start(startReq({ sources: ['slack'], maxLlmCalls: 0 }));
    await waitDone(backfill);
    expect(backfill.status().sources.slack!.error).toMatch(/disabled in heartbeat\.md/);
  });

  it('cancel persists the cursor and resume continues from it', async () => {
    const h = makeHarness();
    const pages: SourceEvent[][] = [
      [makeEvent({ externalId: 'p0', occurredAt: daysAgo(1) })],
      [makeEvent({ externalId: 'p1', occurredAt: daysAgo(2) })],
      [makeEvent({ externalId: 'p2', occurredAt: daysAgo(3) })],
    ];
    let fetches = 0;
    const adapter: SourceAdapter = {
      source: 'slack',
      fetch: async () => [],
      async fetchHistory({ cursor }): Promise<HistoryPage> {
        fetches += 1;
        const idx = cursor ? Number(cursor) : 0;
        return { events: pages[idx] ?? [], nextCursor: idx + 1 < pages.length ? String(idx + 1) : null };
      },
    };
    const { backfill } = makeBackfill(h, makeAdapters({ slack: adapter }));
    backfill.start(startReq({ sources: ['slack'], maxLlmCalls: 0 }));
    // cancel during the inter-page pause after the first page lands
    await vi.waitFor(() => expect(backfill.status().sources.slack!.fetched).toBeGreaterThan(0));
    backfill.cancel();
    await waitDone(backfill);

    const cancelled = backfill.status();
    expect(cancelled.status).toBe('cancelled');
    const fetchedBefore = cancelled.sources.slack!.fetched;
    expect(fetchedBefore).toBeLessThan(3);
    expect(cancelled.sources.slack!.cursor).not.toBeNull();

    const resumed = backfill.start(startReq({ sources: ['slack'], maxLlmCalls: 0, resume: true }));
    expect(resumed.started).toBe(true);
    await waitDone(backfill);
    const final = backfill.status();
    expect(final.status).toBe('done');
    expect(final.sources.slack!.done).toBe(true);
    // all three unique events landed exactly once across both runs
    const ids = h.db.listRawLog({ source: 'slack', limit: 100 }).map((r) => r.externalId).sort();
    expect(ids).toEqual(['p0', 'p1', 'p2']);
  });

  it('a re-run after done fully dedups', async () => {
    const h = makeHarness();
    const events = [makeEvent({ externalId: 'r0', occurredAt: daysAgo(2) })];
    const { backfill } = makeBackfill(h, makeAdapters({ slack: pagedAdapter('slack', [events]) }));
    backfill.start(startReq({ sources: ['slack'], maxLlmCalls: 0 }));
    await waitDone(backfill);
    expect(backfill.status().sources.slack!.newEvents).toBe(1);

    backfill.start(startReq({ sources: ['slack'], maxLlmCalls: 0 }));
    await waitDone(backfill);
    const state = backfill.status();
    expect(state.status).toBe('done');
    expect(state.sources.slack).toMatchObject({ newEvents: 0, duplicates: 1 });
  });

  it('normalizes a stale running state (crash) to error on read', () => {
    const h = makeHarness();
    const { backfill } = makeBackfill(h, makeAdapters());
    h.db.setSetting(BACKFILL_STATE_KEY, {
      ...backfill.status(),
      status: 'running',
      startedAt: daysAgo(1),
      window: { days: 30, oldest: daysAgo(30) },
    });
    expect(backfill.status().status).toBe('error');
  });
});
