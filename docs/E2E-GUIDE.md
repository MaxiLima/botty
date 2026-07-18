# Simulate & test everything, end to end

How to exercise every behavior botty has — intake, task capture, nudges, anti-nag,
resolution, briefings, chat — against the simulator, with time compressed from hours
to seconds. No Slack, Gmail, or Calendar accounts needed.

Companion docs: `docs/TESTING.md` (§0 sandbox + per-behavior recipes),
`.claude/skills/sandbox/SKILL.md`, `docs/specs/simulator.md`.

## 1. The mental model

Everything you test is one pipeline. An event enters the sim, botty polls it in, the
funnel decides whether it becomes a task, and the proactive loop decides whether that
task becomes a nudge:

```
sim event ──(poll, 1 min · or check-now)──▶ funnel ──▶ task in DB
                                             │
              dedup → direction → tier → heuristics → classify → extract
                                             │
task ──(tick, 1 min · gates: age, cooldown, caps)──▶ judgment (LLM) ──▶ nudge in TUI/web
```

Two clocks matter. The **poll/tick clock** is wall time — the sandbox collapses it to
1 minute, and `check`/`tick` force it to *now*. The **DB clock** is what age-based
gates read (min-age, cooldowns, staleness) — you move it with `warp`, not by waiting.

Know the port map before touching anything:

| Ports | What | Rules |
|---|---|---|
| **4820 / 4821** | Live dev — **hands off** | Your real daily instance (`~/.botty`). Never kill, timewarp, or point tests here. |
| 5820 / 5821 | Verify — ephemeral | Throwaway instances for verifying code changes (temp data dir, usually mock LLM). |
| **6820 / 6821** | Sandbox — persistent | Your testing playground (`~/.botty-sandbox`). This guide lives here. |

## 2. Boot the sandbox

```sh
npm run sandbox              # sim :6821 + agent :6820 + attaches the TUI
npm run sandbox -- --no-tui  # same, without attaching the TUI
```

First boot seeds `~/.botty-sandbox/config/` with a **fast heartbeat profile** (1-min
tick, zero min-age, working/quiet hours disabled, cooldowns 1/2/4 h) and a fixture
`team.md`. Both are hot-reloaded — edit them mid-session and the next cycle picks the
change up, no restart.

| Person | Weight → tier | Use them to test |
|---|---|---|
| **Marian** `@marian` | CRITICAL → 1 | urgent asks, manager pressure, meeting prep |
| **Sofi** `@sofi` | CRITICAL → 1 | urgent email with a deliverable |
| **Diego** `@diego` | HIGH → 1 | peer asks, threads, resolution sweep |
| **Caro** `@caro` | HIGH → 1 | meeting-notes emails with action items |
| **Fer** `@fer` | HIGH → 1 | external vendor mail (different domain) |
| **Rodrigo** `@rodrigo` | NORMAL → 2 | *the tier gate* — his messages must never become tasks |

Runs the **real LLM** through your Claude Code login (Haiku classifies/extracts,
Sonnet judges). `--mock` makes intake free and instant, but mock judgment always
returns "skip" — **you will never see a nudge under mock**. Use it only for
funnel-level testing.

```sh
npm run sandbox status   # agent health + sim state
npm run sandbox stop     # kill the 6820/6821 listeners; data survives
npm run sandbox reset    # wipe ~/.botty-sandbox and reseed from scratch
```

## 3. Inject events

Three ways in, same effect — an event appears in the sim and botty ingests it.

**a. CLI templates** — fastest loop, because it also forces the source poll, so the
funnel runs within seconds:

```sh
npm run sandbox inject slack-dm-urgent
```

| Template | What it simulates |
|---|---|
| `slack-dm-urgent` | Marian: urgent prod ping (Tier-1 ask → task) |
| `slack-dm-social` | social noise from a Tier-1 person (→ no task) |
| `slack-tier2-noise` | Rodrigo DM (→ dies at the tier gate) |
| `slack-thread-ask` | Diego asks for a doc in thread `T-SBX-1` |
| `slack-thread-self-reply` | **your own** outbound "listo ✅" in that thread |
| `slack-outbound-done` | your outbound reply in the default urgent thread |
| `gmail-urgent` | Sofi: urgent email with a deadline |
| `gmail-meeting-notes` | Caro: meeting notes with action items for you |
| `gcal-soon` / `gcal-invite-soon` | meeting starting in ~30–45 min |
| `gcal-invite-tomorrow` | vendor demo in 24 h |
| `jira-assigned` / `github-pr` | structured sources (task upsert, no LLM) |

**b. The sim panel** — <http://localhost:6821>. Forms for every template plus a
free-form inject where you set sender, text, thread, and direction. Use this when you
want to improvise a conversation.

**c. Raw curl** — full control, good for scripting:

```sh
curl -s -XPOST localhost:6821/control/inject -H 'content-type: application/json' -d '{
  "source": "slack", "kind": "dm",
  "actor": { "handle": "@marian", "displayName": "Marian Gutiérrez" },
  "text": "Can you send me the Q3 fraud numbers before the meeting?",
  "threadRef": "T-Q3",
  "direction": "inbound"
}'
curl -s -XPOST localhost:6820/api/sources/slack/check-now   # skip the 1-min poll
```

Fields worth knowing: `direction: "outbound"` = a message *from you* (never
task-extracted; feeds the resolution sweep). Same `threadRef` = same conversation.
`externalId` is minted fresh per inject — reuse one to test the dedup path. Gmail
convention: `"Subject: X\n\nBody"`. Calendar events take
`meta.startAtMinute`/`durationMin` relative to now.

## 4. Observe the reaction

The TUI is your main window (it attaches automatically, or
`npm run dev:tui -- --port 6820`):

| Surface | What you see there |
|---|---|
| chat (just type) | talk to botty; ask "qué tengo pendiente?" to test recall |
| inline `botty ✦` items | nudges and resolution cards, as they fire |
| `/tasks` | the task board — what the funnel captured, priority, status |
| `/inspector` | **the answer to "why did/didn't it act?"** — every AI decision, tick (with per-gate results), and source check |
| `/people [name]` | tiers, interactions, per-person tasks |
| `/costs` · `/health` | LLM spend · confirm you're on :6820 with the sandbox dbPath |

The web app on <http://localhost:6820> shows the same data and is where task actions
(done/snooze/dismiss) and consent approvals live. One thing botty never does: send
Slack replies back into the sim — it has no send tool by design. Its "response" is
always a task, a nudge, or chat text.

## 5. Recipes — one per behavior

### Task capture from a Tier-1 ask

```sh
npm run sandbox inject slack-dm-urgent
```

**Expect** — a P1 task in `/tasks` within seconds; classification + extraction rows
in `/inspector`. A nudge follows within ~1–2 min (or force it: `npm run sandbox tick`).

### The tier gate (negative test)

```sh
npm run sandbox inject slack-tier2-noise    # Rodrigo, Tier 2
npm run sandbox inject slack-dm-social      # Tier 1, but pure noise
```

**Expect** — zero new tasks. Rodrigo dies at the tier check (no LLM spent); the
social DM either fails heuristics or gets classified out — see the outcome in
`/inspector`.

### Meeting-notes email → action items

```sh
npm run sandbox inject gmail-meeting-notes
```

**Expect** — task(s) extracted for *your* action items ("send the R-77 rollback
plan…"), not Diego's line. Owner tagging: an item someone else owes you shows as
"waiting on" instead of a P1 for you.

### Calendar → meeting prep

```sh
npm run sandbox inject gcal-invite-soon     # starts in 45 min, Marian attending
npm run sandbox tick
```

**Expect** — instant calendar upsert (no LLM), then a meeting-prep task/nudge because
a Tier-1 attendee is inside the 60-min prep window.

### Simulating yourself + auto-resolution

```sh
npm run sandbox inject slack-thread-ask         # Diego asks → task
npm run sandbox inject slack-thread-self-reply  # you: "listo ✅" in the same thread
npm run sandbox sweep
```

**Expect** — the task flips to **done** and a resolution card (with a reopen button)
appears in chat. Your outbound message itself never becomes a task.

### Nudge quality + anti-nag

```sh
npm run sandbox tick   # then run it four more times, quickly
```

**Expect** — at most the first tick nudges; the rest stay silent. In `/inspector`
each surfaced task now shows gate results: `cooldown` (1 h in the sandbox),
`hourly_cap` (30), `hard_cap` (3 per task). Hammering tick must *not* produce repeat
pings — that's the anti-nag contract.

### Chat recall & tools

```
# in the TUI, after injecting a few asks:
qué tengo pendiente hoy?
```

**Expect** — botty lists the open tasks with requesters, can capture new ones from
chat ("remind me to…"), and marks them done when you say so (taskAction tool lines
appear).

## 6. Mock time — `warp`

Anything age-based won't react to forced ticks — those gates read the DB clock.
Shift it:

```sh
npm run sandbox warp -- --hours 2   # past the 1 h re-surface cooldown
npm run sandbox warp -- --days 2    # past stale_after_days: 1 → STALE candidates
```

It stops the sandbox agent, shifts *every* timestamp in the DB uniformly (orderings
and relative ages stay consistent — safe to repeat), and restarts the agent. The
attached TUI loses its socket on restart; relaunch it.

| To test… | Do | Expect after `tick` |
|---|---|---|
| re-nudge / escalation | surface once, `warp --hours 2` | second nudge (surface 2/3) |
| staleness | capture task, `warp --days 2` | STALE candidate, judgment may resurface |
| snooze expiry | snooze in web, warp past it | task back in candidacy |
| waiting-on follow-up | `owner='them'` task + warp | "Diego promised X — ping him?" |

## 7. Scripted scenarios — a whole day at once

For a realistic mixed stream instead of hand-fed events, load a scenario timeline
(`packages/sim/scenarios/workweek.json` — 40 events across all five sources
exercising every funnel path):

```sh
curl -s -XPOST localhost:6821/control/scenario/load -H 'content-type: application/json' -d '{"name":"workweek"}'
curl -s -XPOST localhost:6821/control/advance -d '{"minutes":120}' -H 'content-type: application/json'
npm run sandbox check          # pull everything released so far into the funnel
```

`advance` jumps the scenario clock (releasing due events); `play` streams them
continuously (`{"speed":120}` = 2 scenario-minutes per real second); `pause` stops
the clock. Reload the `sandbox` scenario afterwards to get the inject templates back
(`start` does this automatically).

## 8. When you need to look deeper

```sh
# every AI decision, straight from the DB (read-only)
sqlite3 ~/.botty-sandbox/data/botty.db \
  "select kind, model, substr(output_json,1,120) from ai_decisions order by created_at desc limit 10"

# replay recorded judgments against a changed prompt/model (prompt-tuning loop)
npm run replay -- --kind judgment --last 20 --db ~/.botty-sandbox/data/botty.db

# process logs
tail -f ~/.botty-sandbox/logs/agent.log
```

Rule of thumb: before guessing why botty did (or didn't do) something, read the
decision — every classification, extraction, and tick judgment is recorded with its
reasoning.

## 9. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Task captured, no nudge ever | Running `--mock`? Mock judgment always skips. Restart without it. |
| Nudge didn't fire under real LLM | Often legitimate — judgment is biased toward silence (threshold 7). Read the tick's reasoning in `/inspector` before calling it a bug. |
| Task exists but never surfaces | A rules gate — check which one in `/inspector` (cooldown, hourly cap, hard cap, snoozed, muted). `tick` doesn't bypass these; `warp` does. |
| Injected but nothing ingested | Did the poll run? `npm run sandbox check`. Also confirm the sim shows the event: `curl -s localhost:6821/control/state`. |
| TUI froze after `warp` | Expected — the agent restarted. Relaunch: `npm run dev:tui -- --port 6820`. |
| Re-injecting created a duplicate task | Each inject mints a fresh externalId, so it's a genuinely new event. Reuse the same `externalId` via curl to test the dedup path instead. `reset` is cheap. |
| Multi-line email extracts nothing under `--mock` | The mock classifier reads only the first text line — put a signal phrase ("please", "?", "by friday") in the Subject. |
| Everything is silent, zero LLM calls | Check `working_hours` in the sandbox heartbeat wasn't edited — `00:00-00:00` means always-on; a real window outside *now* is the hard off switch. |

> **Never** — touch ports **4820/4821** (your live instance), run `pkill tsx` (kills
> the live agent too), or timewarp `~/.botty/data/botty.db`. Kill only by port, only
> the listener: `lsof -ti tcp:6820 -sTCP:LISTEN | xargs kill` — or just use
> `npm run sandbox stop`.
