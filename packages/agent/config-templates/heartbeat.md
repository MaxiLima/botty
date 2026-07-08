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
auto_resolve_tasks: on
resolution_sweep_interval_min: 10

<!-- auto_resolve_tasks: the resolution sweep reads each open slack/gmail task's thread and
auto-closes tasks already handled there (you replied "done", the requester said "ya está", …).
Only threads with NEW messages trigger an LLM check (max 5 per sweep); every auto-close shows
a chat card with a reopen button. -->

## Sources

slack: on
gmail: on
gcal: on
jira: on
github: on

<!-- Optional per-source poll interval, e.g. `slack: on, every 10m`. Defaults come from mode
(sim: 1m each; real: slack 10m, gmail 30m, gcal 60m, jira 120m, github 120m). -->

## Instructions

Bias hard toward silence. Only interrupt for things that are due soon, blocking someone
Tier 1, or explicitly promised. Prefer batching into the morning/evening briefs.

## This week

(nothing noted)
