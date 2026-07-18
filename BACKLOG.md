# botty — Backlog

Prioritized pending work as of 2026-07-09 (v1 complete: sim-mode end-to-end, chat with
images/quoting, proactive loop, working-hours hard gate, Botty-branded notifications;
2026-07-09: chat tools + external MCP consent gate, inferred commitments, heartbeat
checklist tasks, config knob promotion + last-known-good, loop guards — see the ports
section below).

- ~~Audit sweep + gap closure~~ **shipped 2026-07-07**: 40-issue audit sweep landed —
  security guards (`server/guards.ts`), WS crash-resilience, funnel ERROR-retry
  (`MAX_EXTRACTION_ATTEMPTS=3`), FTS migration 003, web ErrorBoundary, dependency bumps
  (vite 8, vitest 4, express 5, better-sqlite3 12), ~50 new tests. Alongside it: task
  priority convention unified to 1=HIGH..3=LOW across agent/web/tui, funnel outcome is now
  a real field on `/api/raw-log`, repo `CLAUDE.md`, GitHub Actions CI, docs synced to code
  plus new tui/memory spec chapters, and three new skills (sim-scenarios, judgment-replay,
  ship).
- ~~Task ownership inversion~~ **shipped 2026-07-09**: extraction now tags each task
  `owner: 'me' | 'them'` (migration 006) — a Tier-1 person's own stated commitment ("I'll
  send you X tomorrow") is tagged 'them' (a "waiting on" reminder, not a to-do for the
  user) instead of becoming a P1 task owned by the user. `owner='them'` tasks default to
  P2 (not P1), are marked "waiting on `<requester>`" in chat/judgment context and the
  web/TUI task views, and JUDGMENT_SYSTEM phrases their nudges as follow-ups ("Diego
  promised the latency doc — ping him?") rather than instructions to the user. Live repro:
  Diego's DM wrongly created "Send latency doc" owned by the user; now correctly tagged
  `owner='them'`. **Flag for judgment-replay**: JUDGMENT_SYSTEM picked up a new bullet —
  replay before shipping.
- ~~Inspection sweep + fix wave~~ **shipped 2026-07-11**: 26 findings from the
  2026-07-10 four-angle inspection (security / agent-core / clients / DX) fixed in one
  orchestrated pass. Highlights: pending-action approve/dismiss race closed with a
  synchronous in-flight claim (concurrent approves → exactly one execution); REST
  middleware now rejects non-local `Origin` (closes the no-body-POST CSRF token-burn
  vector); `PUT /api/settings` allowlisted to `llm.models`/`llm.pricing`; briefing
  prompt gained the untrusted-content markers (the last unguarded LLM surface);
  stale-commitment expiry moved after delivery so weekend-due commitments survive to
  Monday's first tick; bare-number tokens (years/times) no longer count as distinctive
  dedup identifiers; HH:MM range validation with warnings + last-known-good (and
  `msUntilNextTime` no longer arms midnight timers on garbage); composite
  `(created_at, id)` pagination cursors for chat history and decisions; web
  multi-client fix (TUI-sent user turns now appear via adopt→tail-refetch),
  approval-card/open-count reconnect races, drawer cancellation, Enter double-POST;
  TUI per-endpoint boot degradation; sim panel inject-form fixes (placeholder no-op,
  single-shot template extras, displayName carried). Docs synced (api.md,
  data-model.md, new specs/mcp.md, commitments/chat-tools sections, TESTING.md
  notifier → `setup:notifier`, README prerequisites/env-table/real-mode caveat);
  tooling: root `timewarp`/`replay`/`setup` scripts, `.nvmrc` + CI pin,
  `.editorconfig`, timewarp + db-migration skills. Verified e2e on the isolated
  5820/5821 instance (origin guard, allowlist, funnel+dedup, tick, pagination,
  TUI boot, cross-client chat via puppeteer, sim panel). Deliberately deferred:
  LICENSE choice and lint/formatter (Biome) adoption — both owner decisions.
- ~~Manual-testing sandbox~~ **shipped 2026-07-14**: `npm run sandbox` — persistent
  playground on **6820/6821** (`~/.botty-sandbox`, `BOTTY_SANDBOX_DIR` override) for
  day-to-day-style TUI testing with time compressed. Zero `packages/*` source changes:
  `scripts/sandbox.ts` (start/stop/reset/warp/inject/check/tick/sweep/status) seeds a
  fast heartbeat profile (1-min tick, zero min-age/min-gap, working/quiet hours
  disabled via degenerate `00:00-00:00` windows, cooldowns 1/2/4h kept nonzero so
  anti-nag stays observable) plus fixture `team.md` (Rodrigo NORMAL on purpose — tier
  gate testable); new `packages/sim/scenarios/sandbox.json` (empty timeline + inject
  templates: meeting-notes email, calendar invites, thread ask + outbound self-reply
  pair, Tier-2 noise); `inject` pairs sim `/control/inject` with agent `check-now` for
  seconds-level end-to-end; `warp` wraps timewarp with the agent stop/restart dance.
  Real LLM by default (`--mock` opt-in — mock judgment always skips, no nudges). Docs:
  TESTING.md §0, README, `.claude/skills/sandbox/`. Known seam: the mock classifier
  reads only the first `TEXT:` line, so multi-line email fixtures need a signal phrase
  in the Subject to extract under mock.
- **Findings — 2026-07-18 sandbox dogfooding** (12-round injected-traffic session, real
  LLM, ~2h autonomous; sweeper/judgment behavior validated end to end — 11 correct
  auto-closes incl. requester-cancel, them-owned delivery, structured PR-merge/Jira-Done,
  and correct refusals on a follow-up ping and vague praise; tier gate, classifier
  noise, dedup, decisions, owner inversion, briefing all passed):
  1. **Nudge cards are never replayed** — web/TUI notification stores are fed only by
     the live WS `notification` event (`web/src/lib/stores.ts:159`), never hydrated
     from `proactive_log` on connect. A nudge fired while no client is attached shows
     as a macOS banner but never appears in any chat surface afterwards (only the
     Inspector). Hit in practice on the first day of sandbox use.
  2. **Same-thread follow-up spawns a sibling task** — Marian pinging "any update?" in
     an existing ask's thread created a second task (`T-BOARD-1#2`) for the same
     deliverable instead of attaching to the original; extraction-level near-dup
     consolidation missed it (same person, same thread). Also seen cross-person
     (Sofi's R-77 email vs Caro's meeting-notes action item → judgment snoozed the
     dup, which masks rather than merges).
  3. **Gmail tasks without a thread ref can never auto-resolve** — the requester's own
     cancellation email ("no need, tema cerrado") dies at the heuristic gate as an
     unlinked event and the sweep skips the task as `no_thread`/unlinked forever.
     Contract for the M4 real Gmail driver (extends the existing outbound-direction
     note): **must emit Gmail thread IDs as `threadRef`**, or email-resolved tasks rot
     open. Same applies to any source whose fixtures omit threadRef.
  4. **Sweep watermark `<=` edge (real-mode, low prio)** — `resolution-sweep.ts` skips
     when `newest evidence occurredAt <= last-checked evidenceTs`; same-timestamp
     evidence batches (bulk imports, coarse timestamps) can strand a task after one
     `resolved:false` check. In the sandbox this was catastrophic-looking (paused sim
     clock froze occurredAt for every inject → any second check impossible; both
     "stranded" tasks healed instantly once the clock played) — launcher now keeps the
     scenario clock playing at speed 1, and inject-while-paused is a sim footgun worth
     an engine-level fix (default ad-hoc inject occurredAt to wall-now when paused).
  5. Minor observations: prep tasks for already-past meetings stay open (board
     clutter); judgment silently snoozes already-missed deadlines (offsite confirm
     due EOD → snoozed to next morning) instead of flagging the miss.
  Sandbox launcher fixes applied during the session (in `scripts/sandbox.ts`,
  uncommitted): strip leaked Claude-session env (`CLAUDECODE*`, scoped
  `ANTHROPIC_API_KEY`) so SDK auth falls back to the user login, and auto-play the
  scenario clock at 1:1 on start.

## P0 — becoming the daily driver

1. **Real source drivers (M4).** Swap sim adapters for real ones behind the same
   `SourceAdapter.fetch()` contract: claude.ai MCP connectors (Slack, Gmail, Google Calendar)
   via the Agent SDK; Jira/GitHub via REST/CLI. **Start with a spike**: verify the Agent SDK can
   reach claude.ai MCP connectors from a headless daemon session — this decides the design.
   Everything downstream (raw log, dedup, funnel) is mode-agnostic and stays as is.
2. **Run as a service.** launchd agents for botty (and optionally the sim in dev): start at
   login, restart on crash, logs to `~/.botty/logs/`. Today it's two hand-started processes.
3. **Nightly backups.** `VACUUM INTO ~/.botty/backups/botty-<ts>.db`, keep 14. The DB is about
   to hold real data.
4. **Remaining M4 intelligence:** cadence drift (CRITICAL person gone quiet vs declared
   cadence), urgent-inbound trigger (immediate tick on high-confidence Tier-1 DM).
5. ~~Onboarding wizard~~ **shipped 2026-07-18** (`docs/specs/onboarding.md`, spec updated
   to as-built): guided first-run setup in both web (`/onboarding` + first-run banner) and
   TUI (`/onboarding` wizard mode), re-runnable with prefill. `config/render.ts` renderer
   (round-trip tested), `GET /api/onboarding` + preview/apply/mcp-probe endpoints,
   `onboarding.completedAt` settings key, `onboarded` on `/api/health`, archive-on-save
   extended to mcp.json.
   - ~~Resolution sweep~~ **shipped 2026-07-04** (`loop/resolution-sweep.ts`, specs/loop.md):
     auto-closes slack/gmail tasks from thread evidence — including the user's own outbound
     replies ("review done"), ingested via the new `direction` field on SourceEvent. Note for
     the M4 real drivers: the Slack/Gmail `fetch()` must emit the user's own sent messages as
     `direction: 'outbound'` events, or the sweep loses its best signal.

## P1 — tests

- **Automated e2e** (`npm run e2e`): script the manual flow — start sim+agent (mock LLM, temp
  data dir), load workweek, advance, check sources, assert funnel outcome counts, task count,
  timewarp, tick, assert nudge + gates. This is the regression net.
- **Web tests**: one logic test exists now (markdown rendering); the original targets — WS
  store (reconnect/refetch), chat state reducers, the nudge action row — still need coverage.
  Prerequisite: a jsdom/RTL harness in `@botty/web` (vitest jsdom environment +
  Testing Library), which doesn't exist yet.
- **Integration-harness primitive**: a reusable spawn-sim+agent-on-a-temp-data-dir helper
  (port allocation, mock LLM, teardown). This is the real cost hiding inside the e2e item —
  build it once and both `npm run e2e` and future integration tests get cheap.
- **threadEvents overflow/origin-swap test**: the overflow/origin-swap branch in
  `db/index.ts` is untested — add a targeted test.
- **Judgment evals**: after ~1 week of real traffic, curate `ai_decisions` judgment rows into a
  pinned eval set; run the replay harness against prompt changes (`--system-file`) before
  shipping them.

## Ports from the 2026-07-09 investigation (Hermes Agent & OpenClaw)

Feature/design ports identified by comparing botty against NousResearch's hermes-agent and
openclaw/openclaw. Ranked by value × fit. The bugs found in the same investigation were
fixed directly (see git history around 2026-07-09).

### Features

1. ~~**Chat tools — finish `capture_task` + a minimal action set.**~~ **shipped 2026-07-09**:
   four tools live in chat — `capture_task`, `task_action` (done/snooze/dismiss/reopen/
   priority), `memory_search`, `session_search` (search/recent/browse over past sessions,
   zero-LLM FTS). Registry in `chat/tools.ts` (never-throwing handlers, `{error}` results);
   SDK wiring via `tool()` + `createSdkMcpServer()` in-process (`llm/sdk.ts`, built-ins stay
   disabled); mock LLM gained a deterministic `!tool <name> <json>` trigger for e2e; task ids
   now ride the chat system prompt so `task_action` is usable. Alongside: **external MCP
   tools with a consent gate** (not originally backlogged) — `~/.botty/config/mcp.json`
   (hot-reloaded, last-known-good) declares stdio servers with a default-deny per-tool
   allowlist `read|action`; `read` executes mid-turn through the agent's own MCP client
   (`mcp/connections.ts`), `action` only enqueues into `pending_actions` (migration 005;
   cap 10, dedup, 24h TTL) and executes solely via `POST /api/actions/:id/approve` —
   approval cards in the web chat thread, read-only lines + count in the TUI. claude.ai
   connectors remain out of reach (that's still the P0 #1 Agent SDK spike).
2. ~~**Inferred commitments** (OpenClaw).~~ **shipped 2026-07-09**: hidden post-turn
   extraction (`chat/commitments.ts`, deferred via the turn queue, haiku) → `commitments`
   table (migration 004) → tick delivery (`loop/commitments.ts`) with all reference
   guardrails: `commitments_max_per_day` (3), `commitment_min_age_min` echo-back guard (30),
   24h stale expiry, and descriptions wrapped in the untrusted-content boundary markers in
   the judgment prompt. `infer_commitments: off` in heartbeat.md disables the pass.
3. **Consent-first automation suggestions** (Hermes — their best proactive-UX idea). The
   agent never auto-creates automations; it registers *suggestions* (hard cap 5 pending;
   dismiss latches forever by dedup key) the user accepts with one tap. Sources: recurring
   asks noticed in chat, catalog starters. In botty: a suggestion card in the nudge UI
   proposing heartbeat.md edits or recurring checklist tasks (#4). **Now unblocked** (chat
   tools exist, and the pending-actions approval-card pattern is a ready-made UI shape).
4. ~~**Structured heartbeat checklist tasks + zero-cost skip**~~ **shipped 2026-07-09**:
   `## Tasks` section in heartbeat.md (`- every <N><m|h|d>: <instruction>`) → interval-
   tracked items (state in settings, no migration) that ride judgment as trusted entries,
   notify-only, exempt from score threshold/notify cap; `lastRunAt` advances only on
   successful judgment. Zero-cost floor: a tick with no survivors, no due checklist items,
   and no due commitments returns before any LLM call.
5. **Session-summary memory promotion ("dreaming lite")** (OpenClaw dreaming + Hermes
   curator). Nothing curates memory today (FTS recall over raw records + last-3 seal
   summaries). Weekly job reviews sealed summaries + resolved tasks, proposes durable facts
   into a hot-reloaded `memory.md` config file — **staged for user approval** (Hermes's
   staged-writes valve), never auto-written. Retrieval-frequency scoring can come later.
6. ~~**Small loop-robustness guards** (Hermes)~~ **shipped 2026-07-09**: empty chat response
   retries once with a synthetic continuation nudge (`EMPTY_RESPONSE_NUDGE`, sdk.ts); a
   failed judgment retries once then degrades to a clean "judgment_error → no actions" tick
   (bookkeeping intact, checklist items left due for retry) instead of failing the tick.

### Config improvements

- ~~**Promote stranded knobs into heartbeat.md.**~~ **shipped 2026-07-09**: all nine
  stranded `HEARTBEAT_DEFAULTS` knobs plus the three candidate thresholds
  (`due_soon_days`, `never_surfaced_min_age_hours`, `stale_after_days`) are parsed from
  `## Behavior` and wired to their consumers (candidates, rules-filter, resolution sweep,
  response tracker, chat idle-seal, judgment snooze cap); documented in the config
  template with a template-parses-clean guard test. One seam: the duplicate meeting-prep
  query in `ingest/structured.ts` still reads the default lead min (the live loop path is
  config-wired) — converge with the existing P2 dedup item.
- **Prompts as hot-reloaded config files.** All five system prompts (judgment, resolution,
  seal-summary, classifier/extractor, briefing) are hardcoded in source. Move to
  `~/.botty/config/prompts/*.md` behind the existing chokidar watcher; the replay CLI is
  the ready-made safety net (edit → replay last N decisions → diff).
- ~~**Cheap-model overrides for housekeeping**~~ **shipped 2026-07-09** for seal summaries:
  new `'seal'` LlmTask defaulting to haiku (`summarizeSession` no longer burns sonnet);
  costs/replay/Inspector know the kind. Morning/evening briefings deliberately stay on
  sonnet (user-facing) — still overridable via `llm.models`.
- ~~**Config fail-fast + last-known-good** (OpenClaw).~~ **shipped 2026-07-09** for
  heartbeat.md and mcp.json: a warning-producing hot reload keeps serving the
  last-known-good config; warnings ride the `config.changed` WS broadcast and
  `issues.{heartbeat,mcp}` in `GET /api/config`. Remaining seam: the web Config page
  doesn't render `issues.*` as a persistent warning card yet (save-time warnings show
  inline as before).
- **Context-budget legibility** (OpenClaw `/context detail`). The memory char budgets
  (8k/3.2k/1.4k in `memory/index.ts`) truncate silently; expose a per-section byte
  breakdown (persona/team/recall/tasks) in the Inspector so a clipped persona.md is visible.

### Deliberately not ported (revisit later)

Skills engine (chat tools now exist, so this is revisitable), subagents/multi-agent
routing, and the sandboxing stack. On sandboxing: chat tools landed 2026-07-09 with the
first layer in place — built-in SDK tools stay disabled, external MCP tools are
default-deny allowlisted, outward-facing (`action`) tools are structurally consent-gated
behind user approval, and commitment redelivery text rides inside the untrusted-content
boundary markers. A fuller sandbox story is still open if/when tools grow beyond this.

## P2 — known seams (from the build, all minor)

- **Settings UI for model routing & pricing**: `llm.models` (task→model) and `llm.pricing`
  (USD/MTok overrides) are settings-only today — editable via `PUT /api/settings`, no UI.
  Both API clients already expose `settings()`/`patchSettings()`; add a "Models" section to
  the web Config page (dropdown per LlmTask + pricing rows) and surface the active routing
  read-only in the TUI. Zero backend changes needed.

- Nudge cards are client-store only — lost on page reload. Add a notification-history read from
  `proactive_log` and interleave into chat history. (Approval cards partially share this:
  resolved ones persist in `pending_actions` but the web store only hydrates `pending` on
  load, so resolved cards vanish on reload too.)
- **mcp.json has no UI**: hand-edit only (hot reload + `issues.mcp` catch mistakes). A
  Config-page editor with the same validate-on-save flow as the markdown files would fit.
- **No MCP server status visibility** (2026-07-18): nothing in the web UI or TUI shows
  whether a configured MCP server is actually reachable, what tools its `tools/list`
  advertised vs what the allowlist names (a typo'd tool name silently degrades to the
  generic-description fallback), or when the last successful `tools/list` fetch happened —
  today the only signal is digging through chat-turn tool errors. Add a status surface
  (Inspector tab or Config-page section, plus TUI panel): per server — reachable?, last
  probe time/error, advertised tools with allowlisted/unlisted markers. The
  `POST /api/onboarding/mcp-probe` endpoint from `docs/specs/onboarding.md` step 5 is the
  same probe — build it once and reuse it here.
- **JSON-Schema→zod converter is best-effort** (`mcp/schema.ts`): flat schemas convert
  fully; nested/exotic constructs degrade to permissive `z.unknown()` with the raw schema
  embedded in the tool description. Tighten per-construct as real MCP servers surface gaps.
- **Judgment-replay pending**: the judgment prompt gained checklist/commitment context
  blocks on 2026-07-09 (on top of the earlier injection-guard change) — curate and replay
  recorded judgment decisions before trusting proactive behavior on real traffic.
  **Partially covered 2026-07-09 (fix sweep)**: the hourly-budget + waiting-on prompt
  changes were replayed against 12 live-DB rows (all skip-days) + 3 notify-bearing rows
  from the dogfooding DB — zero behavioral drift (only reason-wording noise). The curated
  eval set over a busier mix is still worth building. **New flag 2026-07-11**:
  BRIEFING_SYSTEM changed (untrusted-content markers + treat-as-data guard) — replay
  recorded briefing decisions before trusting the next morning/evening brief.
- ~~**Usage panel**: tokens/latency per call are already in `ai_decisions`; surface daily totals
  per task-kind in the UI (pairs with the working-hours token-saving goal).~~ **shipped
  2026-07-08** as the Costs report: `GET /api/costs` prices the `ai_decisions` rollup at
  API list rates (overridable via the `llm.pricing` setting), split by activity
  (chat/intake/proactive/resolution/briefing) and model over today/7d/30d/all-time windows;
  web **Costs** page (stat tiles, 30-day stacked daily chart, breakdown tables) and TUI
  `/costs` panel.
- ~~Funnel outcome is parsed client-side from `raw_log.body`; the `/api/raw-log` response should
  carry it as a field.~~ **shipped 2026-07-07**: `outcome` is a typed field on RawLog rows
  (json_extract in `Db.listRawLog`); the Inspector reads it directly.
- Startup fail-fast when `BOTTY_MODE=real`: `createRealAdapterStub` currently throws
  per-fetch on every tick — refuse to start (or fail loudly at boot) until the real drivers
  land, instead of erroring quietly forever.
- Attachments retention: `~/.botty/attachments/` grows forever; add a sweep (e.g. delete files
  not referenced by chat_turns older than 90d).
- Animated GIFs become static when downscaled client-side (canvas limitation).
- Quoting a nudge uses the text-preview fallback (nudges have no chat-turn id).
- Meeting-prep calendar query duplicated in `loop/candidates.ts` and ingest — converge.
- ~~Near-duplicate task consolidation~~ **shipped 2026-07-09**: cross-source dedup
  (`ingest/dedup.ts`) — a candidate task matching an already-open task from a DIFFERENT
  source (shared PR/issue id + word overlap, or high word overlap alone) is recorded as
  a `DEDUPED` funnel outcome instead of a second task. Guards BOTH creation paths: the
  extraction funnel (`funnel.ts` persistExtraction) and the structured jira/github path
  (`structured.ts` handleTaskSource new-task branch — the slack-first/github-second live
  repro order). Same-source repeats are still the ref-suffix mechanism's job. Known v1
  trade-off: when a structured event dedups, that github/jira ref gets no task row, so
  upstream auto-close won't attach to the surviving task. Landed alongside the
  task-ownership fix below (both from the 2026-07-09 live-testing sweep).
- WS reconnect has no event replay (client refetches REST state instead — fine, but note it).
- Product look: a once-surfaced task that becomes due within 24–48h cannot resurface through
  the 48h tier-1 cooldown (spec-conformant per specs/loop.md gates 1/2, but arguably a due
  task should pierce the cooldown once).

## Deferred from the 2026-07-09 TUI dogfooding report

Findings from the first-time-user test session that are feature/design decisions rather
than fixes (the fixable findings were addressed in the same-day fix sweep):

- **TUI write actions (M9)**: the TUI is read-only beyond chat — no check-now, no MCP
  action approval (view-only count), no direct task actions. Chat covers most task ops;
  decide whether the TUI should get `/check <source>` and an approve/deny prompt for
  pending actions, or stay deliberately thin.
- **On-demand brief (L5)**: judgment constantly defers items "to the morning brief", but
  there's no `/brief` command or `POST /api/brief/preview` to see it now. The brief is the
  product's centerpiece and it's unviewable on demand.
- **Judgment consistency (L6)**: score-borderline items can flip between skip and notify
  across nearby ticks (observed: "better in tomorrow's brief" → notify, same evening). A
  small "recently decided" memory fed into the judgment prompt would damp oscillation.

## P3 — later / ideas

- Settings UI page (model overrides per task exist in the API, no UI).
- Weekend/holiday awareness beyond active_days (holiday calendar).
- Menu-bar presence via a thin Tauri wrapper.
- sqlite-vec embeddings upgrade for recall (FTS5 today).
- Multi-channel surfaces (Telegram) — the notifier/bus design already supports adding channels.
