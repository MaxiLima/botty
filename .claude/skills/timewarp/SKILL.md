---
name: timewarp
description: Safely shift the DB clock to test botty's time-gated proactive loop (min-age, staleness, cooldowns, snooze) without waiting real hours/days. Use when asked to test nudges/briefings/staleness, or any time "advance time", "timewarp", "simulate N hours/days passing".
---

# Timewarp — shifting the DB clock

`applyTimewarp` (in `packages/agent/src/tools/timewarp.ts`) shifts **every** timestamp
in the DB uniformly into the past. "Advancing time by 6 hours" = subtracting 6 hours
from every stored timestamp, so age-based gates (never-surfaced min-age, staleness,
cooldowns, snooze expiry, due-date proximity) behave as if the time had really passed.
Because ISO-8601 strings sort lexicographically, a uniform shift preserves all
orderings — safe to run repeatedly.

## ⚠️ Never touch the live instance (port 4820)

The default DB (`~/.botty/data/botty.db`) belongs to the owner's live agent. Only
timewarp a DB you started yourself (isolated instance, see the `verify` skill) or
one you have deliberately chosen to warp with the owner's explicit go-ahead.

## Recipe

1. **Stop the target agent first.** The agent holds a WAL lock on the DB; running
   timewarp against a live process risks lock contention / a brief wait. Kill by
   port, **never `pkill tsx`** (the live agent is also `tsx watch`, so a blanket
   pkill would take it down too), and keep `-sTCP:LISTEN` or you'll also kill
   connected clients (e.g. a TUI attached to that port):
   ```sh
   lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill   # e.g. 5820 for the isolated instance
   ```
2. **Run the warp** — root passthrough or the workspace script directly:
   ```sh
   npm run timewarp -- --hours 6
   npm run timewarp -- --days 2
   # equivalent: npm run timewarp -w @botty/agent -- --hours 6
   ```
   Optional `--db <path>` to target a specific DB file instead of the env-derived
   default (`$BOTTY_DATA_DIR/data/botty.db`, or `~/.botty` if unset).
3. **Restart the agent** with the same env it was using before (isolated instance:
   `AGENT_PORT`/`BOTTY_SIM_PORT`/`BOTTY_SIM_URL`/`BOTTY_DATA_DIR`/`BOTTY_MODE` — see
   the `verify` skill).
4. **Verify the shift landed**: check a known row's timestamp moved, or just observe
   the behavior you're testing (e.g. Inspector → Ticks shows the task's candidate
   reason flip from `NEVER_SURFACED` to `STALE`).

## Common test sequences (from docs/TESTING.md)

- **Min-age gate**: fresh task → timewarp `--hours 6` → tick → now eligible as a
  candidate (tasks are deliberately not surfaced before ~4h old).
- **Staleness re-entry**: timewarp `--days 6` → tick → untouched task reappears with
  reason `STALE`.
- **Cooldown escalation**: after a nudge, timewarp `--days 6` → tick → task
  re-surfaces (cooldown expired), `surface_count` climbs; cooldown then demands
  progressively longer gaps (96h, then 7d) before the hard cap silences it.
- **Dismissal persistence**: Dismiss a nudge with a reason → timewarp `--days 2` →
  tick → judgment sees the dismissal in response history and skips it.

## Replay alongside timewarp

To check whether prompt/model changes would alter past judgment calls (not a
time-shift, but often used in the same testing session):

```sh
npm run replay -- --kind judgment --last 20
# equivalent: npm run replay -w @botty/agent -- --kind judgment --last 20
```

See the `judgment-replay` skill for the full prompt-tuning workflow.
