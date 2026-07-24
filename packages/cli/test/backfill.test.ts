import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackfillState } from '@botty/shared';
import { parseConfig } from '../src/config.js';
import { backfill } from '../src/commands/backfill.js';

function doneState(over: Partial<BackfillState> = {}): BackfillState {
  return {
    status: 'done',
    startedAt: '2026-07-24T10:00:00.000Z',
    finishedAt: '2026-07-24T10:01:00.000Z',
    window: { days: 30, oldest: '2026-06-24T10:00:00.000Z' },
    sources: {
      slack: { cursor: null, fetched: 10, newEvents: 8, duplicates: 2, done: true, error: null },
    },
    distill: {
      threadsSeen: 3,
      threadsDistilled: 2,
      callsUsed: 2,
      callCap: 50,
      decisionsCreated: 4,
      notesAdded: 1,
      errors: 0,
      done: true,
    },
    ...over,
  };
}

/** Stub global fetch with per-(method,path) JSON responses. */
function stubFetch(routes: Record<string, unknown>): string[] {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const { pathname } = new URL(String(url));
    const key = `${method} ${pathname}`;
    calls.push(`${key}${init?.body ? ` ${init.body}` : ''}`);
    if (!(key in routes)) return new Response('{"error":"not_found"}', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = 0;
});

describe('config: backfill flags', () => {
  it('parses command, subcommand and flags', () => {
    const c = parseConfig(['backfill', 'status', '--source', 'slack,gmail', '--days', '90', '--max-llm-calls', '0', '--no-wait'], {});
    expect(c.command).toBe('backfill');
    expect(c.args).toEqual(['status']);
    expect(c.backfillSources).toEqual(['slack', 'gmail']);
    expect(c.days).toBe(90);
    expect(c.maxLlmCalls).toBe(0);
    expect(c.noWait).toBe(true);
  });

  it('leaves backfill fields undefined when flags are absent', () => {
    const c = parseConfig(['backfill'], {});
    expect(c.backfillSources).toBeUndefined();
    expect(c.days).toBeUndefined();
    expect(c.maxLlmCalls).toBeUndefined();
    expect(c.noWait).toBe(false);
  });

  it('rejects non-numeric --days / --max-llm-calls', () => {
    expect(() => parseConfig(['backfill', '--days', 'soon'], {})).toThrow(/--days/);
    expect(() => parseConfig(['backfill', '--max-llm-calls', '-1'], {})).toThrow(/--max-llm-calls/);
  });
});

describe('backfill command', () => {
  it('fails fast when no agent is healthy', async () => {
    stubFetch({});
    const cfg = parseConfig(['backfill', '--port', '5999'], {});
    await expect(backfill(cfg)).rejects.toThrow(/no agent on :5999.*botty start/);
  });

  it('start posts flags through and polls to done', async () => {
    const calls = stubFetch({
      'GET /api/health': { ok: true },
      'POST /api/backfill/start': { started: true, state: { ...doneState(), status: 'running' } },
      'GET /api/backfill': { state: doneState() },
    });
    const cfg = parseConfig(['backfill', '--source', 'slack', '--days', '90', '--max-llm-calls', '10'], {});
    await backfill(cfg);
    const startCall = calls.find((c) => c.startsWith('POST /api/backfill/start'))!;
    expect(JSON.parse(startCall.slice('POST /api/backfill/start '.length))).toEqual({
      sources: ['slack'],
      days: 90,
      maxLlmCalls: 10,
      resume: false,
    });
    expect(calls.some((c) => c.startsWith('GET /api/backfill '))).toBe(false);
    expect(calls.filter((c) => c === 'GET /api/backfill').length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(0);
  }, 10_000);

  it('--no-wait returns without polling; resume subcommand sets resume:true', async () => {
    const calls = stubFetch({
      'GET /api/health': { ok: true },
      'POST /api/backfill/start': { started: true, state: { ...doneState(), status: 'running' } },
    });
    await backfill(parseConfig(['backfill', 'resume', '--no-wait'], {}));
    const startCall = calls.find((c) => c.startsWith('POST /api/backfill/start'))!;
    expect(startCall).toContain('"resume":true');
    expect(calls.filter((c) => c === 'GET /api/backfill')).toHaveLength(0);
  });

  it('alreadyRunning sets a non-zero exit code and suggests status/cancel', async () => {
    stubFetch({
      'GET /api/health': { ok: true },
      'POST /api/backfill/start': { started: false, alreadyRunning: true, state: { ...doneState(), status: 'running' } },
    });
    await backfill(parseConfig(['backfill'], {}));
    expect(process.exitCode).toBe(1);
  });

  it('rejects a non-backfillable --source before calling the agent', async () => {
    stubFetch({ 'GET /api/health': { ok: true } });
    await expect(backfill(parseConfig(['backfill', '--source', 'jira'], {}))).rejects.toThrow(/not backfillable/);
  });

  it('status prints the last run and errors exit non-zero', async () => {
    stubFetch({ 'GET /api/health': { ok: true }, 'GET /api/backfill': { state: doneState({ status: 'error' }) } });
    await backfill(parseConfig(['backfill', 'status'], {}));
    expect(process.exitCode).toBe(1);
  });

  it('cancel posts to the cancel route', async () => {
    const calls = stubFetch({
      'GET /api/health': { ok: true },
      'POST /api/backfill/cancel': { state: doneState({ status: 'cancelled' }) },
    });
    await backfill(parseConfig(['backfill', 'cancel'], {}));
    expect(calls).toContain('POST /api/backfill/cancel {}');
  });

  it('rejects unknown subcommands', async () => {
    stubFetch({ 'GET /api/health': { ok: true } });
    await expect(backfill(parseConfig(['backfill', 'bogus'], {}))).rejects.toThrow(/unknown subcommand/);
  });
});
