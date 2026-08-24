import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeartbeatConfig } from '../../src/config/parse.js';
import type { SweepResult } from '../../src/loop/resolution-sweep.js';

/**
 * Regression coverage for the duplicate-timer-chain bug: a heartbeat.md
 * hot-reload (config.changed) that lands while a tick/sweep is mid-execution
 * used to leave TWO self-rescheduling timer chains alive (cadence silently
 * doubles, then quadruples...), and a stray fired timer could still run a
 * full execTick/execSweep after stop(). See packages/agent/src/loop/index.ts.
 *
 * runTick / runResolutionSweep / runBriefing are mocked so this exercises
 * only the scheduler (arm/re-arm/stop bookkeeping) with deterministic,
 * externally-controlled completion timing — no real LLM/db/candidate
 * machinery involved.
 */

const runTickMock = vi.fn<(deps: unknown, opts: { trigger: string }) => Promise<string>>();
const runResolutionSweepMock =
  vi.fn<(deps: unknown, opts: { trigger: string }) => Promise<SweepResult>>();
const runBriefingMock = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('../../src/loop/tick.js', () => ({
  runTick: (...args: [unknown, { trigger: string }]) => runTickMock(...args),
}));
vi.mock('../../src/loop/resolution-sweep.js', () => ({
  createSweepState: () => new Map(),
  runResolutionSweep: (...args: [unknown, { trigger: string }]) => runResolutionSweepMock(...args),
}));
vi.mock('../../src/loop/briefings.js', () => ({
  runBriefing: (...args: unknown[]) => runBriefingMock(...args),
}));

// Imported *after* the mocks above so createLoop picks up the mocked modules.
const { createLoop } = await import('../../src/loop/index.js');
const { createBus } = await import('../../src/bus/index.js');
const { Db } = await import('../../src/db/index.js');

/** A never-gated heartbeat: workingHours start===end disables the hard gate (see time.ts). */
function heartbeat(over: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    tickIntervalMin: 20,
    resolutionSweepIntervalMin: 15,
    workingHours: { start: '00:00', end: '00:00' },
    quietHours: { start: '00:00', end: '00:00' },
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    morningBriefAt: '08:45',
    eveningBriefAt: '18:00',
    surfacingThreshold: 7,
    maxSurfacesPerTask: 3,
    maxProactivePerHour: 2,
    minGapBetweenNudgesMin: 30,
    sources: {} as HeartbeatConfig['sources'],
    autoResolveTasks: true,
    instructions: '',
    thisWeek: '',
    warnings: [],
    ...over,
  } as HeartbeatConfig;
}

/** Minimal fake AgentContext: createLoop only reads db/bus/config/llm/memory off it. */
function makeCtx(hb: HeartbeatConfig) {
  const db = new Db(':memory:');
  const bus = createBus();
  const config = { heartbeat: () => hb, persona: () => '' };
  const llm = { chatTurn: vi.fn(), structured: vi.fn(), interrupt: vi.fn() };
  const memory = { search: vi.fn(), buildChatSystemPrompt: vi.fn(), buildProactiveContext: vi.fn() };
  const env = {};
  const chat = {};
  // createLoop destructures { db, bus, config, llm, memory } — env/chat are never touched.
  const ctx = { env, db, bus, config, llm, memory, chat } as unknown as import('../../src/context.js').AgentContext;
  return { ctx, bus };
}

/** A promise the test controls the resolution of, standing in for an in-flight LLM call. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function broadcastHeartbeatChanged(bus: ReturnType<typeof createBus>): void {
  bus.broadcast({ type: 'config.changed', payload: { name: 'heartbeat' } });
}

describe('loop scheduler — duplicate timer chains on config hot-reload', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin "now" well before either default brief time (08:45/18:00) so the
    // briefing wall-clock poller (checkBriefings, loop/index.ts) — which
    // fires once synchronously on start() as boot catch-up — never fires
    // spuriously depending on whatever the real wall-clock happens to be
    // when this suite runs. 2026-07-01 is a Wednesday (an active day).
    vi.setSystemTime(new Date('2026-07-01T07:00:00'));
    runTickMock.mockReset();
    runResolutionSweepMock.mockReset();
    runBriefingMock.mockReset();
    runResolutionSweepMock.mockResolvedValue({ checked: 0, closed: [], skipped: [] });
    runBriefingMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a config.changed mid-tick leaves exactly one live tick chain, not two', async () => {
    const hb = heartbeat({ tickIntervalMin: 20 });
    const { ctx, bus } = makeCtx(hb);
    const intervalMs = 20 * 60_000;

    // First call hangs (simulating the multi-second LLM call); later calls resolve immediately.
    const first = deferred<string>();
    let calls = 0;
    runTickMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return first.promise;
      return `tick-${calls}`;
    });

    const loop = createLoop(ctx);
    loop.start();

    // Fire the first scheduled tick — it's now "in flight" awaiting `first.promise`.
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(runTickMock).toHaveBeenCalledTimes(1);

    // heartbeat.md is saved *while the tick is executing*: this is the buggy trigger.
    broadcastHeartbeatChanged(bus);

    // The in-flight tick now finishes. Give the callback's continuation a chance to run.
    first.resolve('tick-1');
    await vi.advanceTimersByTimeAsync(0);

    // The config-change must NOT itself have triggered another tick, and the
    // original (now-superseded) chain must not re-arm after its await resolves.
    expect(runTickMock).toHaveBeenCalledTimes(1);

    // Advance one full interval from the reloaded chain: with the bug, both the
    // superseded chain (re-armed on resolve) and the new chain fire, so this
    // would jump straight from 1 -> 3 calls. Fixed, it's exactly one more.
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(runTickMock).toHaveBeenCalledTimes(2);

    // Cadence stays single-chain on subsequent intervals too.
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(runTickMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(runTickMock).toHaveBeenCalledTimes(4);

    loop.stop();
  });

  it('a config.changed mid-sweep leaves exactly one live sweep chain, not two', async () => {
    const hb = heartbeat({ resolutionSweepIntervalMin: 15 });
    const { ctx, bus } = makeCtx(hb);
    const intervalMs = 15 * 60_000;

    const first = deferred<SweepResult>();
    let calls = 0;
    runResolutionSweepMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return first.promise;
      return { checked: 0, closed: [], skipped: [] };
    });

    const loop = createLoop(ctx);
    loop.start();

    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(runResolutionSweepMock).toHaveBeenCalledTimes(1);

    broadcastHeartbeatChanged(bus);

    first.resolve({ checked: 3, closed: [], skipped: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(runResolutionSweepMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(runResolutionSweepMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(runResolutionSweepMock).toHaveBeenCalledTimes(3);

    loop.stop();
  });

  it('stop() halts a tick chain even if it was mid-execution when config reloaded', async () => {
    const hb = heartbeat({ tickIntervalMin: 20 });
    const { ctx, bus } = makeCtx(hb);
    const intervalMs = 20 * 60_000;

    const first = deferred<string>();
    let calls = 0;
    runTickMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return first.promise;
      return `tick-${calls}`;
    });

    const loop = createLoop(ctx);
    loop.start();

    await vi.advanceTimersByTimeAsync(intervalMs);
    broadcastHeartbeatChanged(bus); // arms a second, superseding chain while call #1 is in flight

    loop.stop(); // must kill every chain, including the one whose timer already fired

    first.resolve('tick-1'); // let the stale in-flight callback continue
    await vi.advanceTimersByTimeAsync(0);
    expect(runTickMock).toHaveBeenCalledTimes(1); // no re-arm after stop()

    // No further ticks even after many intervals worth of fake time.
    await vi.advanceTimersByTimeAsync(intervalMs * 10);
    expect(runTickMock).toHaveBeenCalledTimes(1);
  });

  it('stop() halts a sweep chain even if it was mid-execution when config reloaded', async () => {
    const hb = heartbeat({ resolutionSweepIntervalMin: 15 });
    const { ctx, bus } = makeCtx(hb);
    const intervalMs = 15 * 60_000;

    const first = deferred<SweepResult>();
    let calls = 0;
    runResolutionSweepMock.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return first.promise;
      return { checked: 0, closed: [], skipped: [] };
    });

    const loop = createLoop(ctx);
    loop.start();

    await vi.advanceTimersByTimeAsync(intervalMs);
    broadcastHeartbeatChanged(bus);

    loop.stop();

    first.resolve({ checked: 0, closed: [], skipped: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(runResolutionSweepMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(intervalMs * 10);
    expect(runResolutionSweepMock).toHaveBeenCalledTimes(1);
  });

  it('a plain stop() (no in-flight tick) leaves no timers firing afterwards', async () => {
    const hb = heartbeat({ tickIntervalMin: 20, resolutionSweepIntervalMin: 15 });
    const { ctx } = makeCtx(hb);
    runTickMock.mockResolvedValue('tick-1');

    const loop = createLoop(ctx);
    loop.start();
    loop.stop();

    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(runTickMock).not.toHaveBeenCalled();
    expect(runResolutionSweepMock).not.toHaveBeenCalled();
    expect(runBriefingMock).not.toHaveBeenCalled();
  });

  it('briefings still re-arm cleanly on config.changed (no accumulation)', async () => {
    const hb = heartbeat();
    const { ctx, bus } = makeCtx(hb);
    runTickMock.mockResolvedValue('tick-1');

    const loop = createLoop(ctx);
    loop.start();

    // Several rapid heartbeat.md saves, as if the user is iterating on the file.
    broadcastHeartbeatChanged(bus);
    broadcastHeartbeatChanged(bus);
    broadcastHeartbeatChanged(bus);

    // msUntilNextTime for morning/evening briefs is at most 24h out; nothing
    // should fire yet, and re-arming repeatedly must not throw or leak.
    await vi.advanceTimersByTimeAsync(0);
    expect(runBriefingMock).not.toHaveBeenCalled();

    loop.stop();
  });
});

/**
 * Finding #3 (2026-08-21 full-test-run report): a heartbeat.md hot-reload
 * used to unconditionally clearTimeout + reschedule the tick/sweep timers
 * from "now", so an editor autosaving every few seconds could reset the
 * deadline forever and the scheduled tick would never actually fire. The fix
 * only re-arms when the fields that affect the arm time (interval,
 * working_hours, active_days) actually changed — an unrelated field edit (or
 * a byte-identical autosave) must leave the existing deadline untouched.
 */
describe('loop scheduler — heartbeat.md hot-reload preserves deadlines when timing is unchanged', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T07:00:00'));
    runTickMock.mockReset();
    runResolutionSweepMock.mockReset();
    runBriefingMock.mockReset();
    runResolutionSweepMock.mockResolvedValue({ checked: 0, closed: [], skipped: [] });
    runBriefingMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a config.changed with no timing change does not reset the tick deadline', async () => {
    const hb = heartbeat({ tickIntervalMin: 20 });
    const { ctx, bus } = makeCtx(hb);
    runTickMock.mockResolvedValue('tick-1');
    const loop = createLoop(ctx);
    loop.start();

    // 3/4 of the way through the interval...
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(runTickMock).not.toHaveBeenCalled();

    // ...an editor autosaves heartbeat.md repeatedly with nothing timing-relevant changed.
    broadcastHeartbeatChanged(bus);
    broadcastHeartbeatChanged(bus);
    broadcastHeartbeatChanged(bus);
    await vi.advanceTimersByTimeAsync(0);
    expect(runTickMock).not.toHaveBeenCalled();

    // The original deadline (20 min from start) must still hold: if a reload
    // had reset it from t=15min, this remaining 5 min would NOT be enough.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runTickMock).toHaveBeenCalledTimes(1);

    loop.stop();
  });

  it('a config.changed that DOES change tick_interval_min re-arms with the new cadence', async () => {
    const hb = heartbeat({ tickIntervalMin: 20 });
    const { ctx, bus } = makeCtx(hb);
    runTickMock.mockResolvedValue('tick-1');
    const loop = createLoop(ctx);
    loop.start();

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(runTickMock).not.toHaveBeenCalled();

    hb.tickIntervalMin = 5; // the object createLoop reads via config.heartbeat() is mutated in place
    broadcastHeartbeatChanged(bus);
    await vi.advanceTimersByTimeAsync(0);
    expect(runTickMock).not.toHaveBeenCalled(); // re-arm itself doesn't fire anything synchronously

    // Re-armed from now (t=15min) with the NEW 5-minute interval.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runTickMock).toHaveBeenCalledTimes(1);

    loop.stop();
  });

  it('same preserve/re-arm behavior applies to the resolution sweep timer', async () => {
    const hb = heartbeat({ resolutionSweepIntervalMin: 15 });
    const { ctx, bus } = makeCtx(hb);
    const loop = createLoop(ctx);
    loop.start();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runResolutionSweepMock).not.toHaveBeenCalled();

    // No timing-relevant change: deadline must be preserved.
    broadcastHeartbeatChanged(bus);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runResolutionSweepMock).toHaveBeenCalledTimes(1);

    loop.stop();
  });
});

/**
 * Finding #4: replace one long-lived setTimeout per briefing kind (up to
 * ~14h — fragile across laptop sleep and TZ changes) with a cheap wall-clock
 * poll. Also covers the "no missed-briefing catch-up" LOW gap: a target
 * already passed before boot must fire immediately, not wait until tomorrow.
 */
describe('loop scheduler — briefing wall-clock poll (fire/skip/catch-up)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-07-01 07:00 local — a Wednesday, before every *_brief_at used below.
    vi.setSystemTime(new Date('2026-07-01T07:00:00'));
    runTickMock.mockReset();
    runResolutionSweepMock.mockReset();
    runBriefingMock.mockReset();
    runTickMock.mockResolvedValue('tick-1');
    runResolutionSweepMock.mockResolvedValue({ checked: 0, closed: [], skipped: [] });
    runBriefingMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire before the wall clock reaches *_brief_at', async () => {
    const hb = heartbeat({ morningBriefAt: '08:45' });
    const { ctx } = makeCtx(hb);
    const loop = createLoop(ctx);
    loop.start();

    await vi.advanceTimersByTimeAsync(60 * 60_000); // 07:00 -> 08:00, still before 08:45
    expect(runBriefingMock).not.toHaveBeenCalled();

    loop.stop();
  });

  it('fires within one poll cycle of *_brief_at being reached', async () => {
    const hb = heartbeat({ morningBriefAt: '08:45' });
    const { ctx } = makeCtx(hb);
    const loop = createLoop(ctx);
    loop.start();

    await vi.advanceTimersByTimeAsync(105 * 60_000); // 07:00 -> 08:45
    await vi.advanceTimersByTimeAsync(60_000); // one more poll cycle to be sure
    expect(runBriefingMock).toHaveBeenCalledTimes(1);
    expect(runBriefingMock).toHaveBeenCalledWith(expect.anything(), 'morning_brief');

    loop.stop();
  });

  it('does not re-fire the same kind again later the same day', async () => {
    // Tick/sweep given a huge (but still clamped, see the next describe
    // block) interval purely to keep this test fast under fake timers — this
    // test is about the briefing poller only, not tick/sweep cadence.
    const hb = heartbeat({ morningBriefAt: '08:45', tickIntervalMin: 100_000, resolutionSweepIntervalMin: 100_000 });
    const { ctx } = makeCtx(hb);
    const loop = createLoop(ctx);
    loop.start();

    await vi.advanceTimersByTimeAsync(120 * 60_000); // past 08:45
    expect(runBriefingMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3 * 3_600_000); // many more poll cycles, same day
    expect(runBriefingMock).toHaveBeenCalledTimes(1);

    loop.stop();
  }, 15_000);

  it('skips (does not deliver) when the target is reached outside working hours', async () => {
    const hb = heartbeat({
      workingHours: { start: '09:00', end: '17:00' },
      eveningBriefAt: '18:00',
      tickIntervalMin: 100_000,
      resolutionSweepIntervalMin: 100_000,
    });
    const { ctx } = makeCtx(hb);
    const loop = createLoop(ctx);
    loop.start();

    await vi.advanceTimersByTimeAsync(11 * 3_600_000); // 07:00 -> 18:00
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runBriefingMock).not.toHaveBeenCalled();

    loop.stop();
  }, 15_000);

  it('a *_brief_at edited via heartbeat.md is picked up on the next poll — no re-arm call needed', async () => {
    const hb = heartbeat({ morningBriefAt: '10:00' });
    const { ctx, bus } = makeCtx(hb);
    const loop = createLoop(ctx);
    loop.start();

    await vi.advanceTimersByTimeAsync(15 * 60_000); // 07:00 -> 07:15, nowhere near either time
    expect(runBriefingMock).not.toHaveBeenCalled();

    hb.morningBriefAt = '07:20'; // edited to an imminent time
    broadcastHeartbeatChanged(bus); // no special handling for briefings; polling just re-reads config

    await vi.advanceTimersByTimeAsync(6 * 60_000); // cross 07:20 plus a poll cycle
    expect(runBriefingMock).toHaveBeenCalledTimes(1);
    expect(runBriefingMock).toHaveBeenCalledWith(expect.anything(), 'morning_brief');

    loop.stop();
  });

  it('boot catch-up: a target already passed before start() fires immediately, not tomorrow', async () => {
    const hb = heartbeat({ morningBriefAt: '06:00' }); // "now" is pinned to 07:00 — already past
    const { ctx } = makeCtx(hb);
    const loop = createLoop(ctx);
    loop.start();

    await vi.advanceTimersByTimeAsync(0); // let the fire-and-forget delivery settle
    expect(runBriefingMock).toHaveBeenCalledTimes(1);
    expect(runBriefingMock).toHaveBeenCalledWith(expect.anything(), 'morning_brief');

    loop.stop();
  });
});

/**
 * Finding #2: `tick_interval_min` / `resolution_sweep_interval_min` become a
 * raw `setTimeout` delay. Node silently wraps any delay above 2^31-1 ms
 * (~35791 min) to ~1ms instead of erroring — an unbounded interval would
 * otherwise turn "tick every N minutes" into a hot ~1ms loop with real
 * judgment calls. parseHeartbeat clamps at the config layer (see
 * config/parse.ts tests); this locks in the scheduler's OWN defense-in-depth
 * clamp, which must hold even if a HeartbeatConfig reaches it unclamped.
 */
describe('loop scheduler — huge intervals never reach setTimeout unclamped', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T07:00:00'));
    runTickMock.mockReset();
    runResolutionSweepMock.mockReset();
    runBriefingMock.mockReset();
    runTickMock.mockResolvedValue('tick-1');
    runResolutionSweepMock.mockResolvedValue({ checked: 0, closed: [], skipped: [] });
    runBriefingMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('every setTimeout delay armed by the loop stays well under the ms overflow threshold', async () => {
    const hb = heartbeat({
      tickIntervalMin: 999_999_999,
      resolutionSweepIntervalMin: 999_999_999,
    });
    const { ctx } = makeCtx(hb);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const loop = createLoop(ctx);
    loop.start();

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1] as number);
    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) {
      // Node's actual overflow threshold is 2^31-1 (2_147_483_647) ms.
      expect(d).toBeLessThan(2_147_483_647);
      // The loop's own ceiling (MAX_TIMER_DELAY_MS = 7 days) — comfortably clear of it.
      expect(d).toBeLessThanOrEqual(7 * 24 * 60 * 60_000);
    }

    loop.stop();
    setTimeoutSpy.mockRestore();
  });
});
