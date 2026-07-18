# Testing botty's behavior

Recipes for verifying the behaviors that matter, all against the simulator — no real accounts
needed. Setup for every recipe:

```sh
npm run dev:sim                     # terminal 1 — sim on :4821
npm run dev:agent                   # terminal 2 — agent on :4820 (real LLM)
# BOTTY_MOCK_LLM=1 npm run dev:agent   # deterministic LLM stub — free/fast, judgment always skips
```

Tip: for a clean slate, point `BOTTY_DATA_DIR` at a scratch dir (config templates are seeded
automatically): `BOTTY_DATA_DIR=/tmp/botty-test npm run dev:agent`.

The **time machine** is the key tool. Proactive behavior is time-based (min-age gates,
cooldowns, staleness, snooze expiry), so instead of waiting hours, shift the DB's clock:

```sh
npm run timewarp -w @botty/agent -- --hours 6      # "6 hours pass"
npm run timewarp -w @botty/agent -- --days 2
```

(Stop the agent while warping, or expect a brief WAL lock wait. It shifts every timestamp
uniformly, so orderings and relative ages stay consistent.)

---

## 0. Sandbox — one-shot manual playground

Full walkthrough (mental model, inject recipes with expected outcomes, warp table,
troubleshooting): **`docs/E2E-GUIDE.md`**.

For day-to-day-style testing through the TUI without any of the setup below:

```sh
npm run sandbox
```

Boots an isolated sim (**:6821**) + agent (**:6820**, real LLM via your Claude Code
login) against a persistent `~/.botty-sandbox` data dir, loads the `sandbox` scenario
(empty timeline + extra inject templates), and attaches the TUI. First boot seeds a
**fast heartbeat profile** (1-min tick, no min-age, no working/quiet-hours gates,
1/2/4h cooldowns) and a `team.md` with the fixture people — both hot-editable under
`~/.botty-sandbox/config/`.

Inject events from the sim panel at <http://localhost:6821> (Slack DMs from peers,
your own outbound replies, meeting-notes emails, calendar invites…) or via the CLI:

| Command | Effect |
|---|---|
| `npm run sandbox inject <template-id>` | inject a template + force the source poll (instant end-to-end) |
| `npm run sandbox check [source]` | force a poll (all sources or one) |
| `npm run sandbox tick` / `sweep` | force a proactive tick / resolution sweep |
| `npm run sandbox warp -- --hours 6` | timewarp the sandbox DB (auto stop/restart of the agent) |
| `npm run sandbox status` / `stop` / `reset` | health · kill 6820/6821 listeners · wipe + reseed |

Flags: `--no-tui`, `--mock` (free/instant, but judgment always skips — no nudges).
Port map: **4820/4821 live dev (never touch) · 5820/5821 verify-ephemeral · 6820/6821
sandbox-persistent**. The recipes below still apply when you need scripted scenarios
or the live-port setup.

---

## 1. Notifications — "when botty tells me something, I notice"

Every surface goes to three places at once: a `proactive_log` row (audit), an in-chat card with
Done/Snooze/Dismiss (action), and a native macOS banner (attention). See ARCHITECTURE.md §6.

**Channel check (instant):**

```sh
curl -X POST localhost:4820/api/notifications/test
```

Expected: a macOS banner ("botty — Notificación de prueba…") **and** a card in the Chat page.

**If no banner, check in this order** (learned the hard way on macOS 15):

1. **Focus/Concentración** — any active Focus (including one synced from your iPhone) swallows
   banners; notifications land silently in the side panel. Deactivate it, or add the notifier
   app to that Focus's allowed apps.
2. **terminal-notifier authorized** — `brew install terminal-notifier`, then
   `open /opt/homebrew/Cellar/terminal-notifier/*/terminal-notifier.app` once (CLI-only use
   never registers it), then System Settings → Notifications → terminal-notifier → Allow +
   style Banners/Alerts. This is botty's primary delivery path.
3. **Fallback applet** — if terminal-notifier is absent (or fails), botty falls back to its own
   compiled "Botty" identity app at `~/.botty/Botty.app`, launched via `open -a` (a raw-executable
   invocation delivers nothing on macOS 15) — see `loop/notify-macos.ts:30,48`. Build it once:

```sh
npm run setup:notifier -w @botty/agent
```

This `osacompile`s `~/.botty/Botty.app` (bundle id `io.maxolabs.botty`), ad-hoc codesigns it, and
launches it once so it registers with Notification Center. Accept the permission prompt (or enable
**Botty** in System Settings → Notifications, style Banners/Alerts). With both installed,
terminal-notifier sends banners *as* "Botty" (`-sender io.maxolabs.botty`) once the identity app is
authorized; the fallback chain is terminal-notifier → the Botty applet → plain `osascript`.

**Real end-to-end nudge:**

1. Sim panel (`:4821`): load `workweek`, Advance **120** min.
2. App → Inspector → Sources → check-now on slack/gmail/jira/github → tasks appear.
3. Stop the agent; `npm run timewarp -w @botty/agent -- --hours 6`; restart. (Fresh tasks are
   deliberately not surfaced for 4h — the NEVER_SURFACED min-age gate.)
4. **Don't touch the chat for 2+ minutes** (gate 7 suppresses nudges while you're actively
   chatting — by design), then Inspector → Ticks → *Run tick now*.
5. Expected: macOS banner + chat card for the highest-value task(s), score ≥ 7. In
   Inspector → Ticks you can read the judgment's reasoning for every candidate; the surface is
   in `proactive_log` (Tasks → detail → surfaces).

**Briefings:** set `morning_at` in `~/.botty/config/heartbeat.md` to 2 minutes from now (hot
reload picks it up) — you'll get a morning-brief notification with the digest.

---

## 2. Proactiveness — "does it remember what I should be doing?"

The memory chain is: signal → task (funnel) → candidate (age/due gates) → judgment → nudge.
Test each link:

1. Load `workweek`, advance 120 min, check-now all sources.
2. **It captured the commitments:** Tasks page should include Marian's PR review, Sofi's
   rollback plan, Diego's blocked creds, plus jira/github items. In Inspector → Funnel, the
   originating Slack messages show outcome `EXTRACTED` with the extractor's exact output.
3. **It remembers in conversation:** ask in chat *"qué tengo pendiente hoy?"* — the answer must
   reference those concrete tasks (chat context includes open tasks + FTS recall).
4. **It reminds unprompted:** timewarp `--hours 6`, run a tick (after 2 min of chat silence) →
   nudge for the most urgent item. Timewarp `--days 6` and tick again → the untouched tasks now
   also carry the `STALE` reason (visible in the tick's candidate list).
5. **Inject something new live:** sim panel → Inject → "urgent DM from Marian" template → within
   one poll cycle (≤60s in sim mode) it's a task; it becomes nudge-eligible once past the
   min-age gate (or immediately after a timewarp).

Judgment quality tuning: `npm run replay -w @botty/agent -- --kind judgment --last 20` re-runs
recorded judgments (optionally with `--system-file` / `--model` overrides) and diffs decisions.

## 3. Anti-nagging — "it must NOT ping me every minute about the same thing"

The nine-gate rules filter runs before any LLM call, and every rejection is logged with its gate
name. The test is: force repeated ticks and watch it refuse.

1. Right after a successful nudge (recipe above), immediately *Run tick now* **5 times**.
2. Expected: **zero** new notifications. Inspector → Ticks shows each tick with
   `candidatesIn > 0, afterRules = 0` and the rejection log naming the gates:
   `min_gap` (30-min global gap), `cooldown` (that task surfaced recently), `hourly_cap`
   (max 2/hour). No judgment LLM call is even made (`judgmentDecision: none`) — silence is free.
3. **Surfaced tasks drop out entirely:** after a nudge, that task isn't even a *candidate*
   anymore (it's no longer NEVER_SURFACED, not yet STALE) — the strongest form of not-bothering.
   It re-enters only when due within 2 days or stale (5+ days). Verify: timewarp `--days 6` →
   tick → the task reappears in the candidate list as `STALE` (cooldown long expired), and if
   judgment notifies it again, its `surface_count` climbs — the cooldown gate then demands 96h,
   then 7d, and after the 3rd surface the hard cap silences it forever unless a due date < 48h
   pulls it back. For tasks *with* due dates (DUE_SOON re-entry within 48h of a surface), the
   `cooldown` gate shows up by name in the tick's rejection log.
4. **Your responses stick:** click *Dismiss* with a reason on a nudge card, timewarp `--days 2`,
   tick → judgment sees the dismissal in the response history and skips it (its reasoning in
   Inspector → Ticks will say so). Snooze does the same via a hard gate until `snooze_until`.
5. **Chat suppression:** send any chat message, then run a tick within 2 minutes →
   all candidates rejected with gate `user_active`.

What "good" looks like across a simulated day: a handful of task extractions, 1–2 nudges at
sensible moments, briefings at 08:45/18:00, and dozens of ticks that chose silence — each with
an inspectable reason.

**Working hours — the hard off switch:** set `working_hours` in
`~/.botty/config/heartbeat.md` (`## Schedule`) to a window that excludes right now, e.g.
`working_hours: 03:00-04:00` (hot reload picks it up) — everything goes silent: no source
polls (no new `source_check_log` rows in Inspector → Sources), no scheduled ticks (at most a
single `off_hours` row in Inspector → Ticks when the off window is entered), no briefings, and
therefore zero LLM calls / token usage. Manual actions still work — *Run tick now* and
per-source *check now* bypass the gate. Restore `working_hours: 08:00-19:00` (or delete the
line for the default) and polling/ticking resumes on the next cycle. This is stronger than
`quiet_hours`, which only stops surfacing while polling/ticking continues.

## 4. Unit / integration suites

```sh
npm test                 # all workspaces: funnel paths, all 9 gates, judgment validation,
                         # parsers, repos, API routes, WS, scenario engine, TUI
npm run typecheck        # cross-package contract enforcement via @botty/shared
```
