# Proactive loop — tick, judgment, briefings, response tracking, replay

Location: `packages/agent/src/loop/`. Errs toward silence; digest-first.

## Working hours — the HARD gate

`working_hours: HH:MM-HH:MM` (default 08:00-19:00, `## Schedule` in HEARTBEAT.md) combined with
`active_days` is a hard on/off switch, stronger than quiet hours: outside the window (or on an
inactive day) botty does **absolutely nothing** — no source polls, no ticks, no briefings, no
LLM calls. Zero token usage off-hours. Quiet hours remain the softer gate *inside* the window
(polling/ticking continues, only surfacing is suppressed).

Implementation (`isWithinWorkingHours` in `loop/time.ts`, shared by the tick scheduler,
briefings, and the ingest `SourceScheduler`):

- Windows may cross midnight (e.g. `22:00-06:00`); the active-day check applies to the calendar
  day of "now". Malformed or degenerate (`start === end`) windows disable the gate.
- Scheduled ticks off-hours are no-ops: one console line + exactly **one** `off_hours` tick_log
  row when *entering* the off window (dedup: if the latest tick row is already `off_hours`,
  nothing is written); the loop then sleeps until the window start or one tick interval,
  whichever is sooner.
- Briefings whose time falls outside the window are skipped with a console line (no LLM call).
- The ingest scheduler skips scheduled polls entirely (no fetch, no `source_check_log` row; one
  console line on entering the off window).
- **Manual actions bypass the gate**: `run-now` ticks and `checkNow` source checks always run —
  the user explicitly asked.

## Tick flow (`runTick({trigger})`)

1. Load heartbeat config. Working-hours hard gate (see above): scheduled tick off-hours ⇒
   no-op (at most one `off_hours` tick row on entry). Manual trigger (`run-now`) bypasses
   gates 1–3.
2. Timing gates: quiet hours / inactive day ⇒ record skipped tick, done.
3. Expire stale surfaces (response tracker window 24 h ⇒ `response_type='expired'`).
4. Gather candidates: open tasks tagged with reminder reasons — `DUE_SOON` (due ≤ 2d),
   `NEVER_SURFACED` (created > 4h ago, surface_count=0), `STALE` (no update 5d+), plus
   `MEETING_PREP` candidates from calendar. Union, deduped by task.
5. **Layer 1 — rules filter** (pure function, no LLM). Nine gates, cheap first; each rejection
   logged with gate name into the tick's `skipped_json`:
   1. cooldown by surface_count {1→48h, 2→96h, 3+→7d} since last_surfaced_at
   2. hard cap surface_count ≥ max_surfaces_per_task (default 3) unless due < 48h
   3. snoozed (snooze_until > now)
   4. closed status
   5. quiet hours (redundant guard)
   6. global min_gap_between_nudges (default 30 min) since last surface of any task
   7. user active in chat within 2 min
   8. hourly cap max_proactive_per_hour (default 2)
   9. requester muted
6. No survivors ⇒ record tick, done (no LLM call — this matters for cost and inspectability).
7. Build context: heartbeat instructions + PERSONA excerpt + candidate cards (id, description,
   requester+tier, age, status, priority, timesSurfaced, lastSurfaced, due, reminderReason,
   recent response history for that task).
8. **Layer 2 — judgment** (`llm.structured`, task `judgment`), output schema:

```ts
{ tickReasoning: string,
  actions: [{ type: 'notify'|'snooze'|'update_priority', taskId, score /*0-10*/,
              message?, snoozeDays?, priority?, reasoning }],
  skipped: [{ taskId, score, reason }] }
```

   System prompt: actionability gate first; respect dismissal history; strong bias to skip;
   at most ONE notify per tick unless something is due <24h. No `mark_done` here — auto-close
   is the resolution sweep's job (below).
9. Validate: drop notify actions with score < surfacing_threshold; cap snoozes at 5/tick.
10. Execute: `notify` ⇒ proactive_log row + surface_count++ + WS `notification` + macOS
    notification (`terminal-notifier` if present, else `osascript`); `snooze`/`update_priority`
    ⇒ task write + history.
11. Record `tick_log` (with judgment ai_decisions id), WS `tick.completed`, schedule next tick.

## Scheduler

`setTimeout` chain at heartbeat interval (default 20 min). Off-hours the chain sleeps until
the working-hours window start (or one interval, whichever is sooner, so config hot-reloads
still apply); the gate is re-checked at fire time. Event triggers in v1: manual only
(urgent-inbound trigger is M4).

## Briefings

Cron-style at morning/evening times from HEARTBEAT.md. Content assembled from queries (today's
calendar_events, top open tasks by priority/due, stale tasks, yesterday's completions) and
rendered by `llm.structured` task `briefing` into `{ title, body }` (body is markdown). Delivered
as `proactive_log` row (surface_kind morning_brief/evening_brief) + WS notification + macOS
notification. Briefings ignore the notify caps (they ARE the digest) but NOT the working-hours
hard gate: a briefing time outside the window is skipped with a console line.

## Resolution sweep

`loop/resolution-sweep.ts` — the user should never have to tell botty a task is done when the
source thread already says so ("review done" to the requester, "ya está, gracias" back).

Own `setTimeout` chain (default every 10 min, `resolution_sweep_interval_min`), same off-hours
sleep strategy as ticks; gated by `auto_resolve_tasks: on|off` (default on). Manual trigger:
`POST /api/loop/sweep-now` (bypasses working hours, not the on/off gate).

Per sweep, over open+snoozed **slack/gmail** tasks with a `source_ref` (jira/github are closed
deterministically by upstream state sync in `ingest/structured.ts`; gcal/chat/manual have no
thread):

1. **Evidence** (no LLM): `db.threadEvents(source, ref)` — every raw-logged event whose
   `external_id` or body `threadRef` matches the task's base ref, INCLUDING the user's own
   **outbound** replies (see ingestion.md). Events after the originating ask (matched by
   `raw_text`) are the evidence; none ⇒ skip.
2. **Watermark + cooldown** (no LLM): skip unless the thread has a message newer than the last
   judged one; per-task 10-min cooldown (`resolutionCheckCooldownMin`); hard cap 5 LLM calls
   per sweep (`maxResolutionChecksPerSweep`).
3. **Judgment**: `llm.structured` task `resolution` (skip-biased system prompt: promises and
   partial progress are NOT resolution) ⇒ `{ resolved, confidence, reason }`.
4. **Close**: only when `resolved && confidence ≥ 0.8` ⇒ task → done (`changed_by='sweep'`),
   `proactive_log` row (surface_kind `auto_resolve`), WS `notification` (the chat card shows a
   **↩ reopen** undo) + `tasks.updated`. No macOS banner — nothing needs attention.

The judgment prompt (`RESOLUTION_SYSTEM` in `resolution-sweep.ts`) treats the quoted thread as
untrusted input: ORIGIN/EVENT lines quote third-party message content verbatim and are framed
strictly as evidence, never as instructions — anything inside them telling the model how to
answer, what confidence to report, or claiming to speak for the system is ignored. Only lines
marked outbound ("me (the user)") are the user speaking; inbound senders may be untrusted
strangers.

Replay/tuning: `replay --kind resolution` works like judgment replay.

## Response tracker

On each user chat message, classify against surfaces from the last 24h — v1 heuristic only (no
LLM): message mentions task description keywords + "done/hecho/listo/ya está" ⇒ completed;
"later/después/snooze" ⇒ snoozed; explicit dismiss via UI buttons ⇒ dismissed(+reason). UI card
buttons are the primary path (REST `tasks/:id/action`); the tracker fills `proactive_log.response_*`.
Unanswered after 24h ⇒ expired. Dismissal history feeds judgment context (step 7).

## Replay harness

`packages/agent/src/replay/cli.ts`, run via `npm run replay -w @botty/agent --`:

```
replay --kind judgment --last 20 [--model claude-opus-4-8] [--system-file ./new-prompt.md]
replay --kind classification --last 50 --diff-only
```

Loads `ai_decisions` rows of that kind, re-runs `llm.structured` with the stored inputs
(optionally substituting system prompt/model), prints a per-row diff table (old action vs new)
and a summary (changed/unchanged counts). Re-runs are recorded with kind suffix `:replay` so
they don't pollute the primary log. This is the tuning workflow for judgment quality.
