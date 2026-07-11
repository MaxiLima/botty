import type { AgentContext } from '../context.js';
import { runBriefing, type BriefKind } from './briefings.js';
import { createSweepState, runResolutionSweep, type SweepResult } from './resolution-sweep.js';
import { createResponseTracker } from './response-tracker.js';
import { runTick, type TickTrigger } from './tick.js';
import { isWithinWorkingHours, msUntilNextTime } from './time.js';

export { gatherCandidates, meetingPrepTasks, type CandidateThresholds } from './candidates.js';
export {
  buildChecklistContext,
  checklistCandidateId,
  dueChecklistTasks,
  executeChecklistNotifies,
  loadChecklistState,
  markChecklistRun,
  CHECKLIST_ID_PREFIX,
  CHECKLIST_STATE_KEY,
  type ChecklistState,
} from './checklist.js';
export { applyRulesFilter, type GateName, type RulesFilterResult } from './rules-filter.js';
export { buildJudgmentPrompt, runJudgment, validateJudgment, JUDGMENT_SYSTEM } from './judgment.js';
export { executeActions, type ExecutedAction } from './actions.js';
export { runTick, type TickDeps, type TickTrigger } from './tick.js';
export { runBriefing, buildBriefingPrompt, type BriefKind } from './briefings.js';
export { createResponseTracker, classifyMessage, type ResponseTracker } from './response-tracker.js';
export {
  runResolutionSweep,
  createSweepState,
  buildResolutionPrompt,
  gatherEvidence,
  baseThreadRef,
  RESOLUTION_SYSTEM,
  type SweepResult,
  type SweepState,
} from './resolution-sweep.js';

/** Proactive loop: tick scheduler, rules filter, judgment, briefings, resolution sweep. See docs/specs/loop.md. */
export interface Loop {
  /** Start the tick scheduler + briefing + resolution-sweep timers. */
  start(): void;
  stop(): void;
  /** Run one tick immediately (bypasses timing gates); resolves to the tick_log id. */
  runNow(): Promise<string>;
  /** Run one resolution sweep immediately (still honors auto_resolve_tasks). */
  sweepNow(): Promise<SweepResult>;
}

export function createLoop(ctx: AgentContext): Loop {
  const { db, bus, config, llm, memory } = ctx;
  const tracker = createResponseTracker({ db, bus, config });
  const tickDeps = { db, bus, config, llm, memory, tracker };

  let started = false;
  let tickTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  /**
   * Bumped every time a tick/sweep chain is (re-)armed (start(), or a
   * heartbeat.md hot-reload). A fired timer's callback captures the epoch it
   * was armed under and re-checks it both before running and before
   * re-arming — so a config reload that lands mid-execution (clearTimeout on
   * an already-fired handle is a no-op) still leaves exactly one live chain:
   * the stale chain notices it's been superseded and lets itself die instead
   * of re-arming a second one. See packages/agent/src/loop/index.ts history
   * for the duplicate-chain bug this guards against.
   */
  let tickEpoch = 0;
  let sweepEpoch = 0;
  let unsubscribeConfig: (() => void) | null = null;
  const briefTimers = new Map<BriefKind, NodeJS.Timeout>();
  /** Serializes ticks so run-now never overlaps a scheduled tick. */
  let inFlight: Promise<string> | null = null;
  /** Watermarks so unchanged threads never re-trigger a resolution LLM call. */
  const sweepState = createSweepState();
  /** Serializes sweeps so sweep-now never overlaps a scheduled sweep. */
  let sweepInFlight: Promise<SweepResult> | null = null;

  async function execTick(trigger: TickTrigger): Promise<string> {
    while (inFlight) await inFlight.catch(() => undefined);
    const run = runTick(tickDeps, { trigger });
    inFlight = run;
    try {
      return await run;
    } finally {
      inFlight = null;
    }
  }

  function scheduleNextTick(): void {
    if (!started) return;
    const epoch = ++tickEpoch;
    const hb = config.heartbeat();
    const intervalMs = Math.max(1, hb.tickIntervalMin) * 60_000;
    // Off hours: no point waking on the normal cadence — sleep until the
    // working window reopens (or one interval, whichever comes first, so
    // config hot-reloads still get picked up). runTick itself re-checks the
    // gate at fire time, so a tick scheduled inside the window that fires
    // after it closes is still a hard no-op.
    const untilWindow = msUntilNextTime(new Date(), hb.workingHours.start);
    const delayMs = isWithinWorkingHours(new Date().toISOString(), hb)
      ? intervalMs
      // An unparseable working_hours.start (should be caught by config
      // validation and rejected to last-known-good) falls back to the normal
      // cadence rather than a bogus midnight arm — see loop/time.ts.
      : untilWindow === null
        ? intervalMs
        : Math.min(intervalMs, untilWindow);
    tickTimer = setTimeout(async () => {
      // Stopped, or a heartbeat.md reload armed a newer chain while we were
      // waiting to fire: let this chain die instead of running/re-arming.
      if (!started || epoch !== tickEpoch) return;
      try {
        // Working hours / quiet hours / inactive days are enforced inside runTick.
        await execTick('schedule');
      } catch (err) {
        console.error('[loop] tick failed:', (err as Error).message);
      }
      // Re-check after the (multi-second) LLM call: stop() or a config
      // reload may have superseded this chain while it was in flight.
      if (!started || epoch !== tickEpoch) return;
      scheduleNextTick();
    }, delayMs);
  }

  async function execSweep(trigger: 'schedule' | 'sweep-now'): Promise<SweepResult> {
    while (sweepInFlight) await sweepInFlight.catch(() => undefined);
    const run = runResolutionSweep({ db, bus, config, llm }, { state: sweepState, trigger });
    sweepInFlight = run;
    try {
      return await run;
    } finally {
      sweepInFlight = null;
    }
  }

  function scheduleSweep(): void {
    if (!started) return;
    const epoch = ++sweepEpoch;
    const hb = config.heartbeat();
    const intervalMs = Math.max(1, hb.resolutionSweepIntervalMin) * 60_000;
    // Same off-hours strategy as ticks: sleep until the window reopens (capped
    // at one interval so config hot-reloads still get picked up).
    const untilWindow = msUntilNextTime(new Date(), hb.workingHours.start);
    const delayMs = isWithinWorkingHours(new Date().toISOString(), hb)
      ? intervalMs
      // See scheduleNextTick: an unparseable working_hours.start falls back
      // to the normal cadence instead of a bogus midnight arm.
      : untilWindow === null
        ? intervalMs
        : Math.min(intervalMs, untilWindow);
    sweepTimer = setTimeout(async () => {
      // Stopped, or a heartbeat.md reload armed a newer chain while we were
      // waiting to fire: let this chain die instead of running/re-arming.
      if (!started || epoch !== sweepEpoch) return;
      try {
        // HARD working-hours gate re-checked at fire time: off-hours ⇒ no LLM.
        if (isWithinWorkingHours(new Date().toISOString(), config.heartbeat())) {
          const r = await execSweep('schedule');
          if (r.checked > 0 || r.closed.length > 0) {
            console.log(
              `[loop] resolution sweep: ${r.checked} checked, ${r.closed.length} auto-closed`,
            );
          }
        }
      } catch (err) {
        console.error('[loop] resolution sweep failed:', (err as Error).message);
      }
      // Re-check after the (up to 5x LLM call) sweep: stop() or a config
      // reload may have superseded this chain while it was in flight.
      if (!started || epoch !== sweepEpoch) return;
      scheduleSweep();
    }, delayMs);
  }

  function scheduleBriefing(kind: BriefKind): void {
    if (!started) return;
    const hb = config.heartbeat();
    const at = kind === 'morning_brief' ? hb.morningBriefAt : hb.eveningBriefAt;
    const existing = briefTimers.get(kind);
    if (existing) clearTimeout(existing);
    const delayMs = msUntilNextTime(new Date(), at);
    if (delayMs === null) {
      // Unparseable brief time (should be caught by config validation and
      // rejected to last-known-good): don't arm a bogus midnight timer —
      // leave the kind unscheduled until a config reload re-arms it.
      briefTimers.delete(kind);
      console.error(`[loop] ${kind}_at "${at}" is invalid — ${kind} timer not armed`);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        // Briefings ignore the notify caps, but the HARD working-hours gate
        // applies: outside the window (or on inactive days) ⇒ no LLM call.
        if (isWithinWorkingHours(new Date().toISOString(), config.heartbeat())) {
          await runBriefing({ db, bus, llm, config }, kind);
        } else {
          console.log(`[loop] ${kind} skipped — outside working hours`);
        }
      } catch (err) {
        console.error(`[loop] ${kind} failed:`, (err as Error).message);
      }
      scheduleBriefing(kind);
    }, delayMs);
    briefTimers.set(kind, timer);
  }

  return {
    start() {
      if (started) return;
      started = true;
      tracker.start();
      scheduleNextTick();
      scheduleSweep();
      scheduleBriefing('morning_brief');
      scheduleBriefing('evening_brief');
      // Timers capture fire times at arm time — re-arm when heartbeat.md changes
      // so edits like "morning_brief_at: 17:58" take effect without a restart.
      unsubscribeConfig = bus.onBroadcast((event) => {
        if (event.type !== 'config.changed' || event.payload.name !== 'heartbeat') return;
        console.log('[loop] heartbeat.md changed — re-arming tick + sweep + briefing timers');
        if (tickTimer) clearTimeout(tickTimer);
        if (sweepTimer) clearTimeout(sweepTimer);
        scheduleNextTick();
        scheduleSweep();
        scheduleBriefing('morning_brief');
        scheduleBriefing('evening_brief');
      });
    },
    stop() {
      started = false;
      unsubscribeConfig?.();
      unsubscribeConfig = null;
      if (tickTimer) clearTimeout(tickTimer);
      tickTimer = null;
      if (sweepTimer) clearTimeout(sweepTimer);
      sweepTimer = null;
      for (const t of briefTimers.values()) clearTimeout(t);
      briefTimers.clear();
      tracker.stop();
    },
    runNow() {
      return execTick('run-now');
    },
    sweepNow() {
      return execSweep('sweep-now');
    },
  };
}
