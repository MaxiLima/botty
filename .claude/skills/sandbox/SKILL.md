---
name: sandbox
description: Boot or drive the persistent manual-testing sandbox (agent :6820 / sim :6821, data in ~/.botty-sandbox) — inject simulated Slack/email/calendar events and observe nudges in the TUI without waiting for time gates. Never touches the live 4820/4821 instances.
---

# botty sandbox

One-shot playground for testing botty like a real user, with time compressed.
Launcher: `scripts/sandbox.ts` (`npm run sandbox`). Full doc: `docs/TESTING.md` §0.

## Port map — memorize before touching anything

| Ports | What | Rules |
|---|---|---|
| **4820 / 4821** | Owner's live dev agent + sim (`~/.botty`) | **NEVER** kill, restart, timewarp, or point tests at |
| **5820 / 5821** | `/verify` ephemeral instances (temp dirs) | per-session, torn down after |
| **6820 / 6821** | Sandbox agent + sim (`~/.botty-sandbox`) | persistent; managed by `npm run sandbox` |

Kill only by port and only the listener: `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill`.
Never `pkill tsx`. Prefer `npm run sandbox stop`, which does exactly that for 6820/6821.

## Commands

```sh
npm run sandbox                      # boot (idempotent) + attach TUI; --no-tui / --mock flags
npm run sandbox inject <template-id> # inject event + force the source poll → agent reacts in seconds
npm run sandbox check [source]       # force poll: slack|gmail|gcal|jira|github (or all)
npm run sandbox tick                 # force a proactive tick (judgment) now
npm run sandbox sweep                # force a resolution sweep now
npm run sandbox warp -- --hours 6    # mock time: stops agent, timewarps sandbox DB, restarts
npm run sandbox status|stop|reset    # health · stop listeners · wipe ~/.botty-sandbox + reseed
```

Ad-hoc/custom events (any sender, thread, direction): browser panel at
<http://localhost:6821>, or `POST :6821/control/inject` (see the `sim-scenarios` skill).

## What's pre-seeded (first boot only; hot-editable afterwards)

- `~/.botty-sandbox/config/heartbeat.md` — fast profile: `tick_interval_min: 1`,
  `never_surfaced_min_age_hours: 0`, `min_gap_between_nudges_min: 0`,
  `chat_active_gate_min: 0`, `working_hours`/`quiet_hours` disabled via `00:00-00:00`,
  `surface_cooldown_hours: 1/2/4` (nonzero on purpose — use `warp` to skip a cooldown).
- `~/.botty-sandbox/config/team.md` — fixture people (all `.example`): Marian/Sofi
  CRITICAL, Diego/Caro/Fer HIGH, **Rodrigo NORMAL (Tier-2 on purpose — his messages
  must never become tasks)**.
- Sim scenario `sandbox` (`packages/sim/scenarios/sandbox.json`): empty timeline +
  extra templates merged over the defaults.

Template ids: `slack-dm-urgent`, `slack-outbound-done`, `slack-dm-social`,
`gmail-urgent`, `gmail-meeting-notes`, `gcal-soon`, `gcal-invite-soon`,
`gcal-invite-tomorrow`, `slack-thread-ask`, `slack-thread-self-reply`,
`slack-tier2-noise`, `jira-assigned`, `github-pr`.

## Behavior notes

- **Real LLM by default** (Claude Agent SDK ambient creds — the owner's Claude Code
  login). Judgment is nondeterministic and biased toward silence; the TUI
  `/inspector` (or web Inspector) shows every tick's reasoning. `--mock` is free and
  instant but judgment always returns skip — tasks get captured, nudges never fire.
- `inject` = sim `/control/inject` + agent `check-now`, so funnel results are
  visible in seconds; nudges follow within ~1–2 min (tick=1) or `sandbox tick`.
- `warp` restarts the agent (WAL lock + in-memory timers) — an attached TUI loses
  its WS; relaunch with `npx tsx packages/tui/src/index.tsx --port 6820`.
- Sandbox processes run `start` (no watch): code changes need `stop` + `start`.
- Re-injecting a template mints a fresh externalId → may create a sibling task.
  `reset` is cheap.

## Driving the TUI from a Claude session

Same recipe as the `verify` skill, port 6820:

```sh
tmux -L sbx new-session -d -x 100 -y 30 -c <repo> \
  'npx tsx packages/tui/src/index.tsx --port 6820; sleep 120'
```

Send text and Enter as **separate** `send-keys` calls; capture with `capture-pane -p`.
