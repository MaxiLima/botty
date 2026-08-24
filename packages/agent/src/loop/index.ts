import type { AgentContext } from '../context.js';
import type { HeartbeatConfig } from '../config/parse.js';
import { runBriefing, type BriefKind } from './briefings.js';
import { createSweepState, runResolutionSweep, type SweepResult } from './resolution-sweep.js';
import { createResponseTracker } from './response-tracker.js';
import { createReminderScheduler } from './reminders.js';
import { runTick, type TickTrigger } from './tick.js';
import { isWithinWorkingHours, localMinutes, msUntilNextTime, parseHHMM } from './time.js';

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
  createReminderScheduler,
  REMINDER_SCAN_INTERVAL_MS,
  type ReminderScheduler,
} from './reminders.js';
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

/**
 * Defense in depth for the setTimeout-overflow footgun: `parseHeartbeat`
 * (config/parse.ts) now clamps `tick_interval_min` / `resolution_sweep_interval_min`
 * to a 7-day ceiling at parse time, but a HeartbeatConfig can reach this
 * scheduler from anywhere (tests, a future config source) — this guards the
 * arming site itself so a delay above this can never become a hot ~1ms loop
 * even if an upstream clamp is ever missing. Comfortably under Node's
 * 2^31-1 ms setTimeout ceiling (~24.8 days).
 */
const MAX_TIMER_DELAY_MS = 7 * 24 * 60 * 60_000; // 7 days

/** How often the briefing wall-clock check runs (finding #4: 14h+ single
 * setTimeouts are fragile across laptop sleep and TZ changes — poll instead). */
const BRIEF_CHECK_INTERVAL_MS = 45_000;

/** Fingerprint of the config fields that actually change a tick's arm time
 * (interval + the off-hours fallback inputs). Used to skip re-arming the
 * tick timer on a heartbeat.md reload that didn't touch any of them — see
 * finding #3 (frequent heartbeat.md saves, e.g. an editor autosave, must not
 * starve the scheduled tick by resetting its deadline on every save). */
function tickFingerprint(hb: HeartbeatConfig): string {
  return `${hb.tickIntervalMin}|${hb.workingHours.start}|${hb.workingHours.end}|${hb.activeDays.join(',')}`;
}

/** Same as tickFingerprint, for the resolution sweep's interval knob. */
function sweepFingerprint(hb: HeartbeatConfig): string {
  return `${hb.resolutionSweepIntervalMin}|${hb.workingHours.start}|${hb.workingHours.end}|${hb.activeDays.join(',')}`;
}

export function createLoop(ctx: AgentContext): Loop {
  const { db, bus, config, llm, memory } = ctx;
  const tracker = createResponseTracker({ db, bus, config });
  const reminders = createReminderScheduler({ db, bus });
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
  /** The fingerprint each timer was last armed under — see tickFingerprint(). */
  let armedTickFingerprint: string | null = null;
  let armedSweepFingerprint: string | null = null;
  let unsubscribeConfig: (() => void) | null = null;
  /** Wall-clock poller for briefings — replaces one long setTimeout per kind. */
  let briefCheckTimer: NodeJS.Timeout | null = null;
  /** Local calendar date (YYYY-MM-DD) each brief kind was last delivered on
   * this process. Only a fast-path cache — alreadyDeliveredToday() falls back
   * to proactive_log (durable across restarts) on a cache miss. */
  const briefDeliveredDate = new Map<BriefKind, string>();
  /** Last invalid `*_brief_at` value warned about per kind, so a persistently
   * broken config doesn't spam the log every 45s. */
  const warnedInvalidBrief = new Map<BriefKind, string>();
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
    armedTickFingerprint = tickFingerprint(hb);
    const intervalMs = Math.min(Math.max(1, hb.tickIntervalMin) * 60_000, MAX_TIMER_DELAY_MS);
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
    armedSweepFingerprint = sweepFingerprint(hb);
    const intervalMs = Math.min(Math.max(1, hb.resolutionSweepIntervalMin) * 60_000, MAX_TIMER_DELAY_MS);
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

  /** YYYY-MM-DD for `d`'s local calendar day (matches localMinutes/parseHHMM's
   * "local" — i.e. the process time zone, same as the rest of this module). */
  function localDateKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** Has `kind` already been delivered on `now`'s local calendar day? Checked
   * against proactive_log (durable across restarts — a restart shortly after
   * a briefing fired must not re-fire it), with the in-memory map as a
   * same-process fast path once known. */
  function alreadyDeliveredToday(kind: BriefKind, now: Date): boolean {
    const key = localDateKey(now);
    if (briefDeliveredDate.get(kind) === key) return true;
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const delivered = db.surfacesSince(dayStart.toISOString()).some((s) => s.surfaceKind === kind);
    if (delivered) briefDeliveredDate.set(kind, key);
    return delivered;
  }

  /**
   * Wall-clock check for both briefing kinds (finding #4). Replaces one
   * long-lived `setTimeout` per kind (up to ~14h) with a cheap poll every
   * BRIEF_CHECK_INTERVAL_MS: "has local wall-clock time reached today's
   * `*_brief_at`, and have we not delivered `kind` yet today?" A single long
   * timer is fragile across laptop sleep (the delay was computed once, from
   * whatever `now` was at arm time) and TZ changes (the process TZ can change
   * — e.g. a laptop travels — mid-wait, silently invalidating the delay); a
   * short recurring check re-derives "is it time yet?" from the current
   * wall-clock every time, so it self-corrects. It also gives boot catch-up
   * for free: called once synchronously from start(), so a briefing whose
   * target already passed today before the process even started fires
   * immediately instead of waiting until tomorrow.
   */
  function checkBriefings(): void {
    if (!started) return;
    const now = new Date();
    const hb = config.heartbeat();
    for (const kind of ['morning_brief', 'evening_brief'] as const satisfies readonly BriefKind[]) {
      const at = kind === 'morning_brief' ? hb.morningBriefAt : hb.eveningBriefAt;
      const target = parseHHMM(at);
      if (target === null) {
        // Unparseable brief time (should be caught by config validation and
        // rejected to last-known-good): warn once per distinct bad value,
        // not every 45s, and leave the kind unscheduled.
        if (warnedInvalidBrief.get(kind) !== at) {
          console.error(`[loop] ${kind}_at "${at}" is invalid — ${kind} not scheduled`);
          warnedInvalidBrief.set(kind, at);
        }
        continue;
      }
      warnedInvalidBrief.delete(kind);
      if (localMinutes(now.toISOString()) < target) continue; // not due yet today
      if (alreadyDeliveredToday(kind, now)) continue;
      // Claim today's slot before awaiting anything — an overlapping poll
      // (a slow LLM call spanning a 45s tick) must not double-fire.
      briefDeliveredDate.set(kind, localDateKey(now));
      void (async () => {
        try {
          // Briefings ignore the notify caps, but the HARD working-hours gate
          // applies: outside the window (or on inactive days) ⇒ no LLM call.
          // Re-read live config/time — this can run a poll tick or more after
          // the check above.
          if (isWithinWorkingHours(new Date().toISOString(), config.heartbeat())) {
            await runBriefing({ db, bus, llm, config }, kind);
          } else {
            console.log(`[loop] ${kind} skipped — outside working hours`);
          }
        } catch (err) {
          console.error(`[loop] ${kind} failed:`, (err as Error).message);
        }
      })();
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      tracker.start();
      // Explicit set_reminder deliveries — precise-time, judgment-free, and
      // deliberately NOT behind the working/quiet-hours gates (see reminders.ts).
      reminders.start();
      scheduleNextTick();
      scheduleSweep();
      // Run once immediately (boot catch-up: a target already passed today
      // fires right away instead of waiting until tomorrow — see
      // checkBriefings' doc comment), then keep polling.
      checkBriefings();
      briefCheckTimer = setInterval(checkBriefings, BRIEF_CHECK_INTERVAL_MS);
      // Tick/sweep timers capture their fire time at arm time — re-arm on a
      // heartbeat.md hot-reload so edits like "tick_interval_min: 5" take
      // effect without a restart. Gated on a fingerprint of the fields that
      // actually affect the arm time: an unrelated field changing (or an
      // editor autosaving the same values repeatedly) must NOT reset the
      // deadline, or the tick/sweep can starve forever under frequent saves.
      // Briefings need no re-arm at all here — checkBriefings() re-reads
      // config.heartbeat() live on every poll, so a brief-time edit is picked
      // up within BRIEF_CHECK_INTERVAL_MS with zero extra bookkeeping.
      unsubscribeConfig = bus.onBroadcast((event) => {
        if (event.type !== 'config.changed' || event.payload.name !== 'heartbeat') return;
        const hb = config.heartbeat();
        if (tickFingerprint(hb) !== armedTickFingerprint) {
          console.log('[loop] heartbeat.md changed — tick cadence/window changed, re-arming tick timer');
          if (tickTimer) clearTimeout(tickTimer);
          scheduleNextTick();
        }
        if (sweepFingerprint(hb) !== armedSweepFingerprint) {
          console.log('[loop] heartbeat.md changed — sweep cadence/window changed, re-arming sweep timer');
          if (sweepTimer) clearTimeout(sweepTimer);
          scheduleSweep();
        }
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
      armedTickFingerprint = null;
      armedSweepFingerprint = null;
      if (briefCheckTimer) clearInterval(briefCheckTimer);
      briefCheckTimer = null;
      briefDeliveredDate.clear();
      warnedInvalidBrief.clear();
      reminders.stop();
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
