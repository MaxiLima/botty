# botito — Complete Technical Specification

> A single, authoritative reference for what botito is, what it does, and how it does it.
> Covers product principles, architecture, every subsystem, integrations, data model, the
> macOS UI, security, and the build/run story.
>
> **Status:** living document. Reconciled against the code on the `feat/proactivity-overhaul`
> branch (commit `24a3751`, 2026‑07‑04). Where design docs and code disagree, the code wins and
> the divergence is noted.
>
> Scale at time of writing: ~27.7k LOC Node backend, ~14.9k LOC Swift (89 files), 12 SQLite
> migrations (~21 tables), ~50 Node test files (600+ cases), 96 commits since 2026‑05‑24.

---

## Table of Contents

1. [What botito is](#1-what-botito-is)
2. [Product principles](#2-product-principles)
3. [System architecture](#3-system-architecture)
4. [Process model & runtime](#4-process-model--runtime)
5. [Configuration system — the seven markdown files](#5-configuration-system--the-seven-markdown-files)
6. [Memory layer](#6-memory-layer)
7. [Ingestion pipeline & source integrations](#7-ingestion-pipeline--source-integrations)
8. [Model routing & providers](#8-model-routing--providers)
9. [Sessions & the LLM agent loop](#9-sessions--the-llm-agent-loop)
10. [Proactive loop & heartbeat](#10-proactive-loop--heartbeat)
11. [Briefings, resolution sweep & cadence](#11-briefings-resolution-sweep--cadence)
12. [IPC protocol](#12-ipc-protocol)
13. [The macOS app (Swift/SwiftUI)](#13-the-macos-app-swiftswiftui)
14. [Design system](#14-design-system)
15. [Canvas (A2UI)](#15-canvas-a2ui)
16. [Skills system](#16-skills-system)
17. [Security, privacy & data at rest](#17-security-privacy--data-at-rest)
18. [Backup & recovery](#18-backup--recovery)
19. [Budget & cost control](#19-budget--cost-control)
20. [Observability](#20-observability)
21. [Data model reference](#21-data-model-reference)
22. [Build, run & test](#22-build-run--test)
23. [Roadmap & current state](#23-roadmap--current-state)
24. [Constraints, non-goals & known seams](#24-constraints-non-goals--known-seams)
25. [Glossary & key constants](#25-glossary--key-constants)

---

## 1. What botito is

botito is a **personal, proactive AI assistant** that runs natively on macOS. It watches the
signals that make up a workday — Slack DMs and mentions, calendar events, email, Jira, GitHub —
and turns the ones that matter into tracked tasks. It remembers people, projects, and decisions
across sessions, and it surfaces the right thing at the right moment without nagging.

It is explicitly **not** a general-purpose chatbot, not a search engine, and not a replacement
for Jira/Notion. It is a context-aware task-and-memory assistant with a personality, built for a
single user on a single Mac.

The defining traits:

- **Proactive, not reactive.** It speaks first when something deserves attention, and stays quiet
  otherwise. Avoiding nagging is treated as the harder engineering problem than catching things.
- **Local-first & private.** Everything lives on the user's Mac. No cloud backend, no telemetry,
  no company data relayed through a botito-operated service.
- **Editable behavior.** The assistant's identity, tone, schedule, and priorities are authored in
  plain markdown files that hot-reload — behavior is visible, not buried in code.
- **Subscription-backed models.** LLM calls route through the user's own Claude Code / Codex CLI
  subscriptions rather than direct API keys, so no new API cost and no cloud relay.
- **Transparent.** Every tick, filter decision, extraction, and model call is observable in an
  in-app Activity Monitor.

### The "becoming someone" identity model

botito is designed to feel like *a colleague who gets things done*, not a tool. Its `SOUL.md`
opens with: *"You're not a chatbot. You're becoming someone."* The personality is real and
enforced: a banned-phrases list ("Certainly!", "leverage", "dive into", em-dashes in chat), tone
rules (answer first, contractions always, never open with "I"), and a "reading the room" clause
(terse late at night with many open tasks; warmer when things are calm). Continuity across
otherwise-stateless sessions comes from the markdown config files plus the persistent memory
store.

---

## 2. Product principles

Five foundational principles drive every design decision (from `architecture-rfc.md` and the
config templates):

1. **Proactive without nagging.** Surface at the right moment, back off when ignored, never
   repeat blindly. Enforced by cooldown escalation, surface caps, quiet hours, hourly caps, and a
   two-layer judgment system (§10).
2. **Persistent memory.** Conversations, tasks, people, and decisions are remembered across
   sessions and accumulated into useful context (§6).
3. **Editable behavior.** Personality, schedule, and rules live in plain markdown; no code change
   needed to retune the assistant (§5).
4. **Native and local.** Runs entirely on the user's Mac. No cloud backend, no telemetry (§17).
5. **Extensible.** New capabilities via the skills system and MCP integrations without touching
   core code (§16, §7).

Behavioral contract, as encoded in `IDENTITY.md`/`SOUL.md`/`USER.md`:

- Don't make decisions on the user's behalf; don't assume a task is done unless confirmed.
- Don't surface the same thing repeatedly without new information.
- If unsure whether something is a task, ask **one** focused question — never more than one.
- Never share information across different people's contexts. Private things stay private.
- Bold internally (read, organize, learn, act); careful externally (messages, emails, anything
  others will see) — "never send half-baked replies to group chats."

---

## 3. System architecture

botito is **two cooperating processes on one Mac**, plus local files:

```
┌───────────────────────────────── macOS ──────────────────────────────────┐
│                                                                           │
│   ┌───────────────────────────┐        ┌──────────────────────────────┐  │
│   │   Swift app (SwiftUI)      │        │    Node.js agent             │  │
│   │  • Menu-bar UI (accessory) │        │  • Memory layer (SQLite+vec) │  │
│   │  • Chat / Tasks / Team /   │  IPC   │  • Proactive loop + judgment │  │
│   │    Projects / Activity     │◄──────►│  • Config loader (hot-reload)│  │
│   │  • Native notifications    │ (unix  │  • Ingestion pipeline        │  │
│   │  • Global hotkey, Keychain │ socket)│  • Model router + providers  │  │
│   │  • Clipboard, FSEvents     │        │  • Session manager           │  │
│   └───────────────────────────┘        └──────────────────────────────┘  │
│              │                                       │                     │
│          Keychain                          SQLite (memory.db) +           │
│      (tokens, enc key)                     encrypted raw log + backups    │
│                                                     │                      │
│                                         Claude Code CLI / Codex CLI        │
│                                         (subprocesses, user's subs) ──► LLM│
└───────────────────────────────────────────────────────────────────────────┘
```

| Layer | Tech | Owns |
|---|---|---|
| UI + system hooks | SwiftUI / AppKit | Menu bar, chat, notifications, hotkeys, Keychain, clipboard, FSEvents, process supervision |
| Agent brain | Node.js (CommonJS, node ≥ 22.5) | Memory, loop, extraction, judgment, config, routing, sessions |
| IPC | Unix domain socket | Bidirectional newline-delimited JSON |
| Structured storage | SQLite (`better-sqlite3`, WAL) | Tasks, people, projects, decisions, interactions, sessions, logs |
| Vector store | `sqlite-vec` | Semantic similarity search, embedded in `memory.db` |
| Raw event log | encrypted store | Append-only ground truth, replay-able |
| Config | Markdown files | Editable behavior definitions |
| Models | Claude Code / Codex CLIs | LLM inference via subprocess, user's subscription |

### Key architectural decisions & rationale

- **SQLite, not Postgres** — single user, local-only, embedded, one portable `.db` file, ACID.
- **`sqlite-vec`, not ChromaDB** — no Python runtime; the vector store lives in the same `.db`.
- **Markdown config, not a DSL or DB fields** — editable, versionable (home dir, git-friendly),
  hot-reloadable, and legible. The agent's behavior is readable text.
- **MCP for actions, native pollers for ingestion** — MCP is request/response (great for
  on-demand "send a Slack message", "read a Drive doc"); ingestion is long-running/polled. In the
  packaged app, *source reads themselves* also go through the model's MCP (`router.call('*_ingest')`)
  rather than a direct adapter, because the packaged app has no standalone Slack/Gmail tokens.
- **Subscription-backed providers, no direct API** — respects the user's existing Claude Pro /
  ChatGPT subscriptions, keeps credentials local, and satisfies the Acme constraint that
  company data must not be relayed through cloud infrastructure the user doesn't control.
- **Single continuous chat thread** — feels like Slack/WhatsApp; sessions "seal" invisibly under
  the hood for context management (§9), but the user sees one unbroken thread.

---

## 4. Process model & runtime

### Node agent entrypoint (`agent/index.js`)

The agent is a long-lived daemon spawned by the Swift app. Startup order (`startup()`):

1. **Security boot** — retrieve encryption key from Keychain, mount encrypted volume if available.
2. **Memory layer** — open `memory.db`, set encryption key, run migrations, init `Vectors`,
   `Mutations`, `Decisions`.
3. **Requester backfill** — one-time repair stamping `requested_by` on legacy Slack tasks.
4. **Model router + budget** — instantiate `ModelRouter` from `available-models.json` with a
   `Budget` tracker.
5. **Session manager** — `SessionManager` wraps the router for warm/persistent LLM sessions.
6. **Integrations pipeline** — wire `createPipeline` (extractor → router → budget).
7. **Config module** — load and watch the seven markdown files.
8. **People materialization** — hydrate the `people` table from `TEAM.md`; re-run on config change.
9. **Settings store** — load user settings.
10. **Context builder** — semantic memory assembly.
11. **Skills engine** — load bundled + custom skills.
12. **Privacy module** — init call-tracking and private-mode gating.
13. **IPC server** — start the Unix-socket server; wait for the Swift app.
14. **Proactive loop** — `loop.start({ db, contextBuilder, modelRouter, ... })`.
15. **Startup resolution sweep** — run once ~60 s after warmup (backfill auto-close).
16. **Nightly backup** — schedule `VACUUM INTO` snapshots at 02:00.

**Shutdown** stops the loop and IPC server, awaits `SessionManager.shutdown()` (closing warm CLI
processes *before* unmounting the encrypted volume), unmounts, and exits.

Long-running components: the heartbeat **scheduler** (default 20 min), the **IPC server**, an
**idle sweep** (60 s, closes warm sessions idle > 30 min), staggered **source schedulers**,
cron-style **briefings**, and the **nightly backup**.

Resilience is a first-class property: nearly every init is wrapped so a missing feature degrades
rather than crashes (no router → skip classifier; no Keychain → ephemeral key; no `hdiutil` → skip
volume; no `sqlite-vec` → fall back to an embedding cache).

### Swift app supervision

The Swift `NodeProcessManager` spawns `node agent/index.js`, injecting environment (socket path,
data path, skills path, tokens from Keychain). It monitors the process and restarts on crash with
exponential backoff (1s → 2s → 4s → 8s → 16s → capped at 30s), resetting backoff if the process
stayed up > 30s. Node path resolution: `$BOTITO_AGENT_PATH` override → bundle resources → walk up
from the binary looking for `agent/index.js` (dev).

---

## 5. Configuration system — the seven markdown files

All standing context is authored in plain markdown, not code or DB fields. Live config lives at
`~/Library/Application Support/Assistant/` (the repo-root copies are templates); the runtime reads
from `$BOTITO_CONFIG_ROOT` (set by Swift) or the repo root in dev.

| File | Purpose | Injected into |
|---|---|---|
| `IDENTITY.md` | Operational identity, capabilities, boundaries, uncertainty handling | Every prompt (always) |
| `SOUL.md` | Personality, voice, banned phrases, tone, "reading the room" | chat, judgment, classification |
| `USER.md` | Who the user is: role, timezone, work style, availability, personal context | chat, judgment, classification |
| `WORK.md` | Current role, projects, tech stack, processes, definition of done | summary by default, full for extraction |
| `TEAM.md` | People, roles, Slack handles, emails, **weight/tier**, interpretation guide | conditional (when a known name appears) + always for extraction |
| `CONTEXT.md` | This week's reality, current focus, what's deliberately being ignored | chat, judgment, briefings |
| `HEARTBEAT.md` | The proactive loop's schedule, checks, behavior thresholds, sources | loop ticks |

The files form a **layering stack**: `IDENTITY` is the floor (can't be overridden), then `SOUL`,
`USER`, `WORK`, `TEAM`, `CONTEXT`, and `HEARTBEAT` respects all above.

### Loading, parsing, injection (`agent/config/`)

- **Loader** (`loader.js`) — reads all seven files into a parsed cache + a raw-markdown cache;
  supplies minimal built-in defaults when a file is absent.
- **Parser** (`parser.js`) — strips HTML comments, splits on `## ` headers, returns
  `sections[headingLower] → body`.
- **Injector** (`injector.js`) — `assemble(promptType, messageText, opts)` builds the system prompt
  from an **injection matrix** (which files go into which prompt type). Blocks are wrapped in
  `=== LABEL === … === END LABEL ===`. It keeps a **team-name index** (bolded names from `TEAM.md`)
  and only injects `TEAM.md` when the current message actually mentions someone — a cost
  optimization. For chat, it also injects the Canvas/A2UI instruction block (§15) unless disabled.
- **Watcher** (`watcher.js`) — `chokidar`/`fs.watch` with a ~500 ms debounce. On change it
  snapshots the previous version to an archive, reloads, validates, and fires `onFileChange`. A
  `TEAM.md` change additionally rebuilds the name index, re-materializes the `people` table, and
  broadcasts a team-reload to the UI.
- **Index** (`index.js`) — public API: `init`, `stop`, `get`, `getRaw`, `getAll`,
  `buildSystemPrompt`, `save` (validate → snapshot → write → trigger watcher), `listSnapshots`,
  `getSnapshot`, `getStatus`; emits `config:changed` / `config:error` / `config:warning`.

Config edits made in the app's config editors flow through the same `save` path, so every edit is
validated and versioned. Snapshots are browsable and restorable from the UI.

### HEARTBEAT.md schema (the loop's control surface)

```
## Schedule        interval, quiet_hours, active_days, min_interval, max_interval
## This tick       checklist of what to check (stale, deadlines, first-surface, snooze expiry)
## Briefings       morning_at, evening_at, weekly_retro_at, weekend_briefings
## Event triggers  calendar_starting_lead, urgent_inbound, cadence_drift_check
## Sources         per-source interval + enabled flags, slack_channels allowlist
## Modes           pto_mode (off | on | "until YYYY-MM-DD")
## Behavior        surfacing_threshold, max_surfaces_per_task, max_proactive_per_hour,
                   min_gap_between_nudges, max_snoozes_per_tick, tone
## Agent instructions   free-form rules ("never more than one per tick", "prefer questions")
## People context       weightings and notes
```

Defaults (from `heartbeat.js` `DEFAULTS`): interval 20 min, quiet hours 22:00–08:00, active days
Mon–Fri, surfacing_threshold 7/10, max_surfaces_per_task 3, max_proactive_per_hour 2,
min_gap_between_nudges 30 min, max_snoozes_per_tick 8, morning 08:45, evening 18:00, weekly retro
Fri 17:30.

---

## 6. Memory layer

The memory layer is the only thing that gives the model continuity across otherwise-independent
calls. It is a **three-store hybrid**:

| Store | Answers | Tech |
|---|---|---|
| **SQLite** | "What are my open tasks? Who assigned them?" | `better-sqlite3` (WAL, FK on) |
| **Vectors** | "What was said about App XX? What did Marian decide?" | `sqlite-vec`, embedded in `memory.db` |
| **Raw log** | "What actually happened, in order?" | append-only, encrypted at rest |

### Data access layer (`memory/sqlite.js`, ~950 lines)

The `Db` class owns the connection, migrations, and CRUD. Defaults to
`~/Library/Application Support/Assistant/data/memory.db`. `open()` sets `journal_mode=WAL` and
`foreign_keys=ON` and runs migrations.

- Generic accessors `_run`/`_get`/`_all` **auto-decrypt** the `ENCRYPTED_COLUMNS` set on read.
  Helpers `_enc`/`_dec`/`_decryptRow`/`_decryptRows` do the work; `camel2snake()` maps JS field
  names to columns. **Gotcha:** because `_get`/`_all` already decrypt, callers must never
  double-decrypt a value — doing so throws under a real key.
- Task queries the loop depends on: `getOpenTasks`, `getBoardTasks`, `getTasksDueSoon(days)`,
  `getStaleOpenTasks(days)`, `getTasksNeverSurfaced`.
- Writes: `insertTask`, `updateTask`, `upsertPerson`, `upsertProject`, `insertDecision`,
  `linkTaskDecision`, `insertInteraction`, `insertSession`, `sealSession`, `insertChatTurn`,
  `insertProactiveLog`, `recordProactiveResponse`, `markProactiveTurnResolved`, `insertCorrection`.

### Supporting modules (`memory/`)

- **WorkingMemory** — ~30-min ring buffer (~500 entries) for "what just happened" without hitting
  SQLite; replayed from the raw log on startup.
- **Logger** — appends every event to both working memory and the `raw_log` table.
- **ContextBuilder** — assembles prompt context in tiers: working memory → recent session turns →
  semantic search (vector query, top-K) → open tasks (due-soon + stale). `buildChatContext` and
  `buildProactiveContext`, each token-budgeted.
- **Extractor** — LLM-based entity extraction (tasks/people/projects/decisions) with a 24-h
  in-process cache and optional injection of past corrections for learning.
- **Vectors** — `insert(text, metadata) → docId`, `query(text, {nResults, where, halfLifeDays})`
  with **temporal decay** (recency boost `exp(-ln2 · ageDays / halfLifeDays)`, default half-life
  30 d).
- **Decisions** — first-class decision entities: `create`, `findRelated`, `forProject`, `recent`,
  `linkTask`, `supersede`.
- **Mutations** (EventEmitter) — all writes to existing records: `setTaskStatus`, `correctTask`,
  `mergeTasks`, `snoozeTask`; logs to `task_history` and emits `task_changed` / `project_changed`.
- **Corrections** — captures agent-output → user-fix pairs and generalizations, fed back into the
  extractor's prompt.
- **Consolidator** — merges near-duplicate tasks.
- **PeopleMaterializer** — parses `TEAM.md` into the `people` table (name, tier/weight, cadence,
  email, Slack handle) on boot and on every `TEAM.md` change.

---

## 7. Ingestion pipeline & source integrations

### The five-step write pipeline (`agent/integrations/pipeline.js`)

Every inbound event runs a cost-conscious funnel that kills ~99% of noise before any expensive LLM
call:

| Step | Gate | Cost | Result on fail |
|---|---|---|---|
| 1 | **Raw log** (sync, always; `UNIQUE(source,id)` dedup) | ~0 | — |
| 2 | **Tier check** (SQL lookup of the actor in `people`) | ~0.1 ms | Tier 2 → `SHALLOW` |
| 3 | **Heuristic gate** (regex for task/decision/commitment signals) | ~1 ms | → `STORE_AS_INTERACTION` |
| 4 | **Classifier LLM** ("worth extracting?", cheap model) | ~$0.0001 | → `STORE_AS_INTERACTION` |
| 5 | **Extractor LLM** (parse into entities, persist) | ~$0.003 | logged, non-fatal |

`StopLevel ∈ { SHALLOW, STORE_AS_INTERACTION, EXTRACTED, DUPLICATE }`.

Special paths: **private mode** short-circuits everything to a suppression record; **manual
capture** (self-authored, from chat/quick-capture) bypasses the tier/heuristic gates and extracts
directly; a **near-budget** state flips the classifier into strict mode; classifier LLM failure
**degrades gracefully** (extract everything that passed heuristics) while malformed JSON is
rejected conservatively.

Persistence order: people first (so a task's `requested_by` resolves), then tasks (priority 1 if
Tier 1, else 2), then decisions. `UNIQUE(source, source_ref)` dedups tasks/decisions.

### Tiers (the whitelist)

`TEAM.md` doubles as config **and** the ingestion whitelist. People listed there with weight
`HIGH`/`CRITICAL` are **Tier 1** (full extraction; their requests carry weight and drive
cadence-drift alerts). Everyone else is **Tier 2** (raw-logged and stored as interactions, never
extracted). Frequent Tier-2 contacts become promotion candidates ("add to TEAM.md?").

### Heuristics (`heuristics.js`)

Conservative regexes (false positives OK, false negatives are misses) for:
- **Task signals:** "can you", "please", "?", weekday + "by", "blocker/blocked on/waiting on",
  "remind me", "follow up", "asap", "before the meeting".
- **Decision signals:** "we decided", "going with", "agreed to", "approved/rejected/signed off".
- **Commitment signals:** "I'll do", "I will send", "on my list", "I own this".

### Source ingestion (`agent/loop/sources/`)

In the packaged app, source *reads* go through the **model's MCP**, not a standalone adapter,
because the packaged app has no independent Slack/Gmail tokens. `checkAllSources({ db, router,
only })` fans out to per-source runners, each of which calls `router.call('<source>_ingest', …)`
with the appropriate MCP servers (or `allowBash: true` for CLI-backed sources):

- **Slack** (`slack_ingest`) — model reads DMs/mentions/monitored channels via the Slack MCP.
  A **hard scope filter** keeps team DMs and @mentions always, plus explicitly monitored channels;
  it skips already-handled threads and social noise, then upserts tasks.
- **Gmail** (`gmail_ingest`, Gmail MCP) — `needsAction` gate → tasks.
- **Google Calendar** (`gcal_ingest`, Calendar MCP) — inserts `calendar_events`, and creates tasks
  for events starting within ~60 min that include Tier-1 attendees; feeds the meeting-prep nudge.
- **Jira** (`jira_ingest`, `allowBash`) — `acli` for assigned in-progress/review/blocked issues.
- **GitHub** (`github_ingest`, `allowBash`) — `gh` CLI for assigned PRs and open issues.
- **Google Drive** (`gdrive_ingest`) — chat-only/on-demand; not scheduled (backfill runner only).

Native adapter implementations also exist (`agent/integrations/adapters/slack`, `.../gcal`) with a
full `SourceAdapter` contract (`init`/`start`/`stop`/`status`/`backfill`, Socket-Mode-or-poll for
Slack, OAuth + delta-sync + a synthetic "starting" queue for Calendar). These are the
standalone-token path; the MCP path above is what the packaged app uses.

### Source scheduler

`SourceScheduler` polls each enabled source on its own interval (defaults: Slack 10 min, Gmail 30
min, Calendar 60 min, Jira/GitHub 120 min), staggered ~30 s apart on startup to avoid a thundering
herd, and respecting quiet hours, active days, PTO, and private mode.

---

## 8. Model routing & providers

All LLM calls go through the **ModelRouter** (`agent/models/router.js`), which resolves a *task
name* to a *provider + model*, applies a fallback chain, enforces budget, and pipes MCP/Bash
scope.

### Resolution order

1. Explicit `options.provider` / `options.model`.
2. User `settingsOverrides[task]`.
3. `available-models.json` → `taskDefaults[task]`.
4. First available provider's default model.

If the chosen provider is unavailable, the **fallback chain** (`["claude-code", "codex"]`) kicks
in — but the router **refuses to fall back** to a provider that lacks a capability the task
requires (MCP or Bash), to prevent silent data loss.

### Task catalog (`available-models.json`)

Ingestion-pool tasks: `extraction`, `classification`, `session_summary`, and the `*_ingest`
family (`slack_ingest`, `slack_resolution`, `gmail_ingest`, `gcal_ingest`, `gdrive_ingest`,
`jira_ingest`, `github_ingest`). Everything else (`chat`, `heartbeat_judgment`, `consolidation`,
`skill_default`, …) is assistant-pool. Notable defaults:

- `chat` → claude-code / `claude-sonnet-4-6`, MCP `[slack, gdrive, gcal, gmail]`.
- `classification`, `extraction`, `session_summary` → codex / `gpt-5-mini` (cheap).
- `heartbeat_judgment`, `consolidation` → claude-code.
- `*_ingest` → claude-code + the matching MCP; `jira_ingest`/`github_ingest` add `allowBash`.

Models file (ground truth) exposes **claude-code** (`claude-opus-4-7`, `claude-sonnet-4-6`
[default], `claude-haiku-4-5-20251001`) and **codex** (`gpt-5`, `gpt-5-mini` [default], `gpt-5-nano`,
`o4`, `o4-mini`). New models are added by editing the JSON — no code change. The file hot-reloads.

### Providers (`agent/models/providers/`)

- **`Provider` base** — declares `isAvailable`, `models`, `supportsMCP`, `supportsBash`,
  `supportsWarmSession`, `call` (async generator of chunks), `openSession`, `shutdown`.
- **`ClaudeCodeProvider`** — spawns the `claude` CLI. **One-shot:** `claude --print
  --output-format stream-json --verbose [--model …] [--system-prompt …] [--session-id|--resume …]
  [--permission-mode … | --allowedTools mcp__claude_ai_Slack …] [--max-turns 8]`, streaming JSON
  events (`text` / `thinking` / `tool_use` / `tool_result` / `done`+tokens); a watchdog kills hung
  processes. **Warm session:** `claude --input-format stream-json --output-format stream-json` keeps
  stdin open across turns, implementing `ProviderSession` (`send`/`interrupt`/`close`). MCP scoping
  maps task `mcpServers` to `--allowedTools mcp__claude_ai_*`; unpermitted tools auto-deny.
- **`CodexProvider`** — spawns `codex exec --json`. Stateless only (no warm session, no MCP, no
  Bash — declares those false so the router won't misuse it). Picks the newest `codex` binary on
  PATH to self-heal version skew.
- **`ProviderRegistry`** — loads and hot-reloads `available-models.json`, instantiates providers.
- **`content-blocks.js`** — converts attachments (images/PDF) into Anthropic content blocks for
  warm sessions; validates MIME, enforces a 30 MB cap.

MCP server IDs: `slack → mcp__claude_ai_Slack`, `gmail → mcp__claude_ai_Gmail`,
`gcal → mcp__claude_ai_Google_Calendar`, `gdrive → mcp__claude_ai_Google_Drive`.

---

## 9. Sessions & the LLM agent loop

`SessionManager` (`agent/sessions/manager.js`) keeps **warm CLI processes** alive per `(kind, key)`
so conversations and the heartbeat don't pay cold-start latency (0.5–2 s) on every turn.

- **Kinds:** `chat` (user conversation), `heartbeat` (proactive judgment), plus async task
  sessions.
- **`getOrCreate({kind, key})`** returns a live `Session`, rehydrating a provider `sessionId` from
  the `sessions` table when present. An **idle sweep** every 60 s closes sessions idle > 30 min.
- **`Session`** (`session.js`) wraps a warm provider session, with graceful fallback: if the warm
  process crashes, that turn falls back to a cold `router.call(..., { resumeSessionId })` and the
  session auto-reopens next turn. Statuses: `ready`/`busy`/`idle`/`closed`/`error`.
- Warm chat turns stream `text`/`thinking`/`tool_use`/`tool_result` chunks straight through IPC to
  the UI for live rendering.

**Session persistence gotcha:** warm sessions persist to the CLI's own default config dir
(`~/.claude`, `~/.codex`) — **not** the encrypted mount — because redirecting `CLAUDE_CONFIG_DIR`
would break CLI auth. The encrypted volume is reserved for transcripts/future use. A live
integration test guards this behavior.

The **judgment** engine (§10) can run in two modes: stateless (a fresh `router.call` per tick) or
**persistent-mind** (a warm heartbeat session that remembers operating instructions across ticks,
reseeding at ~50k tokens or daily to prevent drift).

---

## 10. Proactive loop & heartbeat

This is the heart of botito. The loop decides — every tick — whether to speak, and it is built to
err toward silence.

### Tick flow (`agent/loop/runner.js`)

`runTick({ trigger, candidates })`:

1. Load `HEARTBEAT` config.
2. Check **PTO** and **private** mode → skip non-manual ticks.
3. Check **timing** (quiet hours, active days) → skip.
4. **Freshen** the response tracker (expire old surfaces).
5. **Gather candidates** — union of due-soon, never-surfaced, stale, and all-open tasks, each
   tagged with a `reminderReason` (`DUE_SOON` / `NEVER_SURFACED` / `STALE`).
6. **Layer 1 — rules filter** (deterministic, no LLM).
7. Build memory context (`buildProactiveContext`).
8. **Layer 2 — Claude judgment** (`Judgment.evaluate`).
9. Validate actions against the surfacing threshold; cap snoozes.
10. **Execute** actions (notify / snooze / mark_done / update_priority / check_sources).
11. Log completion; reschedule the next tick.

### Layer 1 — rules filter (`rules-filter.js`)

Nine sequential gates; any failure disqualifies a candidate (cheap gates first):

1. **Cooldown since last surface** — `COOLDOWNS = {0:0, 1:48h, 2:96h, 3:7d}` keyed by surface count
   (escalating back-off).
2. **Hard surface cap** — `max_surfaces_per_task` (default 3), unless a deadline is < 48 h away.
3. **Snoozed** — `snooze_until > now` blocks.
4. **Closed status** — `done / cancelled / merged / archived` blocks.
5. **Quiet hours** — suppressed.
6. **Global nudge gap** — `min_gap_between_nudges` (default 30 min) since the last proactive surface.
7. **User actively chatting** — blocked within 2 min of the last user message.
8. **Hourly cap** — `max_proactive_per_hour` (default 2).
9. **Requester muted** — a muted requester blocks.

### Layer 2 — Claude judgment (`judgment.js`)

The survivors, plus memory context and the heartbeat rules, go to the model. It runs stateless or
persistent-mind and returns:

```json
{
  "tick_reasoning": "…",
  "actions": [ { "type": "notify|snooze|mark_done|update_priority",
                 "task_id": "…", "score": 8, "message": "…", "reasoning": "…" } ],
  "skipped": [ { "task_id": "…", "score": 4, "reason": "…" } ],
  "next_suggested_interval": "20min"
}
```

Each candidate is rendered for the model with id, description, requester, age, status, priority,
times-surfaced, last-surfaced, deadline, project, and any reminder flag. The ~370-line system
prompt emphasizes an **actionability gate first**, respecting dismissal history, the dangers of
over-snoozing, and a strong **bias to skip**.

### Action execution (`action-runner.js`)

- **notify** — insert a `proactive_log` row, increment `surface_count`, and send via the
  notification bus with `{ taskId, surfaceId, message, score, surfaceKind, actions,
  reasoningSnippet }` (reasoning trimmed to the first sentence, ≤ 140 chars).
- **snooze** — status `snoozed`, `snooze_until = now + duration` (default 3 d).
- **mark_done** — only if `score ≥ 9` **and** `allow_auto_mark_done` is enabled.
- **update_priority** — set priority.
- **check_sources** — fire-and-forget `checkAllSources()`.

### Anti-nagging, summarized

Cooldown escalation + surface cap + quiet hours + hourly cap + global gap + "user is typing" gate +
a per-tick snooze cap (default 8, so the model can't quietly clear the board) + a skip-biased
judge. The **response tracker** (`response-tracker.js`) classifies each user reply against recent
surfaces (`completed`/`acknowledged`/`dismissed`/`snoozed`/`unrelated`) within a 24-h window and
expires unanswered surfaces — turning silence into signal.

---

## 11. Briefings, resolution sweep & cadence

- **Briefings** (`briefings.js`) — scheduled digests delivered via the notification bus with
  distinct `surface_kind`s:
  - **Morning** (~08:45): today's meetings, top high-priority tasks, stale tasks (5+ days),
    overnight Tier-1 messages, tasks completed.
  - **Evening** (~18:00): what got done, what slipped, tomorrow's preview.
  - **Weekly retro** (Fri ~17:30): reflective — completions by project, slips, decisions, people
    cadence vs. expectation, next-week preview.
  - **PTO briefing**: a handoff brief on entering PTO; a re-onboard on return.
- **Resolution sweep** (`resolution-sweep.js`) — every 5 min (max 5 checks/sweep, 10-min per-task
  cooldown), for each open Slack task it asks the model (via the Slack MCP) to read the thread and
  judge whether it's already been handled, auto-closing if so. Gated by
  `behavior.autoResolveTasks`.
- **Cadence drift** — a nightly check (default 18:00) comparing actual interaction recency against
  each person's declared cadence in `TEAM.md`, surfacing people who've gone quiet (capped so it
  can't flood).
- **Event triggers** — `calendar_starting` (meeting-prep nudge N min before), `urgent_inbound`
  (immediate tick on a high-confidence Tier-1 DM).

---

## 12. IPC protocol

**Transport:** Unix domain socket at `~/Library/Application Support/Assistant/agent.sock`.
**Framing:** newline-delimited JSON, one message per line.
**Envelope:** `{ id: nanoid, type: string, payload: object, ts: ISO8601 }`, with `id` correlating
request/response. TypeScript definitions live in `agent/ipc/messages.ts`; the server is
`agent/ipc/server.js` (~2.6k lines, 50+ handlers).

**Critical contract:** the Swift `JSONDecoder` performs **no** snake_case → camelCase conversion in
the direction the raw DB uses, so **all payloads Node sends must be camelCase**. Node formats rows
(e.g. `formatTaskSummary` maps `updated_at → updatedAt`, `requested_by → requestedByName`) before
sending. Two hard-won gotchas: (1) a payload that leaks snake_case silently produces a dead pane —
so decode failures now emit an `activity:error` event instead of vanishing; (2) `score` must be a
**Double** (fractional 0–10), not an Int, or the whole chat/notification decode fails.

**Reliability:** on connect, the server pushes the current task-board snapshot and **replays** up
to 20 buffered proactive notifications that arrived while the app was disconnected. The Swift
`IPCClient` (`NWConnection` over `.unix`) waits for the socket file to exist before dialing
(dialing a missing socket hangs in `.preparing` forever) and reconnects on failure.

Representative message types:

- **Swift → Node:** `chat:message`, `chat:seal-session`, `chat:interrupt`, `chat:history`,
  `tasks:action` (snooze/done/dismiss), `tasks:get-detail`, `notification:action`, `config:get`,
  `config:save`, `config:list-snapshots`, `config:restore-snapshot`, `settings:*`, `skill:list`,
  `skill:invoke`, `mcp:list|toggle|reconnect`, `privacy:get-stats`, `privacy:set-private-mode`,
  `sources:list`, `sources:check-now`, `team:list|person-detail|mute|suggest-demotion`,
  `projects:list|rollup|update`, `canvas:action`, `clipboard:candidate`, `loop:run-now`,
  `loop:resolution-sweep-now`, `backup:run-now`, `quick-capture-submit`.
- **Node → Swift:** `chat:chunk`/`thinking`/`tool-call`/`tool-result`/`response`,
  `chat:session-sealed`, `chat:history` response, `tasks:updated`, `tasks:detail`,
  `notification:proactive`, `team:*`, `projects:*`, `config:*`, `settings:*`, `sources:*`,
  `skill:chunk`/`result`, `mcp:*`, `privacy:*`, and the activity streams `activity:tick`,
  `activity:error`, `activity:memory`, `activity:claude-call`, `activity:fs`,
  `activity:source-fire`, plus `loop:status` and `agent:status`.

---

## 13. The macOS app (Swift/SwiftUI)

A **menu-bar application** (`LSUIElement`, `.accessory` policy — no Dock icon). One window shell
with a 200 pt sidebar routing to eight surfaces. `AppState` holds global singletons (the IPC
client, `NodeProcessManager`, `TaskBoardViewModel`, route enum, badge counts). Each surface owns a
`@StateObject` view-model subscribed to IPC push streams; there is no Redux — plain `@Published` +
Combine, `@MainActor` throughout.

### Surfaces

- **Chat** — a **single continuous thread** across all sessions. `ChatViewModel` merges sealed and
  active sessions into one chronological `turns` array; session boundaries render as subtle "· new
  context ·" dividers. Streaming chunks accumulate into an in-flight turn; a presence pill shows
  thinking/streaming/tool/error state with the active task name. Multi-line composer with
  drag/drop + paste of images/PDFs (base64 over IPC), Shift+Return for newline, a Stop button that
  emits `chat:interrupt` mid-stream, "see more" pagination, a fresh-context button (soft seal), and
  a client-side idle-gap detector as a defensive seal. Proactive nudges render **in-thread as
  cards** with done/snooze/dismiss/open actions; dismiss opens a reason picker (preset chips +
  free text); resolution is optimistic and then reconciled via `notification:action`.
- **Tasks** — a three-column board (Open | Snoozed | Done-this-week) with a detail pane.
  `TaskBoardViewModel` partitions and sorts the board, drives the sidebar pending badge, and
  reconciles the detail pane when a selected task changes. Task detail shows history, past
  surfaces, and linked decisions/project.
- **Team** — a force-directed people graph (draggable, positions persisted to `UserDefaults`) with
  filters (group, cadence, source) and a Tier-2 toggle; a person-detail pane with cadence health,
  topics, open requests, and mute/promote/demote actions.
- **Projects** — a project list + rollup: open tasks, decisions (with participants/linked tasks),
  people involved (clickable through to Team), week stats (commits, PRs, messages, decisions), and
  a blocker banner.
- **Activity Monitor** — the flight recorder: tabs for Ticks, Errors, Memory, Claude calls, Files,
  and Sources, each bound to its activity stream. The Ticks tab shows candidate in/out counts, the
  filter log, per-task judgments, reasoning, model, and estimated cost.
- **Skills** — list grouped by trigger mode, a detail/run pane with a dynamically-built input form
  and streaming output.
- **Config** — a markdown editor per file with validation, last-loaded timestamp, and a
  snapshot/restore pane.
- **Settings** — Models (provider/model per task), Chat, Notifications (thresholds, quiet-hours
  bypass), Filesystem, Loop, Sources (connect/fire), MCP (status/toggle/reconnect), Privacy
  (7-day send stats + private-mode toggle), About.

### System integrations (`System/`, `Notifications/`)

- **NodeProcessManager** — spawn/supervise/restart the agent (backoff).
- **KeychainManager** — API keys and secrets under `com.maxo.assistant`, injected into the agent
  at spawn; never written to disk.
- **NotificationManager / NotificationActions** — `UNUserNotificationCenter` categories
  (`PROACTIVE_TASK`, `AGENT_ERROR`, `CLIPBOARD_TASK`) with action buttons (snooze 3d / mark done /
  open); a Focus-aware threshold (normal ≥ 7, focus ≥ 9) suppresses low-value nudges during Do Not
  Disturb; actions emit `notification:action` back to the agent.
- **ClipboardWatcher** — polls the pasteboard (~1.5 s), emits task-like candidates (20–2000 chars).
- **FloatingChatWindowController + ShortcutManager** — a global hotkey (⌘⇧Space) toggles a
  floating, all-Spaces chat panel; the same infrastructure backs the Quick Capture panel
  (glassmorphic `NSPanel`) with on-device `VoiceCapture` (Speech framework — no audio leaves the
  Mac).
- **FSEventWatcher** — watches the config directory and reports changes for hot-reload.
- **LoginItemManager** — launch-at-login via `SMAppService`.

### Onboarding

A six-step wizard (welcome → API keys → user profile → team → projects → complete). On finish, a
`ConfigFileWriter` bootstraps the config files and sets `onboardingComplete`. *(Note the config
format seam in §24.)*

---

## 14. Design system

A dark-only, token-driven system (`DesignSystem/`) built for consistency and accessibility.

- **Color** (`AppColor`) — backgrounds `bg #0F0F11` / `surface #161618` / `surfaceElevated
  #1F1F23` / `surfaceHover`; borders at 5–8% white; brand accent violet `#7C3AED` (+ `accentMid`,
  `accentSoft`); text primary/secondary/tertiary/muted; semantic `success #22C55E`, `warn
  #F59E0B`, `danger #EF4444`.
- **Type** (`AppFont`) — 10 scales: `displayTitle` 20, `sectionTitle`/`cardTitle`/`body` 13,
  `metadata` 11, `code` 12 mono, `statValue` 28, plus nav/chip scales.
- **Metrics** — `AppSpacing` (2→32), `AppRadius` (4→12, `pill` 999), `AppShadow` (none/low/medium/
  high, color-scheme-aware), `AppDuration` (snappy .15 → meditative .6), `AppOpacity`.
- **Components/modifiers** — `LoadState<T>` (idle/loading/loaded/failed) drives every async view;
  `Skeleton` (shimmer), `ErrorState`, `EmptyState`, `Card`, `StatusPill`, `SectionHeader`, `Glass`;
  `MarkdownText` renders block-level markdown natively (headings, lists, code, quotes, tables) with
  inline bold/italic/code; `CanvasView`/`CanvasNode` render A2UI docs (§15).
- **Accessibility-first** — labels/hints on interactive elements, `accessibilityElement(.combine)`
  for composites, Reduce-Motion guards on every animation/shimmer/pulse, Dynamic-Type-friendly
  fonts, and VoiceOver rotor structure on canvas nodes.

Data flow pattern: user action → view-model method → `ipc.emit(type, payload)` → agent processes
and broadcasts → view-model updates `@Published` state → SwiftUI re-renders. High-frequency streams
(agent status, ticks) are debounced; long lists use `LazyVStack`.

---

## 15. Canvas (A2UI)

Canvas is a JSON-based UI format the model can emit inside chat for spatial layouts — meeting-prep
cards, decision trade-offs, briefings, rollups.

- **Instructions** (`canvas/instructions.js`) are injected into the chat system prompt: when to use
  canvas (briefings, decisions, multi-entity rollups, one urgent callout) and when *not* (plain
  Q&A/prose), plus the component palette — containers (`stack`, `columns`, `grid`, `card`), leaves
  (`text`, `markdown`, `callout`, `divider`), domain nodes (`timeline`, `fields`, `stat`,
  `personChip`, `taskItem`, `badge`, `progress`), and `button` actions (`prompt` | `ipc` | `link`).
- **Limits:** depth ≤ 6, ≤ 80 nodes, ≤ 8 buttons, value ≤ 2000 chars, label ≤ 120.
- **Extraction** (`stream-filter.js`) pulls a ```canvas fenced JSON block out of the stream.
- **Validation** (`validator.js`) is pure and never throws: it sanitizes depth/count, clamps
  strings, validates action shapes (link URLs must be http/https), and returns a sanitized doc plus
  a warnings list. Fixtures live in `canvas/__fixtures__/`.
- The Swift `CanvasView` renders the doc; buttons fire `canvas:action` back over IPC. A pending
  placeholder ("composing view…") shows until the block resolves.

---

## 16. Skills system

Skills are prompt-template capabilities discovered from
`~/Library/Application Support/Assistant/skills/` (bundled skills in `agent/skills/bundled/` are
copied on first run; hot-reloaded via `fs.watch`).

- Each skill is a directory with a `skill.md` manifest (name, description, version, trigger mode,
  preferred model, filesystem read/write, MCP servers, input vars) and an optional `prompt.md`
  template.
- `SkillRegistry` (`skills/index.js`): `init`, `list`, `get`, `run(id, input, {onChunk})`. The
  runner renders `{{var}}` placeholders and routes through `router.call('skill_default', …)` with
  the skill's model + MCP scope, streaming chunks to the UI.

---

## 17. Security, privacy & data at rest

- **Field-level encryption** (`security/cipher.js`) — AES-256-GCM (12-byte IV, 16-byte tag),
  stored as `enc:v1:<base64>`. The `ENCRYPTED_COLUMNS` set covers `description`, `raw_text`,
  `content`, `rationale`, `agent_output`, `user_fix`, `generalization`, `summary`, `snippet`.
  Decryption is automatic on read (`_get`/`_all`) and migration-safe (legacy plaintext passes
  through unchanged). 19 cipher tests cover round-trip, unicode, wrong-key rejection, and
  idempotency.
- **Key management** (`security/keychain.js`) — the encryption key and volume passphrase live in
  the macOS Keychain under service `com.botito.agent` (accounts `encryption-key-v1`,
  `volume-passphrase-v1`). No key → the agent runs with an ephemeral key (writable but
  unencrypted), degrading rather than failing.
- **Encrypted volume** (`security/secure-volume.js`) — an `hdiutil` AES-256 sparse bundle (~200 MB)
  mounted at boot on macOS for the raw log/transcripts; skipped gracefully off-macOS. Warm CLI
  sessions deliberately stay in the CLI's own config dir (see §9) so auth survives.
- **Privacy** (`privacy/stats.js`) — tracks LLM call **counts** by `provider × task_type × date`
  (never content), in a rolling 7-day window backed by the `privacy_stats` table, surfaced in the
  Settings → Privacy panel. **Private mode** (with optional expiry) suppresses proactive ticks and
  downgrades extraction to bare interactions.
- **In transit** — inference goes only to the local Claude Code / Codex subprocesses, which use
  the user's own OAuth/subscription. No botito-operated cloud relay. Tokens live in Keychain.

---

## 18. Backup & recovery

`backup/snapshots.js` uses SQLite `VACUUM INTO` (online, non-locking) to write
`memory-YYYYMMDD-HHmmss.db` snapshots to `~/Library/Application Support/Assistant/backups/`,
retaining 14 and pruning the rest. Scheduled nightly at 02:00 via `setTimeout` + `unref()` (so it
never blocks shutdown), and triggerable on demand via `backup:run-now`. The raw log (encrypted) is
the deeper recovery primitive — a `scripts/recover-from-raw-log.js` path exists to rebuild state by
replay.

---

## 19. Budget & cost control

Subscriptions are rate-limited, not per-call-billed, so `models/budget.js` tracks **daily call
counts per provider**, split into two pools so ingestion can't starve interactive chat:

- **Pools:** `ingestion` (extraction/classification/ingest) vs `assistant` (chat/judgment/skills).
- **Limits** (from `available-models.json`): claude-code `{heavy 200, light 1500}`, codex
  `{heavy 80, light 500}`; effective cap = `min(heavy, light)`.
- **API:** `recordCall(provider, pool)`, `getTodayCalls`, `getPoolCalls`, `isOverCap`, `isNearCap`
  (≥ 80%), `remaining`. Stored in `provider_calls (provider, pool, date, calls)`, resetting at
  user-local midnight.
- **Behavior at pressure:** near-cap flips the ingestion classifier to strict mode; over-cap stops
  new ingestion extraction while chat continues. The router records every call and publishes it to
  the activity bus.

---

## 20. Observability

Everything is observable. A singleton **activity bus** (`activity/bus.js`, an EventEmitter)
receives `publish(source, type, payload)` from every module and returns a structured
`{ ts, source, type, payload }`. The IPC server subscribes and forwards to the Swift Activity
Monitor. Event types include `integration`, `error`, `claude-call` (task, model, provider, tokens,
latency, estimated cost), `config`, `memory`, `tick`, `source-fire`, and `agent` status. Tick
history persists to `tick_log` for post-restart review.

---

## 21. Data model reference

SQLite at `~/Library/Application Support/Assistant/data/memory.db`. 12 migrations
(`001_initial.sql` … `012_tasks_done_at.sql`); `001–002` are idempotent (`IF NOT EXISTS`), `003+`
are version-tracked. ~21 tables:

**Core entities**
- `people` — id, name, name_lower, slack_handle, email, tier, cadence, weight, last_interaction_at,
  muted_until, source, vec_doc_id, timestamps. (Materialized from `TEAM.md`.)
- `tasks` — id, description*, raw_text*, source, source_ref, status (`open|snoozed|done|merged|
  cancelled|archived`), priority (1 HIGH / 2 NORMAL / 3 LOW), requested_by → people, project_id,
  due_date, snooze_until, done_at, created_at, updated_at, surface_count, last_surfaced_at,
  vec_doc_id. `UNIQUE(source, source_ref)`.
- `projects` — id, name, description, status, timestamps.
- `decisions` — id, description*, rationale*, source, source_ref, project_id, decided_at, status,
  superseded_by, vec_doc_id.
- `interactions` — id, person_id, source, kind, direction, occurred_at, thread_ref, raw_log_id,
  snippet*.
- `calendar_events` — id, event_id, start_at, end_at, title, location, attendees, description
  (migration 007).

**Conversation & sessions**
- `chat_turns` — id, session_id, role, content*, attachments, ts (+ meta, migration 008).
- `sessions` — id, kind, provider_name, provider_session_id (migration 009), created_at,
  last_active_at, summary*, status.

**Audit / tracking**
- `task_history` — task field-change log (field, old→new, changed_by, changed_at).
- `proactive_log` — surfaces: task_id, surface_kind, message, surfaced_at, response_type,
  response_reason (migration 011), response_at, trigger, score.
- `tick_log` — per-tick record (trigger, candidates in/out, decided action, reasoning, duration).
- `corrections` — agent_output*, user_fix*, generalization*, domain, source_event.
- `retros` — stored weekly retros.

**Meta / config / vectors**
- `schema_migrations` — applied migration versions.
- `raw_log` — id, type, source, kind, actor, body*, ts, captured_at; `UNIQUE(source, id)`.
- `source_check_log` — per-source last-check + counts (migration 004).
- `privacy_stats` — provider × task_type × date call counts (migration 005).
- `provider_calls` — budget counters (provider, pool, date, calls).
- `embedding_cache` — cached embeddings.
- `vec_memories`, `vec_people` — `sqlite-vec` virtual tables (migration 002).

`*` = encrypted at rest.

---

## 22. Build, run & test

From the `Makefile`:

| Command | Effect |
|---|---|
| `make build` | Build the Swift app (Debug) |
| `make run` | Build and launch |
| `make restart` | Stop → rebuild → launch |
| `make stop` | Kill app + agent |
| `make status` | Current status |
| `make agent` | Run the Node agent standalone (stdout visible) |
| `make tail-tick` / `make tail-raw` / `make logs` | Tail tick / raw / both logs |
| `make test` | Run the Node test suite (`node --test`) |
| `make socket` | Quick IPC check |
| `make clean` | Remove DerivedData + sockets (SQLite/logs preserved) |

Node ≥ 22.5. Runtime deps: `better-sqlite3`, `chokidar`, `dotenv`, `nanoid`, `node-cron`; optional
`@anthropic-ai/sdk`, `openai`, `sqlite-vec`. The Swift app injects `SOCKET_PATH`, `SKILLS_PATH`,
`DATA_PATH`, and Keychain-sourced tokens into the agent at spawn. ~50 Node test files cover the
pipeline, heuristics, router, budget, content-blocks, canvas validator, config + watcher, skills,
sessions (incl. a live warm-session integration test), memory, migrations, cipher, and privacy.

---

## 23. Roadmap & current state

The original plan (`implementation-plan.md`) defined phases 0–8; the code has moved past the
plan's snapshot. **Ground truth from git** (96 commits, May 24–Jun 30 2026): the proactive loop is
wired and running (`loop.start()` in `index.js`), the session-manager harness is committed and
proven live, chat is a single continuous thread, proactive card actions + dismiss-with-reason
feedback ship, source ingestion runs through MCP, and a multi-phase **proactivity overhaul** (real
task reminders, sharper judgment, allowlist scoping, visibility, done-task fixes, meeting-prep
nudge, cadence-drift cap, calendar decrypt fix) is landed on the current branch.

Delivered (by phase intent): schema + scaffolding + IPC + budget (0); memory + config + Slack (1);
proactive loop + calendar (2); Swift shell + IPC + Activity Monitor (3); chat + tasks + multimodal
+ team/project views (4); config editors + settings + onboarding (5); subscription-provider
migration (5.5); Gmail/Jira/GitHub ingestion via MCP/CLI (6); runtime wire-up (6.5); plus the
security/backup/privacy hardening originally scoped for phase 8 (cipher, Keychain, encrypted
volume, `VACUUM INTO` backups, privacy stats).

The living backlog (`BACKLOG.md`) tracks the next increments: richer Activity "Trace" tab (many
bus event types still silent to the UI), fully wiring the classifier+heuristics into the live
ingest path, urgent-inbound trigger polish, persistent-mind judgment tuning, notification-dismiss
persistence, and content curation of `HEARTBEAT.md`/`CONTEXT.md`.

---

## 24. Constraints, non-goals & known seams

**Constraints**
- **Acme security:** no mobile app, no cloud relay of company data. Inference only via
  local subscription-backed CLIs; secrets only in Keychain.
- **macOS-only (v1):** SwiftUI + AppKit-specific (FSEvents, Keychain, notifications).
- **Single-user, single-machine:** no multi-device sync (the raw log is the future sync primitive).

**Non-goals:** multi-user/SaaS, mobile, a Jira/Notion replacement, a voice-first interface,
cross-device sync, cross-workspace federation.

**Known seams (code reality worth flagging):**
- *Config format:* the runtime config system reads **markdown** (`.md`) from `$BOTITO_CONFIG_ROOT`,
  while the Swift onboarding `ConfigFileWriter` was observed writing YAML to `~/.assistant/config/`.
  These two need to agree; the markdown loader is the source of truth the agent actually consumes.
- *MCP vs. native adapters:* both a native `SourceAdapter` path (standalone tokens) and an MCP
  ingest path (`router.call('*_ingest')`) exist for Slack/Calendar; the packaged app uses the MCP
  path because it has no standalone tokens.
- *Session storage:* warm CLI sessions intentionally live outside the encrypted volume to preserve
  CLI auth — transcripts-in-volume is future work.

---

## 25. Glossary & key constants

- **Tier 1 / Tier 2** — a person's ingestion privilege, set by weight in `TEAM.md`. Tier 1 =
  full extraction; Tier 2 = interaction-only.
- **Surface** — a single proactive notification about a task, recorded in `proactive_log`.
- **Tick** — one run of the proactive loop.
- **Sealing** — invisibly closing a chat session (idle gap) while the user still sees one thread.
- **Persistent-mind** — judgment running as a warm session that remembers across ticks.
- **StopLevel** — pipeline outcome: `SHALLOW` / `STORE_AS_INTERACTION` / `EXTRACTED` / `DUPLICATE`.

| Constant | Value |
|---|---|
| Heartbeat interval | 20 min |
| Quiet hours | 22:00–08:00 |
| Active days | Mon–Fri |
| Surfacing threshold | 7 / 10 |
| Max surfaces per task | 3 |
| Max proactive per hour | 2 |
| Min gap between nudges | 30 min |
| Max snoozes per tick | 8 |
| Surface cooldowns | count 1 → 48h, 2 → 96h, 3+ → 7d |
| Preferred windows | 09:00–11:00, 14:00–16:00 |
| Response window | 24 h |
| Resolution sweep | every 5 min, ≤ 5 checks, 10-min/task cooldown |
| Working memory | ~30 min, ~500 entries |
| Vector half-life | 30 days |
| Warm-session idle TTL | 30 min |
| Judgment reseed | ~50k tokens or daily |
| Source intervals | Slack 10m · Gmail 30m · GCal 60m · Jira/GitHub 120m |
| Budget caps | claude-code min(200,1500) · codex min(80,500) per day |
| Backup | `VACUUM INTO`, 14 kept, 02:00 |
| Encryption | AES-256-GCM, `enc:v1:` prefix, key in Keychain `com.botito.agent` |
| IPC socket | `~/Library/Application Support/Assistant/agent.sock` |
| Default chat model | claude-code / `claude-sonnet-4-6` |

---

*Compiled 2026-07-04 from the botito source tree and its design docs. Where design intent and code
diverged, this document follows the code.*
