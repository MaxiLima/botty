import { describe, expect, it } from 'vitest';
import { SourceEventSchema } from '@botty/shared';
import { SimEngine } from '../src/engine.js';
import { loadScenarioFile } from '../src/scenarios.js';

const T0 = Date.parse('2026-07-06T09:00:00.000Z');
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function loadedEngine(): SimEngine {
  const engine = new SimEngine({ now: () => T0 });
  const { scenario, templates } = loadScenarioFile('workweek');
  engine.loadScenario(scenario, templates);
  return engine;
}

describe('scenario loading', () => {
  it('loads workweek, releases minute-0 events immediately, rest pending', () => {
    const engine = loadedEngine();
    const st = engine.state();
    expect(st.scenario?.name).toBe('workweek');
    expect(st.scenario?.eventCount).toBe(40);
    expect(st.released).toHaveLength(1);
    expect(st.pending).toHaveLength(39);
    expect(st.people).toHaveLength(6);
    expect(st.clock.startedAt).toBe(iso(0));
  });

  it('all released events validate against SourceEventSchema', () => {
    const engine = loadedEngine();
    engine.advance(600); // release everything
    const st = engine.state();
    expect(st.pending).toHaveLength(0);
    expect(st.released).toHaveLength(40);
    for (const e of st.released) expect(() => SourceEventSchema.parse(e)).not.toThrow();
  });
});

describe('advance + release', () => {
  it('advance releases only events with atMinute <= clock, with correct occurredAt', () => {
    const engine = loadedEngine();
    engine.advance(30);
    const st = engine.state();
    // scenario has 12 events at minutes 0..30
    expect(st.released).toHaveLength(12);
    expect(st.clock.minutes).toBe(30);
    for (const p of st.pending) expect(p.atMinute).toBeGreaterThan(30);

    const marian = st.released.find((e) => e.threadRef === 'T-1001')!;
    expect(marian.occurredAt).toBe(iso(0));
    const email = st.released.find((e) => e.source === 'gmail' && e.text.includes('Q2 chargeback'))!;
    expect(email.occurredAt).toBe(iso(12));
  });

  it('converts gcal meta.startAtMinute/durationMin to absolute startAt/endAt', () => {
    const engine = loadedEngine();
    engine.advance(5);
    const gcal = engine.eventsFor('gcal');
    expect(gcal).toHaveLength(1);
    const meta = gcal[0]!.meta;
    expect(meta.startAt).toBe(iso(70));
    expect(meta.endAt).toBe(iso(130));
    expect(meta).not.toHaveProperty('startAtMinute');
    expect(meta).not.toHaveProperty('durationMin');
    expect(meta.attendees).toContain('marian@acme.example');
  });

  it('preserves scripted externalId so a duplicate delivery repeats it', () => {
    const engine = loadedEngine();
    engine.advance(27);
    const dupes = engine.eventsFor('slack').filter((e) => e.externalId === 'slack-marian-pr482');
    expect(dupes).toHaveLength(2);
    expect(dupes[0]!.meta).not.toHaveProperty('externalId');
  });
});

describe('since filtering (wall-clock release time)', () => {
  /** Engine whose wall clock we can move independently of the sim clock. */
  function wallEngine(): { engine: SimEngine; setWall: (ms: number) => void } {
    let wall = T0;
    const engine = new SimEngine({ now: () => wall });
    const { scenario, templates } = loadScenarioFile('workweek');
    engine.loadScenario(scenario, templates);
    return { engine, setWall: (ms) => (wall = ms) };
  }

  it('returns only events released strictly after since, regardless of occurredAt', () => {
    const { engine, setWall } = wallEngine();
    engine.advance(9); // released at wall T0
    setWall(T0 + 60_000);
    engine.advance(21); // minutes 10..30 released at wall T0+1min
    const all = engine.eventsFor('slack');
    const after = engine.eventsFor('slack', iso(0));
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(all.length);
    // event released exactly at since is excluded (dedup-safe boundary)
    expect(engine.eventsFor('slack', iso(1))).toHaveLength(0);
  });

  it('delivers a paused-clock inject even when occurredAt is behind the watermark', () => {
    const { engine, setWall } = wallEngine();
    // Agent checked at wall T0+10min; inject a second later, sim clock still paused at minute 0.
    setWall(T0 + 10 * 60_000 + 1_000);
    const ev = engine.inject({ source: 'slack', kind: 'dm', text: 'late ping' });
    expect(ev.occurredAt).toBe(iso(0)); // timeline time is behind the watermark…
    const got = engine.eventsFor('slack', iso(10)); // …but the event still arrives
    expect(got.some((e) => e.externalId === ev.externalId)).toBe(true);
  });

  it('does not refetch fast-played events whose occurredAt is ahead of wall time', () => {
    const { engine, setWall } = wallEngine();
    engine.advance(600); // occurredAt up to T0+600min, all released at wall T0
    expect(engine.eventsFor('slack', null).length).toBeGreaterThan(0);
    // Next agent check a wall-minute later must see nothing new.
    setWall(T0 + 60_000);
    expect(engine.eventsFor('slack', iso(1))).toHaveLength(0);
  });

  it('ignores an unparseable since', () => {
    const engine = loadedEngine();
    engine.advance(10);
    expect(engine.eventsFor('slack', 'not-a-date').length).toBe(engine.eventsFor('slack').length);
  });
});

describe('inject', () => {
  it('releases immediately with occurredAt defaulted to the sim clock', () => {
    const engine = loadedEngine();
    engine.advance(30);
    const ev = engine.inject({
      source: 'slack',
      kind: 'dm',
      actor: { handle: '@marian' },
      text: 'injected ping',
    });
    expect(ev.occurredAt).toBe(iso(30));
    expect(ev.externalId).toMatch(/^inject-/);
    expect(engine.eventsFor('slack').some((e) => e.externalId === ev.externalId)).toBe(true);
  });

  it('absolutizes gcal startAtMinute relative to the current clock', () => {
    const engine = loadedEngine();
    engine.advance(60);
    const ev = engine.inject({
      source: 'gcal',
      kind: 'event',
      text: 'Incident review',
      meta: { startAtMinute: 30, durationMin: 15 },
    });
    expect(ev.meta.startAt).toBe(iso(90));
    expect(ev.meta.endAt).toBe(iso(105));
  });

  it('works with no scenario loaded (occurredAt = wall now)', () => {
    const engine = new SimEngine({ now: () => T0 });
    const ev = engine.inject({ source: 'gmail', kind: 'email', text: 'hola' });
    expect(ev.occurredAt).toBe(iso(0));
    expect(engine.eventsFor('gmail')).toHaveLength(1);
  });
});

describe('reset', () => {
  it('clears scenario, clock and events', () => {
    const engine = loadedEngine();
    engine.advance(100);
    engine.reset();
    const st = engine.state();
    expect(st.scenario).toBeNull();
    expect(st.released).toHaveLength(0);
    expect(st.pending).toHaveLength(0);
    expect(st.clock.minutes).toBe(0);
    expect(st.clock.startedAt).toBeNull();
  });
});
