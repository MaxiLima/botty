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
