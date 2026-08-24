import { describe, expect, it, vi } from 'vitest';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { makeDecisionRecorder, makeModelResolver } from '../../src/llm/index.js';
import type { QueryFn, SdkMessageLike } from '../../src/llm/sdk.js';
import { createConnectorFetch, connectorEnv } from '../../src/ingest/adapters/real/connector.js';
import { createGmailAdapter } from '../../src/ingest/adapters/real/gmail.js';
import { createGcalAdapter } from '../../src/ingest/adapters/real/gcal.js';
import { toSourceEvents, MAX_EVENTS_PER_FETCH, MAX_PAGES_PER_CHECK } from '../../src/ingest/adapters/real/normalize.js';
import { createAdapters, makeRealFamilyLoader } from '../../src/ingest/adapters/index.js';

/** QueryFn replaying canned final texts, capturing the options of every call. */
function stubQueryFn(
  responses: string[],
  calls: { prompt: unknown; options: Record<string, unknown> }[] = [],
): QueryFn {
  let i = 0;
  return ({ prompt, options }) => {
    calls.push({ prompt, options: options ?? {} });
    const text = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    const messages: SdkMessageLike[] = [
      { type: 'system', subtype: 'init', session_id: 'prov-fetch' },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: text,
        usage: { input_tokens: 20, output_tokens: 10 },
      },
    ];
    return {
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
      interrupt: async () => {},
    };
  };
}

function makeFetch(responses: string[], calls: { prompt: unknown; options: Record<string, unknown> }[] = []) {
  const db = new Db(':memory:');
  const bus = createBus();
  const fetchViaConnector = createConnectorFetch({
    queryFn: stubQueryFn(responses, calls),
    modelFor: makeModelResolver(db),
    record: makeDecisionRecorder(db, bus),
  });
  return { db, bus, fetchViaConnector };
}

const GMAIL_BATCH = JSON.stringify({
  events: [
    {
      externalId: 'msg-1',
      kind: 'email',
      actor: { email: 'diego@acme.example', displayName: 'Diego' },
      direction: 'inbound',
      text: 'Subject: Q3 numbers\n\nCan you send the Q3 numbers by Friday?',
      threadRef: 'thread-1',
      occurredAt: '2026-07-27T09:00:00Z',
      meta: { subject: 'Q3 numbers', to: ['me@acme.example'] },
    },
    {
      externalId: 'msg-2',
      kind: 'email',
      actor: { email: 'me@acme.example' },
      direction: 'outbound',
      text: 'Subject: Re: Q3 numbers\n\nOn it, sending tomorrow.',
      threadRef: 'thread-1',
      occurredAt: '2026-07-27T09:05:00Z',
      meta: {},
    },
  ],
});

describe('real gmail adapter', () => {
  it('returns validated SourceEvents with the gmail source stamped', async () => {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const { fetchViaConnector } = makeFetch([GMAIL_BATCH], calls);
    const adapter = createGmailAdapter(fetchViaConnector);
    const events = await adapter.fetch('2026-07-27T08:00:00Z');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ source: 'gmail', externalId: 'msg-1', direction: 'inbound' });
    expect(events[1]).toMatchObject({ source: 'gmail', direction: 'outbound', threadRef: 'thread-1' });
    // The since window must reach the prompt.
    expect(String(calls[0]!.prompt)).toContain('2026-07-27T08:00:00Z');
  });

  // Report finding #6 (Appendix B): the real gmail prompt used to explicitly
  // say "keep newsletters and notification emails" — they pollute the people
  // table and eat cap pressure. The prompt must now tell the model to drop
  // bulk/automated mail using List-Unsubscribe / bulk-precedence signals.
  it('prompt instructs the model to skip newsletters/bulk mail, not keep them', async () => {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const { fetchViaConnector } = makeFetch([GMAIL_BATCH], calls);
    await createGmailAdapter(fetchViaConnector).fetch(null);
    const prompt = String(calls[0]!.prompt);
    expect(prompt).toContain('List-Unsubscribe');
    expect(prompt).toMatch(/newsletter/i);
    expect(prompt).not.toMatch(/keep newsletters/i);
  });

  it('isolates the SDK run: no settings, allowlisted read tools, stripped auth env', async () => {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const { fetchViaConnector } = makeFetch([GMAIL_BATCH], calls);
    process.env.ANTHROPIC_API_KEY = 'sk-test-should-be-stripped';
    try {
      await createGmailAdapter(fetchViaConnector).fetch(null);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    const options = calls[0]!.options;
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.persistSession).toBe(false);
    expect(options).not.toHaveProperty('tools');
    const allowed = options.allowedTools as string[];
    expect(allowed).toContain('ToolSearch');
    expect(allowed).toContain('mcp__claude_ai_Gmail__search_threads');
    const disallowed = options.disallowedTools as string[];
    for (const t of ['Bash', 'Read', 'Write', 'WebFetch', 'Task']) expect(disallowed).toContain(t);
    const env = options.env as Record<string, string>;
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('records a fetch ai_decision on success', async () => {
    const { db, fetchViaConnector } = makeFetch([GMAIL_BATCH]);
    await createGmailAdapter(fetchViaConnector).fetch(null);
    const rows = db.listAiDecisions({ kind: 'fetch' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'fetch', relatedRef: 'ingest:gmail' });
  });

  it('retries once on malformed output, then succeeds', async () => {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const { fetchViaConnector } = makeFetch(['not json at all', GMAIL_BATCH], calls);
    const events = await createGmailAdapter(fetchViaConnector).fetch(null);
    expect(events).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(String(calls[1]!.prompt)).toContain('could not be used');
  });

  it('throws (and records the error) when output stays invalid after the retry', async () => {
    const { db, fetchViaConnector } = makeFetch(['garbage', 'still garbage']);
    await expect(createGmailAdapter(fetchViaConnector).fetch(null)).rejects.toThrow(/failed validation after retry/);
    const rows = db.listAiDecisions({ kind: 'fetch' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toMatch(/parse failed after retry/);
  });

  it('rewrites auth-shaped SDK errors into a connector-login hint', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    const failingQueryFn: QueryFn = () => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkMessageLike> {
        throw new Error('Credit balance is too low');
      },
    });
    const fetchViaConnector = createConnectorFetch({
      queryFn: failingQueryFn,
      modelFor: makeModelResolver(db),
      record: makeDecisionRecorder(db, bus),
    });
    await expect(createGmailAdapter(fetchViaConnector).fetch(null)).rejects.toThrow(/claude\.ai connectors/);
  });
});

/** Build a gmail WireBatch JSON body with `count` events, OLDEST FIRST
 * (ascending), `spacingMinutes` apart, starting at `startIso`. Returns the
 * JSON body plus the newest (last) event's occurredAt, since that's the
 * timestamp the adapter should advance its "after" cursor to. */
function gmailBatch(
  count: number,
  startIso: string,
  spacingMinutes = 5,
): { json: string; newestIso: string } {
  const start = new Date(startIso).getTime();
  const events = Array.from({ length: count }, (_, i) => ({
    externalId: `msg-${startIso}-${i}`,
    kind: 'email',
    actor: { email: 'diego@acme.example', displayName: 'Diego' },
    direction: 'inbound',
    text: `Subject: msg ${i}\n\nbody ${i}`,
    threadRef: `thread-${i}`,
    occurredAt: new Date(start + i * spacingMinutes * 60_000).toISOString(),
    meta: {},
  }));
  const newestIso = events.length > 0 ? events[events.length - 1]!.occurredAt : startIso;
  return { json: JSON.stringify({ events }), newestIso };
}

describe('real gmail adapter backlog paging (H5)', () => {
  it('drains a 75-message backlog across pages, oldest-first, without dropping anything', async () => {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const since = '2026-07-20T00:00:00Z';
    // Page 1: 30 oldest, page 2: 30 more (continuing forward), page 3: 15 (< MAX_EVENTS_PER_FETCH ⇒ drained).
    const page1 = gmailBatch(30, since);
    const page2 = gmailBatch(30, page1.newestIso);
    const page3 = gmailBatch(15, page2.newestIso);
    const { fetchViaConnector } = makeFetch([page1.json, page2.json, page3.json], calls);
    const adapter = createGmailAdapter(fetchViaConnector);
    const result = await adapter.fetchWindow!(since);

    expect(result.events).toHaveLength(75);
    expect(result.truncated).toBe(false);
    expect(calls).toHaveLength(3);
    // Each page after the first must carry an explicit forward (after) bound —
    // the newest timestamp actually fetched so far — so the connector doesn't
    // just hand back the same oldest messages again.
    expect(String(calls[0]!.prompt)).toContain(`at or after ${since}`);
    expect(String(calls[1]!.prompt)).toContain(`at or after ${page1.newestIso}`);
    expect(String(calls[2]!.prompt)).toContain(`at or after ${page2.newestIso}`);
  });

  it('honors the page cap, marks the check truncated, and advances the watermark to the newest fetched message (not the floor)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const since = '2026-07-01T00:00:00Z';
      // Every page comes back full (30) — the backlog is bigger than
      // MAX_PAGES_PER_CHECK can drain in one check.
      const responses: string[] = [];
      let cursor = since;
      let lastNewest = since;
      for (let i = 0; i < MAX_PAGES_PER_CHECK; i++) {
        const page = gmailBatch(30, cursor);
        responses.push(page.json);
        cursor = page.newestIso;
        lastNewest = page.newestIso;
      }
      const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
      const { fetchViaConnector } = makeFetch(responses, calls);
      const adapter = createGmailAdapter(fetchViaConnector);
      const result = await adapter.fetchWindow!(since);

      expect(calls).toHaveLength(MAX_PAGES_PER_CHECK); // page cap honored — no unbounded paging
      expect(result.events).toHaveLength(MAX_PAGES_PER_CHECK * 30);
      expect(result.truncated).toBe(true);
      // Forward progress, not a re-pin at the floor: the watermark advances to
      // the newest message actually fetched, so the next poll continues from
      // here instead of re-scanning (and re-capping on) the same window forever.
      expect(result.nextSince).toBe(lastNewest);
      expect(result.nextSince).not.toBe(since);
      expect(warn).toHaveBeenCalled(); // truncation is observable
    } finally {
      warn.mockRestore();
    }
  });

  it('a window of ~200 messages fully drains across successive polls (forward progress, no repeats)', async () => {
    // Simulates the scheduler calling fetchWindow again each poll, feeding the
    // previous result's nextSince in as the next `since` — exactly what H5
    // requires: a backlog bigger than one check's page budget must still fully
    // drain within a bounded number of polls, never loop on the same window.
    // Unlike the other tests here, the stub actually honors the "at or after"
    // bound in the prompt, so this exercises real forward progress rather than
    // a hand-scripted response sequence.
    const since = '2026-06-01T00:00:00Z';
    const TOTAL = 200;
    const start = Date.parse(since);
    const world = Array.from({ length: TOTAL }, (_, i) => ({
      externalId: `world-${i}`,
      kind: 'email',
      actor: { email: 'diego@acme.example' },
      direction: 'inbound' as const,
      text: `Subject: msg ${i}\n\nbody ${i}`,
      threadRef: `thread-${i}`,
      occurredAt: new Date(start + i * 5 * 60_000).toISOString(),
      meta: {},
    }));

    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const worldQueryFn: QueryFn = ({ prompt, options }) => {
      calls.push({ prompt, options: options ?? {} });
      const match = String(prompt).match(/at or after (\S+) \(UTC\)/);
      const afterMs = match ? Date.parse(match[1]!) : start;
      const page = world
        .filter((e) => Date.parse(e.occurredAt) >= afterMs)
        .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
        .slice(0, MAX_EVENTS_PER_FETCH);
      const messages: SdkMessageLike[] = [
        { type: 'system', subtype: 'init', session_id: 'prov-fetch' },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: JSON.stringify({ events: page }),
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          yield* messages;
        },
        interrupt: async () => {},
      };
    };
    const db = new Db(':memory:');
    const bus = createBus();
    const fetchViaConnector = createConnectorFetch({
      queryFn: worldQueryFn,
      modelFor: makeModelResolver(db),
      record: makeDecisionRecorder(db, bus),
    });
    const adapter = createGmailAdapter(fetchViaConnector);

    let cursor: string | null = since;
    const seen = new Set<string>();
    let polls = 0;
    const maxPolls = 10; // generous bound — must finish well before this
    let truncated = true;
    while (truncated && polls < maxPolls) {
      polls += 1;
      const result = await adapter.fetchWindow!(cursor);
      for (const e of result.events) seen.add(e.externalId);
      expect(Date.parse(result.nextSince)).toBeGreaterThanOrEqual(Date.parse(cursor ?? since)); // never goes backwards
      cursor = result.nextSince;
      truncated = result.truncated;
    }

    expect(seen.size).toBe(TOTAL); // the whole backlog was eventually fetched, nothing skipped
    expect(polls).toBeLessThan(maxPolls);
    expect(polls).toBeGreaterThan(1); // genuinely needed more than one poll — one check's page cap can't cover it
  });

  it('a fully-drained window advances the watermark to the check time, not just the floor', async () => {
    const since = '2026-07-27T08:00:00Z';
    const { fetchViaConnector } = makeFetch([gmailBatch(2, since).json]);
    const adapter = createGmailAdapter(fetchViaConnector);
    const before = Date.now();
    const result = await adapter.fetchWindow!(since);
    const after = Date.now();

    expect(result.truncated).toBe(false);
    expect(result.nextSince).not.toBe(since);
    const nextSinceMs = Date.parse(result.nextSince);
    expect(nextSinceMs).toBeGreaterThanOrEqual(before);
    expect(nextSinceMs).toBeLessThanOrEqual(after);
  });

  it('the first-ever fetch (since=null) still respects the 24h floor, even across pages', async () => {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const { fetchViaConnector } = makeFetch([gmailBatch(5, '2026-07-27T12:00:00Z').json], calls);
    const adapter = createGmailAdapter(fetchViaConnector);
    const before = Date.now();
    await adapter.fetchWindow!(null);

    const sinceMatch = String(calls[0]!.prompt).match(/at or after (\S+) \(UTC\)/);
    expect(sinceMatch).toBeTruthy();
    const flooredSinceMs = Date.parse(sinceMatch![1]!);
    // ~24h before "now" at call time, not the whole mailbox.
    expect(before - flooredSinceMs).toBeGreaterThan(23.9 * 60 * 60 * 1000);
    expect(before - flooredSinceMs).toBeLessThan(24.1 * 60 * 60 * 1000);
  });

  it('bails on a page that makes no forward progress instead of looping', async () => {
    // Defensive guard: if the model ignores the ascending/after instruction and
    // keeps returning the same full page, the adapter must not spin forever —
    // it stops paging and reports truncated rather than hanging or double-
    // counting the same messages indefinitely.
    const since = '2026-07-01T00:00:00Z';
    const stuckPage = gmailBatch(30, since).json;
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const { fetchViaConnector } = makeFetch(
      [stuckPage, stuckPage, stuckPage, stuckPage, stuckPage],
      calls,
    );
    const adapter = createGmailAdapter(fetchViaConnector);
    const result = await adapter.fetchWindow!(since);

    expect(result.truncated).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(2); // stops after failing to progress once
  });
});

describe('real gcal adapter', () => {
  it('maps calendar entries with the meta shape handleGcal expects', async () => {
    const batch = JSON.stringify({
      events: [
        {
          externalId: 'evt-1',
          kind: 'event',
          actor: { email: 'ana@acme.example', displayName: 'Ana' },
          direction: 'inbound',
          text: 'Q3 planning\nAgenda: roadmap review',
          occurredAt: '2026-07-28T14:00:00Z',
          meta: {
            startAt: '2026-07-28T14:00:00Z',
            endAt: '2026-07-28T15:00:00Z',
            attendees: ['ana@acme.example', 'me@acme.example'],
            location: 'Meet',
          },
        },
      ],
    });
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const { fetchViaConnector } = makeFetch([batch], calls);
    const events = await createGcalAdapter(fetchViaConnector).fetch(null);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: 'gcal', kind: 'event', externalId: 'evt-1' });
    expect(events[0]!.meta.startAt).toBe('2026-07-28T14:00:00Z');
    expect((calls[0]!.options.allowedTools as string[])).toContain('mcp__claude_ai_Google_Calendar__list_events');
  });
});

describe('normalize', () => {
  const now = '2026-07-27T12:00:00Z';

  it('drops events the shared contract rejects and caps the batch', () => {
    const good = {
      externalId: 'x',
      kind: 'email',
      actor: {},
      direction: 'inbound' as const,
      text: 'hello',
      occurredAt: now,
      meta: {},
    };
    const many = Array.from({ length: MAX_EVENTS_PER_FETCH + 10 }, (_, i) => ({ ...good, externalId: `x${i}` }));
    expect(toSourceEvents('gmail', many, now)).toHaveLength(MAX_EVENTS_PER_FETCH);
  });

  it('coerces an unparseable occurredAt to now instead of dropping the event', () => {
    const wire = {
      externalId: 'x',
      kind: 'email',
      actor: {},
      direction: 'inbound' as const,
      text: 'hello',
      occurredAt: 'yesterday-ish',
      meta: {},
    };
    const events = toSourceEvents('gmail', [wire], now);
    expect(events).toHaveLength(1);
    expect(events[0]!.occurredAt).toBe(now);
  });

  // Report finding #1: a real source can hand back an offset instant
  // (`-03:00`) instead of `Z`; occurredAt must be canonicalized to UTC at the
  // write side so downstream lexicographic SQL compares (start_at/due_date)
  // sort it correctly against its Z twin.
  it('canonicalizes an offset occurredAt to UTC Z', () => {
    const wire = {
      externalId: 'x',
      kind: 'email',
      actor: {},
      direction: 'inbound' as const,
      text: 'hello',
      occurredAt: '2026-08-22T10:00:00-03:00',
      meta: {},
    };
    const events = toSourceEvents('gmail', [wire], now);
    expect(events).toHaveLength(1);
    expect(events[0]!.occurredAt).toBe('2026-08-22T13:00:00.000Z');
  });
});

describe('connectorEnv', () => {
  it('strips Anthropic auth overrides and Claude Code session markers', () => {
    const env = connectorEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      ANTHROPIC_API_KEY: 'sk-x',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      BOTTY_MODE: 'real',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/Users/x', BOTTY_MODE: 'real' });
  });
});

describe('createAdapters (real mode)', () => {
  it('fails gmail/gcal fetches with a clear message under BOTTY_MOCK_LLM', async () => {
    const adapters = createAdapters(
      { mode: 'real', simUrl: 'http://localhost:4821', mockLlm: true },
      { db: new Db(':memory:'), bus: createBus() },
    );
    await expect(adapters.gmail.fetch(null)).rejects.toThrow(/BOTTY_MOCK_LLM/);
  });

  it('keeps slack/jira/github as credential-gated stubs', async () => {
    const adapters = createAdapters(
      { mode: 'real', simUrl: 'http://localhost:4821', mockLlm: false },
      { db: new Db(':memory:'), bus: createBus() },
    );
    await expect(adapters.slack.fetch(null)).rejects.toThrow(/Slack MCP server/);
    await expect(adapters.jira.fetch(null)).rejects.toThrow(/Jira API token/);
  });
});

// Report finding #5 (LOW): `realFamily ??=` used to cache a REJECTED promise
// forever — `??=` only reassigns on null/undefined, and a rejected promise is
// neither, so one transient SDK import failure made every subsequent real
// poll fail until restart.
describe('makeRealFamilyLoader (real-family cache does not pin a rejection)', () => {
  it('retries load() after a rejection instead of replaying it forever', async () => {
    let calls = 0;
    const load = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient SDK import failure');
      return { ok: calls };
    });
    const real = makeRealFamilyLoader(load);

    await expect(real()).rejects.toThrow('transient SDK import failure');
    expect(load).toHaveBeenCalledTimes(1);

    // second call after the rejection must retry, not replay the same rejection
    await expect(real()).resolves.toEqual({ ok: 2 });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('memoizes a successful load — subsequent calls do not re-invoke it', async () => {
    const load = vi.fn(async () => ({ ok: true }));
    const real = makeRealFamilyLoader(load);

    await expect(real()).resolves.toEqual({ ok: true });
    await expect(real()).resolves.toEqual({ ok: true });
    await expect(real()).resolves.toEqual({ ok: true });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers during a pending load share the same in-flight promise', async () => {
    let resolveLoad!: (v: { n: number }) => void;
    const load = vi.fn(() => new Promise<{ n: number }>((resolve) => { resolveLoad = resolve; }));
    const real = makeRealFamilyLoader(load);

    const p1 = real();
    const p2 = real();
    expect(load).toHaveBeenCalledTimes(1);
    resolveLoad({ n: 1 });
    await expect(p1).resolves.toEqual({ n: 1 });
    await expect(p2).resolves.toEqual({ n: 1 });
  });
});
