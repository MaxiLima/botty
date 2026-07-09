import type { Bus } from '../bus/index.js';
import type { Db } from '../db/index.js';
import type { HeartbeatConfig } from '../config/parse.js';
import type { LlmClient } from '../llm/types.js';
import type { Memory } from '../memory/index.js';
import { executeActions } from './actions.js';
import { gatherCandidates } from './candidates.js';
import {
  buildChecklistContext,
  checklistCandidateId,
  dueChecklistTasks,
  executeChecklistNotifies,
  loadChecklistState,
  markChecklistRun,
} from './checklist.js';
import {
  buildCommitmentContext,
  commitmentCandidateId,
  COMMITMENT_STALE_GRACE_HOURS,
  eligibleCommitments,
  executeCommitmentNotifies,
} from './commitments.js';
import { runJudgment, validateJudgment, type JudgmentRunResult } from './judgment.js';
import type { MacNotifier } from './notify-macos.js';
import { applyRulesFilter } from './rules-filter.js';
import type { ResponseTracker } from './response-tracker.js';
import { isActiveDay, isQuietHours, isWithinWorkingHours } from './time.js';

/** One tick of the proactive loop — docs/specs/loop.md steps 1-11. */

export type TickTrigger = 'schedule' | 'run-now';

export interface TickDeps {
  db: Db;
  bus: Bus;
  config: { heartbeat(): HeartbeatConfig };
  llm: LlmClient;
  memory: Memory;
  tracker: Pick<ResponseTracker, 'expire' | 'lastUserMessageAt'>;
  macNotifier?: MacNotifier;
}

export async function runTick(
  deps: TickDeps,
  opts: { trigger: TickTrigger; now?: string },
): Promise<string> {
  const { db, bus, llm, memory, tracker } = deps;
  const now = opts.now ?? new Date().toISOString();
  const manual = opts.trigger === 'run-now';

  // 0. load config + HARD working-hours gate (manual run-now bypasses it).
  // Outside the window a scheduled tick does absolutely nothing — no LLM, no
  // candidates, no per-tick log spam. Exactly one 'off_hours' tick row is
  // written when entering the off window; subsequent skips are silent.
  const hb = deps.config.heartbeat();
  if (!manual && !isWithinWorkingHours(now, hb)) {
    const last = db.listTicks(1)[0];
    if (last?.skippedJson?.includes('"timing":"off_hours"')) return last.id;
    console.log(
      `[loop] outside working hours (${hb.workingHours.start}-${hb.workingHours.end}) — ticks paused until the window reopens`,
    );
    const off = db.insertTickLog(opts.trigger);
    const done = db.finishTickLog(off.id, {
      candidatesIn: 0,
      candidatesAfterRules: 0,
      skippedJson: JSON.stringify({ timing: 'off_hours' }),
    });
    bus.broadcast({ type: 'tick.completed', payload: { tick: done } });
    return done.id;
  }

  // 1. open the tick record
  const tick = db.insertTickLog(opts.trigger);
  const finish = (patch: Parameters<Db['finishTickLog']>[1]): string => {
    const done = db.finishTickLog(tick.id, patch);
    bus.broadcast({ type: 'tick.completed', payload: { tick: done } });
    return done.id;
  };

  try {
    // 2. timing gates (manual run-now bypasses them)
    if (!manual) {
      const reason = isQuietHours(now, hb.quietHours)
        ? 'quiet_hours'
        : !isActiveDay(now, hb.activeDays)
          ? 'inactive_day'
          : null;
      if (reason) {
        return finish({
          candidatesIn: 0,
          candidatesAfterRules: 0,
          skippedJson: JSON.stringify({ timing: reason }),
        });
      }
    }

    // 3. expire stale surfaces (24h response window) + reopen expired snoozes
    tracker.expire(now);
    db.unsnoozeDue(now, 'loop');

    // 4. gather candidates (DUE_SOON / NEVER_SURFACED / STALE / MEETING_PREP)
    // — thresholds come from heartbeat.md — plus due recurring checklist items
    // ('## Tasks'; per-item lastRunAt lives in settings, no LLM cost to check)
    // and due inferred commitments (loop/commitments.ts). Stale commitments
    // (due more than 24h ago, never delivered) are swept before gathering.
    const candidates = gatherCandidates(db, now, hb);
    const dueChecklist = dueChecklistTasks(hb.checklistTasks, loadChecklistState(db), now);
    db.expireStaleCommitments(now, COMMITMENT_STALE_GRACE_HOURS);
    const dueCommitments = eligibleCommitments(db, now, {
      minAgeMin: hb.commitmentMinAgeMin,
      maxPerDay: hb.commitmentsMaxPerDay,
    });

    // 5. layer 1 — rules filter (pure, no LLM)
    // Lookback must cover min_gap_between_nudges_min, or a gap configured above
    // 24h silently caps at 24h (the last nudge falls out of the window and the
    // gate sees no prior nudge at all). See docs/specs/loop.md §5 gate 6.
    const lookbackMs = Math.max(24 * 3_600_000, hb.minGapBetweenNudgesMin * 60_000);
    const recentSurfaces = db.surfacesSince(
      new Date(Date.parse(now) - lookbackMs).toISOString(),
    );
    const mutedUntil: Record<string, string | null> = {};
    for (const p of db.listPeople()) mutedUntil[p.id] = p.mutedUntil;
    const { survivors, rejections } = applyRulesFilter(candidates, hb, now, recentSurfaces, {
      lastUserChatAt: tracker.lastUserMessageAt(),
      mutedUntil,
    });

    // 6. zero-cost floor: no survivors AND no due checklist items AND no due
    // commitments ⇒ done, without an LLM call. A due checklist item or a due
    // commitment alone still reaches judgment.
    if (survivors.length === 0 && dueChecklist.length === 0 && dueCommitments.length === 0) {
      return finish({
        candidatesIn: candidates.length,
        candidatesAfterRules: 0,
        actionsJson: JSON.stringify([]),
        skippedJson: JSON.stringify({ rules: rejections }),
      });
    }

    // 7-8. layer 2 — judgment. Due checklist items ride along as clearly
    // labeled, trusted (user-authored) extra items — see loop/checklist.ts.
    // Due commitments ride along too, but wrapped in the untrusted-content
    // boundary markers (conversation-derived, not user-authored config).
    let context = memory.buildProactiveContext(survivors);
    if (dueChecklist.length > 0) context += `\n\n${buildChecklistContext(dueChecklist)}`;
    if (dueCommitments.length > 0) context += `\n\n${buildCommitmentContext(dueCommitments)}`;

    // #6b fail-open: retry a failed judgment once; on the second failure the
    // tick degrades to a clean "judgment_error → no actions" outcome instead
    // of the exception path (mirrors the resolution sweep failing toward
    // leaving tasks open). Bookkeeping from steps 3-5 (expiry, unsnooze,
    // candidate/rules records) is already done; due checklist items are NOT
    // marked as run, so they retry next tick. The LLM layer has already
    // recorded each failed attempt in ai_decisions.
    let judgment: JudgmentRunResult;
    try {
      judgment = await runJudgment({ llm, db }, { context, now, tickId: tick.id });
    } catch {
      try {
        judgment = await runJudgment({ llm, db }, { context, now, tickId: tick.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorDecisionId =
          db
            .listAiDecisions({ kind: 'judgment', limit: 10 })
            .find((d) => d.relatedRef === tick.id)?.id ?? null;
        return finish({
          candidatesIn: candidates.length,
          candidatesAfterRules: survivors.length,
          actionsJson: JSON.stringify([]),
          skippedJson: JSON.stringify({ rules: rejections, judgment_error: message }),
          judgmentDecisionId: errorDecisionId,
          error: `judgment failed after retry: ${message}`,
        });
      }
    }
    const { output, decisionId } = judgment;

    // 9. validate (threshold, snooze cap, notify cap, hallucinated ids;
    // checklist ids are notify-only and exempt from threshold/notify cap)
    const validTaskIds = new Set(survivors.map((t) => t.id));
    const dueSoonTaskIds = new Set(
      survivors
        .filter((t) => t.dueDate !== null && Date.parse(t.dueDate) - Date.parse(now) < 24 * 3_600_000)
        .map((t) => t.id),
    );
    const checklistIds = new Set(dueChecklist.map((t) => checklistCandidateId(t)));
    const commitmentIds = new Set(dueCommitments.map((c) => commitmentCandidateId(c)));
    const { actions, dropped } = validateJudgment(output, {
      surfacingThreshold: hb.surfacingThreshold,
      validTaskIds,
      dueSoonTaskIds,
      maxSnoozesPerTick: hb.maxSnoozesPerTick,
      checklistIds,
      commitmentIds,
    });

    // 10. execute — task actions, checklist notifies, and commitment notifies
    // take separate paths (neither checklist items nor commitments are tasks;
    // both surface as plain notify text). Delivered commitments are marked via
    // Db.markCommitmentDelivered inside executeCommitmentNotifies — no separate
    // "mark processed" bookkeeping is needed the way checklist lastRunAt is,
    // since a commitment left un-notified (skipped or over the maxPerDay cap)
    // simply stays open for a later tick.
    const reasonByTask: Record<string, string | undefined> = {};
    for (const c of survivors) reasonByTask[c.id] = c.reminderReason;
    const executed = executeActions(
      { db, bus, macNotifier: deps.macNotifier },
      actions.filter((a) => !checklistIds.has(a.taskId) && !commitmentIds.has(a.taskId)),
      { now, trigger: opts.trigger, reasonByTask },
    );
    const executedChecklist = executeChecklistNotifies(
      { db, bus, macNotifier: deps.macNotifier },
      actions.filter((a) => checklistIds.has(a.taskId)),
      dueChecklist,
      { now, trigger: opts.trigger },
    );
    const executedCommitments = executeCommitmentNotifies(
      { db, bus, macNotifier: deps.macNotifier },
      actions.filter((a) => commitmentIds.has(a.taskId)),
      dueCommitments,
      { now, trigger: opts.trigger },
    );
    // Judgment succeeded: every due checklist item was processed (notified or
    // deliberately skipped) — advance lastRunAt for all of them.
    markChecklistRun(db, hb.checklistTasks, dueChecklist, now);

    // 11. record + broadcast
    return finish({
      candidatesIn: candidates.length,
      candidatesAfterRules: survivors.length,
      actionsJson: JSON.stringify([...executed, ...executedChecklist, ...executedCommitments]),
      skippedJson: JSON.stringify({
        rules: rejections,
        judgment: output.skipped,
        droppedActions: dropped,
      }),
      judgmentDecisionId: decisionId,
    });
  } catch (err) {
    return finish({ error: (err as Error).message });
  }
}
