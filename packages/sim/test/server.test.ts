import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SourceEventSchema } from '@botty/shared';
import { SimEngine } from '../src/engine.js';
import { createApp } from '../src/server.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp(new SimEngine());
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

async function post(path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
async function get(path: string): Promise<any> {
  const res = await fetch(base + path);
  return res.json();
}

describe('control API + source endpoints', () => {
  it('serves the control panel at /', async () => {
    const res = await fetch(base + '/');
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('botty sim');
  });

  it('state starts empty and lists available scenarios', async () => {
    const st = await get('/control/state');
    expect(st.scenario).toBeNull();
    expect(st.available).toContain('workweek');
    expect(st.released).toEqual([]);
  });

  it('loads workweek, advances, and serves valid events per source', async () => {
    expect((await post('/control/scenario/load', { name: 'workweek' })).status).toBe(200);
    expect((await post('/control/advance', { minutes: 30 })).data.clock.minutes).toBe(30);

    const slack = (await get('/slack/events')).events;
    expect(slack.length).toBeGreaterThan(0);
    for (const e of slack) {
      expect(() => SourceEventSchema.parse(e)).not.toThrow();
      expect(e.source).toBe('slack');
    }
    expect((await get('/gcal/events')).events).toHaveLength(1);
    expect((await get('/jira/events')).events.length).toBeGreaterThan(0);
  });

  it('since= filters by wall-clock release time', async () => {
    const all = (await get('/slack/events')).events;
    expect(all.length).toBeGreaterThan(0);
    // A watermark taken after the release sees nothing, even though the
    // fast-forwarded occurredAt values are far in the future.
    const watermark = new Date().toISOString();
    expect((await get(`/slack/events?since=${encodeURIComponent(watermark)}`)).events).toHaveLength(
      0,
    );
    // A new inject lands after the watermark and is delivered by it.
    await new Promise((r) => setTimeout(r, 10));
    const { data } = await post('/control/inject', { source: 'slack', kind: 'dm', text: 'ping' });
    const after = (await get(`/slack/events?since=${encodeURIComponent(watermark)}`)).events;
    expect(after.map((e: any) => e.externalId)).toEqual([data.event.externalId]);
  });

  it('inject releases immediately and validates', async () => {
    const { status, data } = await post('/control/inject', {
      source: 'github',
      kind: 'pr',
      actor: { handle: 'diegopaz' },
      text: 'Review requested: acme-example/fraud-rules#501',
      meta: { repo: 'acme-example/fraud-rules', number: 501, state: 'open' },
    });
    expect(status).toBe(200);
    const events = (await get('/github/events')).events;
    expect(events.some((e: any) => e.externalId === data.event.externalId)).toBe(true);
  });

  it('rejects bad inject and bad advance with 400', async () => {
    expect((await post('/control/inject', { source: 'nope', kind: 'x', text: 'y' })).status).toBe(400);
    expect((await post('/control/advance', { minutes: 'x' })).status).toBe(400);
    expect((await post('/control/scenario/load', { name: '../etc/passwd' })).status).toBe(400);
    expect((await post('/control/scenario/load', { name: 'missing' })).status).toBe(400);
  });

  it('serves templates and play/pause toggle the clock', async () => {
    const { templates } = await get('/control/templates');
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0]).toHaveProperty('label');

    const play = await post('/control/scenario/play', { speed: 120 });
    expect(play.data.clock.playing).toBe(true);
    expect(play.data.clock.speed).toBe(120);
    const pause = await post('/control/scenario/pause', {});
    expect(pause.data.clock.playing).toBe(false);
  });

  it('reset clears everything', async () => {
    await post('/control/reset', {});
    const st = await get('/control/state');
    expect(st.scenario).toBeNull();
    expect((await get('/slack/events')).events).toHaveLength(0);
  });
});
