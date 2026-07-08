import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOURCES, type SourceEvent, type SourceId } from '@botty/shared';
import { parseHeartbeat } from '../../src/config/parse.js';
import { createSimAdapter } from '../../src/ingest/adapters/sim.js';
import type { AdapterMap, SourceAdapter } from '../../src/ingest/adapters/index.js';
import { createScheduler, sinceKey } from '../../src/ingest/scheduler.js';
import { makeEvent, makeHarness, type Harness } from './helpers.js';

function stubAdapter(
  source: SourceId,
  batches: SourceEvent[][],
  sinces: (string | null)[] = [],
): SourceAdapter {
  let call = 0;
  return {
    source,
    async fetch(since) {
      sinces.push(since);
      const batch = batches[Math.min(call, batches.length - 1)] ?? [];
      call += 1;
      return batch;
    },
  };
}

function adapterMap(overrides: Partial<AdapterMap>): AdapterMap {
  return Object.fromEntries(
    SOURCES.map((s) => [s, overrides[s] ?? stubAdapter(s, [[]])]),
  ) as AdapterMap;
}

function schedulerFor(h: Harness, adapters: AdapterMap, heartbeatMd = '') {
  const config = { heartbeat: () => parseHeartbeat(heartbeatMd, 'sim') };
  return createScheduler({ ...h.ctx, config }, adapters);
}

describe('scheduler.checkNow', () => {
  it('runs the funnel, writes source_check_log, emits source.checked, persists since', async () => {
    const h = makeHarness();
    const sinces: (string | null)[] = [];
    const events = [
      makeEvent({ externalId: 'sch-1', text: 'can you check the deploy?' }),
      makeEvent({ externalId: 'sch-2', text: 'jaja buenísimo' }),
    ];
    const scheduler = schedulerFor(h, adapterMap({ slack: stubAdapter('slack', [events, events], sinces) }));

    const checkId = await scheduler.checkNow('slack');
    const checks = h.db.listSourceChecks();
    expect(checks).toHaveLength(1);
    expect(checks[0]!.id).toBe(checkId);
    expect(checks[0]!).toMatchObject({ source: 'slack', eventsFetched: 2, eventsNew: 2, error: null });

    expect(sinces).toEqual([null]); // first check has no since
    expect(h.db.getSetting<string>(sinceKey('slack'))).toBeTruthy();
    expect(h.db.listTasks()).toHaveLength(1); // funnel actually ran

    const ws = h.broadcasts.find((e) => e.type === 'source.checked');
    expect(ws).toBeDefined();
    expect(ws!.type === 'source.checked' && ws!.payload.check.eventsFetched).toBe(2);

    // second check: since = previous successful check; duplicates fetched but not new
    const sinceAfterFirst = h.db.getSetting<string>(sinceKey('slack'))!;
    await scheduler.checkNow('slack');
    expect(sinces[1]).toBe(sinceAfterFirst);
    const second = h.db.listSourceChecks().find((c) => c.id !== checkId)!;
    expect(second).toMatchObject({ eventsFetched: 2, eventsNew: 0 });
  });

  it('fetch failure lands in source_check_log.error and does not advance since', async () => {
    const h = makeHarness();
    const failing: SourceAdapter = {
      source: 'gmail',
      fetch: async () => {
        throw new Error('sim unreachable');
      },
    };
    const scheduler = schedulerFor(h, adapterMap({ gmail: failing }));

    await scheduler.checkNow('gmail');
    const check = h.db.listSourceChecks()[0]!;
    expect(check.error).toContain('sim unreachable');
    expect(check.eventsFetched).toBe(0);
    expect(h.db.getSetting(sinceKey('gmail'))).toBeUndefined();
  });
});

describe('scheduler.start', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('staggers sources ~5s apart, respects enabled flags, and reschedules on the interval', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const slackSinces: (string | null)[] = [];
    const gmailSinces: (string | null)[] = [];
    const adapters = adapterMap({
      slack: stubAdapter('slack', [[]], slackSinces),
      gmail: stubAdapter('gmail', [[]], gmailSinces),
    });
    // gmail disabled; slack polls every 1m (sim default). Degenerate
    // working_hours + all days ⇒ the hard gate is off for this test.
    const scheduler = schedulerFor(
      h,
      adapters,
      '## Schedule\nworking_hours: 00:00-00:00\nactive_days: sun-sat\n\n## Sources\ngmail: off\n',
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(slackSinces).toHaveLength(1); // slack fired at t=0
    await vi.advanceTimersByTimeAsync(5_000);
    expect(gmailSinces).toHaveLength(0); // gmail slot passed but disabled

    await vi.advanceTimersByTimeAsync(60_000);
    expect(slackSinces).toHaveLength(2); // rescheduled on its interval
    expect(gmailSinces).toHaveLength(0);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(slackSinces).toHaveLength(2); // nothing after stop
  });

  it('outside working hours: scheduled polls do nothing (no fetch, no source_check_log); checkNow bypasses', async () => {
    // Freeze time at Wednesday noon; working hours 14:00-16:00 ⇒ off-hours now.
    vi.useFakeTimers({ now: new Date(2026, 6, 1, 12, 0, 0) });
    const h = makeHarness();
    const slackSinces: (string | null)[] = [];
    const adapters = adapterMap({ slack: stubAdapter('slack', [[]], slackSinces) });
    const scheduler = schedulerFor(
      h,
      adapters,
      '## Schedule\nworking_hours: 14:00-16:00\nactive_days: sun-sat\n',
    );

    scheduler.start();
    await vi.advanceTimersByTimeAsync(120_000); // several 1m sim cycles pass
    expect(slackSinces).toHaveLength(0); // no fetch at all
    expect(h.db.listSourceChecks()).toHaveLength(0); // no source_check_log spam

    // manual check bypasses the gate
    await scheduler.checkNow('slack');
    expect(slackSinces).toHaveLength(1);
    expect(h.db.listSourceChecks()).toHaveLength(1);

    // polls resume once the window opens (advance to 14:00+)
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    expect(slackSinces.length).toBeGreaterThan(1);
    scheduler.stop();
  });
});

describe('sim adapter', () => {
  it('GETs /<source>/events?since=…, validates events, drops invalid ones', async () => {
    const requests: string[] = [];
    const good = makeEvent({ externalId: 'sim-good', text: 'hello from sim' });
    const server = http.createServer((req, res) => {
      requests.push(req.url!);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ events: [good, { nonsense: true }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const adapter = createSimAdapter('slack', `http://127.0.0.1:${port}`);
      const events = await adapter.fetch('2026-07-04T00:00:00.000Z');
      expect(requests).toEqual(['/slack/events?since=2026-07-04T00%3A00%3A00.000Z']);
      expect(events).toHaveLength(1);
      expect(events[0]!.externalId).toBe('sim-good');

      const noSince = await adapter.fetch(null);
      expect(noSince).toHaveLength(1);
      expect(requests[1]).toBe('/slack/events');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('connection refused names the sim URL and hints at npm run dev:sim', async () => {
    // Grab a port that is definitely closed: listen, read it, close.
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const adapter = createSimAdapter('slack', `http://127.0.0.1:${port}`);
    await expect(adapter.fetch(null)).rejects.toThrow(
      new RegExp(`sim slack unreachable at http://127\\.0\\.0\\.1:${port}.*is the simulator running\\? \\(npm run dev:sim\\)`),
    );
  });

  it('throws on non-2xx so the check is recorded as an error', async () => {
    const server = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const adapter = createSimAdapter('jira', `http://127.0.0.1:${port}`);
      await expect(adapter.fetch(null)).rejects.toThrow(/HTTP 500/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
