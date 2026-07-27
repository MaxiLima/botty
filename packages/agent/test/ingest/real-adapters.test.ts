import { describe, expect, it } from 'vitest';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { makeDecisionRecorder, makeModelResolver } from '../../src/llm/index.js';
import type { QueryFn, SdkMessageLike } from '../../src/llm/sdk.js';
import { createConnectorFetch, connectorEnv } from '../../src/ingest/adapters/real/connector.js';
import { createGmailAdapter } from '../../src/ingest/adapters/real/gmail.js';
import { createGcalAdapter } from '../../src/ingest/adapters/real/gcal.js';
import { toSourceEvents, MAX_EVENTS_PER_FETCH } from '../../src/ingest/adapters/real/normalize.js';
import { createAdapters } from '../../src/ingest/adapters/index.js';

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
