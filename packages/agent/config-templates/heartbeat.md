# HEARTBEAT

Controls the proactive loop. Every value is optional — anything missing falls back to the
built-in default (shown here). Lines are `key: value`.

## Schedule

tick_interval_min: 20
working_hours: 08:00-19:00
quiet_hours: 22:00-08:00
active_days: mon,tue,wed,thu,fri
morning_brief_at: 08:45
evening_brief_at: 18:00

<!-- working_hours is the HARD on/off switch: outside this window (or on days not in
active_days) botty does absolutely nothing — no source polls, no ticks, no briefings, no LLM
calls (zero token usage). quiet_hours is the softer gate: inside working hours it only stops
notifications from surfacing. Manual actions (run-now, check-now) always bypass the gate. -->


## Behavior

surfacing_threshold: 7
max_surfaces_per_task: 3
max_proactive_per_hour: 2
min_gap_between_nudges_min: 30
max_snoozes_per_tick: 5
surface_cooldown_hours: 48/96/168
response_window_hours: 24
chat_active_gate_min: 2
session_idle_seal_min: 30
meeting_prep_lead_min: 60
due_soon_days: 2
never_surfaced_min_age_hours: 4
stale_after_days: 5
auto_resolve_tasks: on
resolution_sweep_interval_min: 10
max_resolution_checks_per_sweep: 5
resolution_check_cooldown_min: 10
resolution_confidence_min: 0.8
infer_commitments: on
commitment_min_age_min: 30
commitments_max_per_day: 3

<!-- surface_cooldown_hours is per-task re-nudge spacing for the 1st / 2nd / 3rd+ surface.
response_window_hours — how long an unanswered nudge stays open before it expires.
chat_active_gate_min — no nudges while you chatted with botty this recently.
session_idle_seal_min — chat inactivity before the session is summarized and sealed.
due_soon_days / never_surfaced_min_age_hours / stale_after_days tune which open tasks
become tick candidates (due within N days / created N+ hours ago and never surfaced /
untouched for N+ days). infer_commitments turns on a hidden post-chat-turn pass that notices
short-lived follow-ups you mention in passing ("my interview is tomorrow at 3") and reminds you
when they're due — not a task, not memory. commitment_min_age_min stops one from echoing right
back at you moments after you mention it; commitments_max_per_day caps how many can notify in a
rolling 24h window (extras just wait for the next tick). -->

<!-- auto_resolve_tasks: the resolution sweep reads each open slack/gmail task's thread and
auto-closes tasks already handled there (you replied "done", the requester said "ya está", …).
Only threads with NEW messages trigger an LLM check (max max_resolution_checks_per_sweep per
sweep, one per task per resolution_check_cooldown_min, closing only at or above
resolution_confidence_min); every auto-close shows a chat card with a reopen button. -->

## Sources

slack: on
gmail: on
gcal: on
jira: on
github: on

<!-- Optional per-source poll interval, e.g. `slack: on, every 10m`. Defaults come from mode
(sim: 1m each; real: slack 10m, gmail 30m, gcal 60m, jira 120m, github 120m). -->

## Tasks

<!-- Optional recurring checklist items, one bullet per item, evaluated on the tick:
`- every 4h: check whether the CI dashboard has red builds I should mention`
`- every 1d: remind me to review my inbox zero state`
Intervals take m/h/d. A due item is offered to the judgment layer, which surfaces it as a
plain notification (or stays silent); items never create tasks. Nothing here means no cost. -->

## Instructions

Bias hard toward silence. Only interrupt for things that are due soon, blocking someone
Tier 1, or explicitly promised. Prefer batching into the morning/evening briefs.

## This week

(nothing noted)
