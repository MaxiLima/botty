import { describe, expect, it } from 'vitest';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { makeDecisionRecorder, makeModelResolver } from '../../src/llm/index.js';
import type { QueryFn, SdkMessageLike } from '../../src/llm/sdk.js';
import { createConnectorFetch, connectorEnv } from '../../src/ingest/adapters/real/connector.js';
import { createGmailAdapter } from '../../src/ingest/adapters/real/gmail.js';
import { createGcalAdapter } from '../../src/ingest/adapters/real/gcal.js';
import { createSlackAdapter } from '../../src/ingest/adapters/real/slack.js';
import { createJiraAdapter } from '../../src/ingest/adapters/real/jira.js';
import { createGithubAdapter } from '../../src/ingest/adapters/real/github.js';
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

const SLACK_BATCH = JSON.stringify({
  events: [
    {
      externalId: 'C123:1700000000.000100',
      kind: 'dm',
      actor: { handle: 'diego', displayName: 'Diego' },
      direction: 'inbound',
      text: 'Ping me when the deploy is out.',
      occurredAt: '2026-07-27T09:00:00Z',
      meta: { channel: 'D123', permalink: 'https://slack.example/archives/D123/p1' },
    },
    {
      externalId: 'C123:1700000100.000200',
      kind: 'mention',
      actor: { handle: 'ana', displayName: 'Ana' },
      direction: 'inbound',
      text: '@me can you review the runbook?',
      threadRef: '1700000100.000200',
      occurredAt: '2026-07-27T09:05:00Z',
      meta: { channel: 'eng-oncall', permalink: 'https://slack.example/archives/C123/p2' },
    },
    {
      externalId: 'C999:1700000200.000300',
      kind: 'channel',
      actor: { handle: 'me', displayName: 'Maxo' },
      direction: 'outbound',
      text: 'Done, merged and deploying now.',
      threadRef: '1700000200.000300',
      occurredAt: '2026-07-27T09:10:00Z',
      meta: { channel: 'eng-oncall' },
    },
  ],
});

describe('real slack adapter', () => {
  it('returns validated SourceEvents (dm/mention/channel) with the slack source stamped', async () => {
    const { fetchViaConnector } = makeFetch([SLACK_BATCH]);
    const events = await createSlackAdapter(fetchViaConnector).fetch('2026-07-27T08:00:00Z');
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.kind)).toEqual(['dm', 'mention', 'channel']);
    for (const e of events) expect(e.source).toBe('slack');
    expect(events[0]).toMatchObject({ externalId: 'C123:1700000000.000100', direction: 'inbound' });
    // threadRef survives on the threaded messages; inbound/outbound both round-trip.
    expect(events[1]).toMatchObject({ direction: 'inbound', threadRef: '1700000100.000200' });
    expect(events[2]).toMatchObject({ direction: 'outbound', threadRef: '1700000200.000300' });
  });

  it('isolates the SDK run: no settings, allowlisted read tools, stripped auth env', async () => {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const { fetchViaConnector } = makeFetch([SLACK_BATCH], calls);
    process.env.ANTHROPIC_API_KEY = 'sk-test-should-be-stripped';
    try {
      await createSlackAdapter(fetchViaConnector).fetch(null);
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
    expect(allowed).toContain('mcp__claude_ai_MELI_Slack__create_meli_session');
    expect(allowed).toContain('mcp__claude_ai_MELI_Slack__slack_search_public_and_private');
    const disallowed = options.disallowedTools as string[];
    for (const t of ['Bash', 'Read', 'Write', 'WebFetch', 'Task']) expect(disallowed).toContain(t);
    const env = options.env as Record<string, string>;
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('records a fetch ai_decision on success', async () => {
    const { db, fetchViaConnector } = makeFetch([SLACK_BATCH]);
    await createSlackAdapter(fetchViaConnector).fetch(null);
    const rows = db.listAiDecisions({ kind: 'fetch' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'fetch', relatedRef: 'ingest:slack' });
  });
});

const JIRA_BATCH = JSON.stringify({
  events: [
    {
      externalId: 'GEN-123:2026-07-27T09:00:00Z',
      kind: 'issue',
      actor: { displayName: 'Ana', email: 'ana@acme.example' },
      direction: 'inbound',
      text: 'GEN-123 Fix the batcher retry\n\nStatus: In Progress\nAna added a comment.',
      threadRef: 'GEN-123',
      occurredAt: '2026-07-27T09:00:00Z',
      meta: { key: 'GEN-123', status: 'In Progress', assignee: 'Maxo', url: 'https://jira.example/browse/GEN-123' },
    },
    {
      externalId: 'GEN-456:2026-07-27T09:30:00Z',
      kind: 'issue',
      actor: { displayName: 'Maxo', email: 'me@acme.example' },
      direction: 'outbound',
      text: 'GEN-456 Segmentation RFC\n\nStatus: In Review\nMaxo transitioned the issue.',
      threadRef: 'GEN-456',
      occurredAt: '2026-07-27T09:30:00Z',
      meta: { key: 'GEN-456', status: 'In Review', url: 'https://jira.example/browse/GEN-456' },
    },
  ],
});

describe('real jira adapter', () => {
  it('returns validated issue SourceEvents with the jira source stamped', async () => {
    const { fetchViaConnector } = makeFetch([JIRA_BATCH]);
    const events = await createJiraAdapter(fetchViaConnector).fetch('2026-07-20T00:00:00Z');
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.source).toBe('jira');
      expect(e.kind).toBe('issue');
    }
    expect(events[0]).toMatchObject({
      externalId: 'GEN-123:2026-07-27T09:00:00Z',
      direction: 'inbound',
      threadRef: 'GEN-123',
    });
    expect(events[1]).toMatchObject({ direction: 'outbound', threadRef: 'GEN-456' });
  });

  it('isolates the SDK run: no settings, allowlisted read tools, stripped auth env', async () => {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const { fetchViaConnector } = makeFetch([JIRA_BATCH], calls);
    process.env.ANTHROPIC_API_KEY = 'sk-test-should-be-stripped';
    try {
      await createJiraAdapter(fetchViaConnector).fetch(null);
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
    expect(allowed).toContain('mcp__claude_ai_MELI_Atlassian__create_meli_session');
    expect(allowed).toContain('mcp__claude_ai_MELI_Atlassian__searchJiraIssuesUsingJql');
    const disallowed = options.disallowedTools as string[];
    for (const t of ['Bash', 'Read', 'Write', 'WebFetch', 'Task']) expect(disallowed).toContain(t);
    const env = options.env as Record<string, string>;
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('records a fetch ai_decision on success', async () => {
    const { db, fetchViaConnector } = makeFetch([JIRA_BATCH]);
    await createJiraAdapter(fetchViaConnector).fetch(null);
    const rows = db.listAiDecisions({ kind: 'fetch' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'fetch', relatedRef: 'ingest:jira' });
  });
});

const GITHUB_BATCH = JSON.stringify({
  events: [
    {
      externalId: 'acme/api#42:2026-07-27T09:00:00Z',
      kind: 'pr',
      actor: { handle: 'diego', displayName: 'Diego' },
      direction: 'inbound',
      text: 'acme/api#42 Add retry backoff\n\nState: open\nDiego requested your review.',
      threadRef: 'acme/api#42',
      occurredAt: '2026-07-27T09:00:00Z',
      meta: { repo: 'acme/api', number: 42, state: 'open', url: 'https://github.example/acme/api/pull/42', reviewRequested: true },
    },
    {
      externalId: 'acme/api#7:2026-07-27T09:30:00Z',
      kind: 'issue',
      actor: { handle: 'me', displayName: 'Maxo' },
      direction: 'outbound',
      text: 'acme/api#7 Flaky ingest test\n\nState: closed\nMaxo closed the issue.',
      threadRef: 'acme/api#7',
      occurredAt: '2026-07-27T09:30:00Z',
      meta: { repo: 'acme/api', number: 7, state: 'closed', url: 'https://github.example/acme/api/issues/7' },
    },
  ],
});

describe('real github adapter', () => {
  it('returns validated SourceEvents (pr/issue) with the github source stamped', async () => {
    const { fetchViaConnector } = makeFetch([GITHUB_BATCH]);
    const events = await createGithubAdapter(fetchViaConnector).fetch('2026-07-20T00:00:00Z');
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.kind)).toEqual(['pr', 'issue']);
    for (const e of events) expect(e.source).toBe('github');
    expect(events[0]).toMatchObject({
      externalId: 'acme/api#42:2026-07-27T09:00:00Z',
      direction: 'inbound',
      threadRef: 'acme/api#42',
    });
    expect(events[1]).toMatchObject({ direction: 'outbound', threadRef: 'acme/api#7' });
  });

  it('isolates the SDK run: no settings, allowlisted read tools, stripped auth env', async () => {
    const calls: { prompt: unknown; options: Record<string, unknown> }[] = [];
    const { fetchViaConnector } = makeFetch([GITHUB_BATCH], calls);
    process.env.ANTHROPIC_API_KEY = 'sk-test-should-be-stripped';
    try {
      await createGithubAdapter(fetchViaConnector).fetch(null);
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
    expect(allowed).toContain('mcp__claude_ai_MELI_Github__create_meli_session');
    expect(allowed).toContain('mcp__claude_ai_MELI_Github__search_issues');
    const disallowed = options.disallowedTools as string[];
    for (const t of ['Bash', 'Read', 'Write', 'WebFetch', 'Task']) expect(disallowed).toContain(t);
    const env = options.env as Record<string, string>;
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });

  it('records a fetch ai_decision on success', async () => {
    const { db, fetchViaConnector } = makeFetch([GITHUB_BATCH]);
    await createGithubAdapter(fetchViaConnector).fetch(null);
    const rows = db.listAiDecisions({ kind: 'fetch' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'fetch', relatedRef: 'ingest:github' });
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

  it('drives slack/jira/github through connectors too, failing under BOTTY_MOCK_LLM', async () => {
    // slack/jira/github are connector-backed drivers now (not credential stubs),
    // so like gmail/gcal they cannot run under the mock LLM.
    const adapters = createAdapters(
      { mode: 'real', simUrl: 'http://localhost:4821', mockLlm: true },
      { db: new Db(':memory:'), bus: createBus() },
    );
    for (const source of ['slack', 'jira', 'github'] as const) {
      await expect(adapters[source].fetch(null)).rejects.toThrow(/BOTTY_MOCK_LLM/);
    }
  });
});
