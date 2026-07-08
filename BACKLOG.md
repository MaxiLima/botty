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

## P2 — known seams (from the build, all minor)

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

## P3 — later / ideas

- Settings UI page (model overrides per task exist in the API, no UI).
- Weekend/holiday awareness beyond active_days (holiday calendar).
- Menu-bar presence via a thin Tauri wrapper.
- sqlite-vec embeddings upgrade for recall (FTS5 today).
- Multi-channel surfaces (Telegram) — the notifier/bus design already supports adding channels.
