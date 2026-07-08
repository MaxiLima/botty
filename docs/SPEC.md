# botty — Technical Specification (v2)

> Ground-up rebuild of the "botito" concept (see `docs/botito-spec.md` for the predecessor).
> This document is the master spec; detailed subsystem specs live in `docs/specs/`.
> Authored 2026-07-04.

## 1. What botty is

botty is a **personal, proactive AI assistant** that runs locally on the user's Mac. It watches
work signals — Slack DMs/mentions, calendar events, email, Jira, GitHub — turns the ones that
matter into tracked tasks, remembers people/projects/decisions across sessions, and surfaces the
right thing at the right moment without nagging.

It is not a general chatbot, not a search engine, not a Jira replacement. Single user, single
machine, local-first.

### Lessons from botito (why v2 exists)

The predecessor failed on three fronts, and every v2 design decision traces to one of them:

1. **Bad ingestion** — sources were read by an LLM via MCP; the data foundation was
   probabilistic and undebuggable. → v2: **deterministic ingestion**. Fetching is dumb code
   behind a `SourceAdapter` interface; the LLM only classifies/extracts.
2. **Bad judgment/nagging** — the proactive brain couldn't be inspected or tuned. → v2: **every
   AI decision is recorded with its full inputs** (`ai_decisions` table) and **replayable**
   (change a prompt, re-run the last N real decisions, diff the outcomes).
3. **Never converged** — two languages, hand-rolled IPC, speculative subsystems. → v2: **one
   TypeScript process**, milestones that are each independently useful, and hard scope cuts.

## 2. Product principles (unchanged from botito, kept)

1. **Proactive without nagging.** Two-layer judgment (deterministic rules filter → skip-biased
   LLM judge), cooldown escalation, surface caps, quiet hours, digest-first defaults.
2. **Persistent memory.** Tasks, people, decisions, conversations survive across sessions.
3. **Editable behavior.** Personality/schedule/priorities in plain markdown, hot-reloaded.
4. **Local-first & private.** Everything on the user's machine; LLM calls via the user's own
   Claude subscription (Claude Agent SDK), no cloud relay, no telemetry.
5. **Inspectable.** Every ingestion verdict, extraction, and tick judgment is visible in the
   Inspector UI and replayable from the CLI.

## 3. Architecture

**One Node.js/TypeScript daemon** ("the agent") + a **React web UI** it serves + a separate
**simulator service** for development/testing. npm workspaces monorepo:

```
botty/
├── package.json              # npm workspaces (packages/*), Node >= 22
├── tsconfig.base.json
├── docs/                     # this spec suite
└── packages/
    ├── shared/               # @botty/shared — zod schemas, TS types, constants, SQL migrations,
    │                         #   REST/WS API contract. Every other package depends on it.
    ├── agent/                # @botty/agent — the daemon: db, memory, config, llm, ingest,
    │                         #   loop, HTTP/WS server (serves web/dist)
    ├── web/                  # @botty/web — React + Vite SPA (chat, tasks, people, inspector, config)
    ├── tui/                  # @botty/tui — Ink terminal chat client, peer of the web app
    └── sim/                  # @botty/sim — simulator: fake Slack/Gmail/GCal/Jira/GitHub +
                              #   scenario engine + control panel
```

| Concern | Choice | Rationale |
|---|---|---|
| Language | TypeScript everywhere | One type system end to end; API contract shared as code |
| LLM | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) | Sessions/streaming/tool-use programmatically via the user's Claude Code subscription — no CLI scraping, no API bill |
| Storage | SQLite (`better-sqlite3`, WAL) | Single portable file, ACID, no server |
| Recall | SQLite **FTS5** | Full-text memory search without an embedding dependency; vectors are a later upgrade |
| UI transport | REST + WebSocket (typed via `@botty/shared`) | Replaces botito's 2.6k-line hand-rolled IPC |
| Ingestion | `SourceAdapter` interface; **sim drivers first**, real drivers later | Deterministic, testable; kills the Slack-token blocker |
| Config | 3 markdown files (`persona.md`, `team.md`, `heartbeat.md`), hot-reload | Collapsed from botito's 7 |
| Encryption | None at field level (FileVault covers at-rest) | Cut a large fragile subsystem |

### Runtime topology

```
 ┌─────────────────────────────┐        ┌──────────────────────────┐
 │  @botty/agent  (port 4820)  │  HTTP  │  @botty/sim (port 4821)  │
 │  db · config · llm · loop   │───────▶│  slack/gmail/gcal/jira/  │
 │  ingest · REST+WS server    │ polls  │  github endpoints +      │
 │  serves web/dist            │        │  scenario engine + panel │
 └──────────┬──────────────────┘        └──────────────────────────┘
            │ REST + WS                          ▲ control UI (browser)
            ▼
     Browser: @botty/web SPA          Claude Agent SDK ──▶ user's Claude subscription
```

Data dir: `~/.botty/` → `data/botty.db`, `config/*.md`, `logs/`. Overridable via
`BOTTY_DATA_DIR`. Mode: `BOTTY_MODE=sim|real` selects source drivers; `BOTTY_SIM_URL` defaults
to `http://localhost:4821`.

## 4. Subsystem specs

| Spec | Covers |
|---|---|
| `specs/data-model.md` | Full SQLite DDL, FTS5 setup, migration conventions |
| `specs/llm.md` | `LlmClient` interface, Agent SDK usage, task→model routing, decision recording |
| `specs/ingestion.md` | `SourceAdapter` contract, sim drivers, scheduler, the 5-step funnel, heuristics |
| `specs/loop.md` | Tick flow, rules filter (9 gates), judgment, actions, briefings, response tracker, replay harness |
| `specs/api.md` | REST endpoints + WS event contract between agent and web UI |
| `specs/web-ui.md` | Pages, components, state management |
| `specs/simulator.md` | Sim endpoints, scenario file format, control API + panel, seed scenario |

## 5. Config files

Live in `~/.botty/config/` (templates in `packages/agent/config-templates/`), hot-reloaded with
~500 ms debounce, validated on save, previous version snapshotted to `config/archive/`.

- **`persona.md`** — identity, voice/tone rules, banned phrases, who the user is (role, timezone,
  work style). Injected into chat + judgment prompts.
- **`team.md`** — people: name, slack handle, email, weight (`CRITICAL|HIGH|NORMAL`), expected
  cadence, notes. Doubles as the **ingestion whitelist**: weight CRITICAL/HIGH ⇒ Tier 1 (full
  extraction), everyone else Tier 2 (interaction-logged only). Materialized into the `people`
  table on boot and on change; people removed or renamed away are demoted (tier 2,
  `source='departed'`) rather than deleted — with an empty-file guard, so a missing/blank
  file never demotes the whole roster.
- **`heartbeat.md`** — loop schedule (interval, quiet hours, active days), briefing times,
  behavior thresholds (surfacing_threshold, max_surfaces_per_task, max_proactive_per_hour,
  min_gap_between_nudges), per-source poll intervals + enabled flags, free-form agent
  instructions, this-week context.

Defaults (constants in `@botty/shared`): tick 20 min, quiet 22:00–08:00, Mon–Fri,
surfacing_threshold 7/10, max_surfaces_per_task 3, max_proactive_per_hour 2, min_gap 30 min,
cooldowns {1→48h, 2→96h, 3+→7d}, morning brief 08:45, evening 18:00.

## 6. LLM defaults

Via Claude Agent SDK, authenticated by the user's Claude Code subscription. Task→model routing
(user-overridable in settings):

| Task | Model | Notes |
|---|---|---|
| `chat` | `claude-sonnet-5` | warm session, streaming |
| `judgment` | `claude-sonnet-5` | one-shot structured per tick |
| `classification` | `claude-haiku-4-5` | "worth extracting?" gate |
| `extraction` | `claude-haiku-4-5` | entities from raw events |
| `briefing` | `claude-sonnet-5` | morning/evening digests |

`claude-opus-4-8` available as an escalation option per task. Every call is recorded in
`ai_decisions` (inputs, output, model, latency, tokens).

## 7. Milestones (each independently useful)

- **M1 — Chat with memory.** Agent + SQLite + FTS5 recall + config loader + web chat (single
  continuous thread, streaming). Usable as a persistent-memory assistant.
- **M2 — Ingestion + task board.** Simulator + sim drivers for all 5 sources + funnel
  (tier/heuristics/classifier/extractor) + tasks/people pages + Inspector (funnel verdicts).
  Usable as a "what's on my plate" dashboard.
- **M3 — The loop.** Rules filter + judgment + notifications (in-UI + macOS via
  `terminal-notifier`/`osascript`) + briefings + response tracker + tick Inspector.
- **M4 — Tuning + real drivers.** Replay harness in anger; real drivers via the **claude.ai MCP
  connectors** (Slack, Gmail, Google Calendar) through the Agent SDK — no standalone tokens or
  Slack app; Jira/GitHub via REST/CLI. The MCP read lives strictly inside `SourceAdapter.fetch()`;
  everything downstream (raw log, dedup, funnel) stays deterministic. Cadence drift. (The
  resolution sweep — auto-close from thread evidence, incl. the user's outbound replies —
  shipped early; see specs/loop.md.)

The initial build (this repo bootstrap) targets **M1–M3 against the simulator** end to end.

## 8. Cut from v1 (revisit later)

Canvas/A2UI, skills engine, team graph visualization, clipboard watcher, voice capture,
field-level encryption + encrypted volumes, corrections-learning loop, budget pools (a simple
daily per-task call counter suffices), native menu-bar app (a thin Tauri wrapper is a cheap later
add), multi-provider LLM routing (Codex), sqlite-vec embeddings (FTS5 first).

## 9. Non-goals

Multi-user/SaaS, mobile, cross-device sync, Jira/Notion replacement, voice-first interface.
