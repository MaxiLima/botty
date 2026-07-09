# botty — Backlog

Prioritized pending work as of 2026-07-07 (v1 complete: sim-mode end-to-end, chat with
images/quoting, proactive loop, working-hours hard gate, Botty-branded notifications).

- ~~Audit sweep + gap closure~~ **shipped 2026-07-07**: 40-issue audit sweep landed —
  security guards (`server/guards.ts`), WS crash-resilience, funnel ERROR-retry
  (`MAX_EXTRACTION_ATTEMPTS=3`), FTS migration 003, web ErrorBoundary, dependency bumps
  (vite 8, vitest 4, express 5, better-sqlite3 12), ~50 new tests. Alongside it: task
  priority convention unified to 1=HIGH..3=LOW across agent/web/tui, funnel outcome is now
  a real field on `/api/raw-log`, repo `CLAUDE.md`, GitHub Actions CI, docs synced to code
  plus new tui/memory spec chapters, and three new skills (sim-scenarios, judgment-replay,
  ship).

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

1. **Chat tools — finish `capture_task` + a minimal action set.** Chat runs with
   `tools: []` (`llm/sdk.ts`); the spec'd `capture_task` (specs/ingestion.md) was never
   built, so the assistant can read context but cannot act. Start with four tools:
   `capture_task`, `task_action` (done/snooze/priority), `memory_search` (FTS already
   exists), and `session_search` (Hermes pattern: zero-LLM FTS over `chat_turns` with
   discovery/scroll/browse modes — no embeddings needed). The `chat.toolUse` WS plumbing
   already exists end-to-end in both UIs. Prerequisite for #3.
2. **Inferred commitments** (OpenClaw). Hidden post-turn extraction pass detects short-lived
   follow-ups ("interview tomorrow") → stored as operational state (not tasks, not memory)
   → delivered via the existing tick when due. Guardrails from the reference design:
   `maxPerDay` cap (default 3), minimum delay to prevent echo-back right after creation,
   redelivery context explicitly marked untrusted. Maps to a new candidate reason in
   `loop/candidates.ts` + one table + one funnel-style extraction prompt.
3. **Consent-first automation suggestions** (Hermes — their best proactive-UX idea). The
   agent never auto-creates automations; it registers *suggestions* (hard cap 5 pending;
   dismiss latches forever by dedup key) the user accepts with one tap. Sources: recurring
   asks noticed in chat, catalog starters. In botty: a suggestion card in the nudge UI
   proposing heartbeat.md edits or recurring checklist tasks (#4).
4. **Structured heartbeat checklist tasks + zero-cost skip** (OpenClaw, plus Hermes's
   `[SILENT]` sentinel). Optional `tasks:` block in heartbeat.md with per-task `interval` +
   `prompt`, tracked independently; a tick with no due checklist tasks and no candidates
   skips the judgment LLM call entirely. Judgment already implements the skip-biased
   speak/stay-silent contract — this adds the user-programmable side and a zero cost floor.
5. **Session-summary memory promotion ("dreaming lite")** (OpenClaw dreaming + Hermes
   curator). Nothing curates memory today (FTS recall over raw records + last-3 seal
   summaries). Weekly job reviews sealed summaries + resolved tasks, proposes durable facts
   into a hot-reloaded `memory.md` config file — **staged for user approval** (Hermes's
   staged-writes valve), never auto-written. Retrieval-frequency scoring can come later.
6. **Small loop-robustness guards** (Hermes): empty-response recovery (one synthetic nudge
   retry instead of ending the turn); audit fail-open semantics on judgment/resolution
   failure paths the way the funnel already degrades classifier failure to extraction.

### Config improvements

- **Promote stranded knobs into heartbeat.md.** `surfaceCooldownHours`, `maxSnoozesPerTick`,
  `responseWindowHours`, `chatActiveGateMin`, `sessionIdleSealMin`, `meetingPrepLeadMin`,
  resolution-sweep limits already sit in `HEARTBEAT_DEFAULTS` (shared/src/constants.ts) but
  the parser never reads them from the file. Same for candidate thresholds (due ≤2d,
  never-surfaced >4h, stale ≥5d) hardcoded in `loop/candidates.ts`.
- **Prompts as hot-reloaded config files.** All five system prompts (judgment, resolution,
  seal-summary, classifier/extractor, briefing) are hardcoded in source. Move to
  `~/.botty/config/prompts/*.md` behind the existing chokidar watcher; the replay CLI is
  the ready-made safety net (edit → replay last N decisions → diff).
- **Cheap-model overrides for housekeeping** (both repos converge on this). `llm.models`
  routing exists but seal summaries/briefings run on sonnet; default housekeeping tasks to
  haiku. Pairs with the P2 "Settings UI for model routing" item.
- **Config fail-fast + last-known-good** (OpenClaw). Parser warnings are currently
  advisory; on invalid heartbeat.md, keep the last-known-good config active and surface a
  visible warning card.
- **Context-budget legibility** (OpenClaw `/context detail`). The memory char budgets
  (8k/3.2k/1.4k in `memory/index.ts`) truncate silently; expose a per-section byte
  breakdown (persona/team/recall/tasks) in the Inspector so a clipped persona.md is visible.

### Deliberately not ported (revisit later)

Skills engine (cut from v1 for good reason; revisit only after chat tools exist),
subagents/multi-agent routing, and the sandboxing stack (becomes relevant the moment chat
tools land — the untrusted-content boundary-marker pattern was applied to the judgment
prompt as part of the 2026-07-09 bug fixes).

## P2 — known seams (from the build, all minor)

- **Settings UI for model routing & pricing**: `llm.models` (task→model) and `llm.pricing`
  (USD/MTok overrides) are settings-only today — editable via `PUT /api/settings`, no UI.
  Both API clients already expose `settings()`/`patchSettings()`; add a "Models" section to
  the web Config page (dropdown per LlmTask + pricing rows) and surface the active routing
  read-only in the TUI. Zero backend changes needed.

- Nudge cards are client-store only — lost on page reload. Add a notification-history read from
  `proactive_log` and interleave into chat history.
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
- Near-duplicate task consolidation (cut from v1).
- WS reconnect has no event replay (client refetches REST state instead — fine, but note it).
- Product look: a once-surfaced task that becomes due within 24–48h cannot resurface through
  the 48h tier-1 cooldown (spec-conformant per specs/loop.md gates 1/2, but arguably a due
  task should pierce the cooldown once).

## P3 — later / ideas

- Settings UI page (model overrides per task exist in the API, no UI).
- Weekend/holiday awareness beyond active_days (holiday calendar).
- Menu-bar presence via a thin Tauri wrapper.
- sqlite-vec embeddings upgrade for recall (FTS5 today).
- Multi-channel surfaces (Telegram) — the notifier/bus design already supports adding channels.
