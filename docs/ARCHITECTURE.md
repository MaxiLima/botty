# botty — Architecture

How the pieces fit together, with diagrams that follow the actual code. File paths refer to
`packages/…`. Companion docs: `SPEC.md` (what and why), `docs/specs/*` (per-subsystem contracts),
`TESTING.md` (how to exercise all of this).

## 1. System overview

One daemon, two first-class clients. In normal use that's the agent plus whichever clients you
open — the web SPA in a browser and/or the `@botty/tui` terminal client; the simulator is a
third process in dev/test only.

```mermaid
flowchart LR
    subgraph browser [Browser]
        UI["@botty/web SPA<br/>Chat · Tasks · People · Inspector · Costs · Config"]
        PANEL[Sim control panel]
    end

    subgraph term [Terminal]
        TUI["@botty/tui<br/>Ink chat client"]
    end

    subgraph agentproc ["@botty/agent — the daemon (:4820)"]
        SERVER[server/<br/>REST + WS + static<br/>guards.ts: local-only Host/Origin]
        CHAT[chat/]
        LOOP[loop/<br/>proactive loop]
        INGEST[ingest/<br/>adapters + funnel]
        MCP[mcp/<br/>external MCP tools<br/>+ consent gate]
        LLM[llm/<br/>LlmClient]
        MEM[memory/<br/>Memory]
        CFG[config/<br/>persona · team · heartbeat · mcp.json]
        BUS([bus — typed events])
        DB[(SQLite<br/>~/.botty/data/botty.db)]
    end

    subgraph simproc ["@botty/sim (:4821, dev only)"]
        SIM[fake slack/gmail/gcal/jira/github<br/>+ scenario engine]
    end

    CLAUDE[Claude Agent SDK<br/>→ user's Claude subscription<br/>+ claude.ai MCPs in real mode]
    MCPSRV[user-configured external<br/>MCP servers, stdio]
    MAC[macOS Notification Center]

    UI <-->|"REST /api/* + WS /ws"| SERVER
    TUI <-->|"REST /api/* + WS /ws"| SERVER
    PANEL --> SIM
    INGEST -->|"HTTP fetch(since)"| SIM
    SERVER --> CHAT & LOOP & INGEST
    CHAT & LOOP & INGEST --> LLM
    CHAT --> MEM
    CHAT --> MCP
    MCP -->|"read: mid-turn · action: queued, executes only on approval"| MCPSRV
    LLM --> CLAUDE
    CHAT & LOOP & INGEST & CFG -.->|emit| BUS
    MCP -.->|"action.pending / action.resolved"| BUS
    BUS -.->|fan-out| SERVER
    LOOP --> MAC
    CHAT & LOOP & INGEST & MEM & LLM & MCP --> DB
    CFG --> DB
```

Key properties:

- **One brain, one DB.** Everything stateful lives in SQLite; the UI is a thin typed client.
- **The bus is the only path to the UI.** Modules never talk to WebSocket clients directly; they
  emit typed `WsEvent`s on the bus (`agent/src/bus/`), the WS hub (`server/ws.ts`) fans out.
- **The LLM is behind one interface.** `LlmClient` (`llm/types.ts`) is the only thing that knows
  the Agent SDK exists. `BOTTY_MOCK_LLM=1` swaps in a deterministic mock.
- **Every AI call leaves a trace.** All `structured()`/`chatTurn()` calls write an `ai_decisions`
  row (full inputs + output + model + latency) — the Inspector and replay CLI read these.

## 2. Where data lives

```mermaid
flowchart TD
    subgraph sources [Signal sources]
        S1[slack] & S2[gmail] & S3[gcal] & S4[jira] & S5[github]
    end
    RAW[(raw_log<br/>append-only ground truth<br/>UNIQUE source+external_id)]
    TASKS[(tasks)] --- HIST[(task_history)]
    PEOPLE[(people<br/>materialized from team.md)]
    INTER[(interactions)]
    DECIS[(decisions)]
    CAL[(calendar_events)]
    CHATT[(chat_turns)] --- SESS[(sessions)]
    PLOG[(proactive_log<br/>every surface + user response)]
    TLOG[(tick_log)]
    AID[(ai_decisions<br/>every LLM call, replayable)]
    FTS[(memory_fts<br/>FTS5 recall index)]

    sources --> RAW --> TASKS & INTER & DECIS & CAL
    TASKS & DECIS & INTER & CHATT --> FTS
    TASKS --> PLOG
    PLOG --> TLOG
```

`raw_log` is the recovery primitive: every normalized inbound event is stored verbatim before
any processing, so the pipeline is re-runnable and every downstream artifact can be traced back
to its source event.

## 3. Ingestion — deterministic fetch, funneled intelligence

Fetching is dumb code; the LLM only appears at steps 4–5, and only for unstructured sources.

```mermaid
flowchart TD
    SCHED[SourceScheduler<br/>per-source intervals from heartbeat.md] --> FETCH["adapter.fetch(since)<br/>sim: HTTP to :4821 · real: claude.ai MCPs via Agent SDK"]
    FETCH --> NORM[normalized SourceEvent]
    NORM --> STRUCT{structured source?<br/>jira / github / gcal}
    STRUCT -- yes --> UPSERT["direct upsert<br/>jira+github → tasks (status sync)<br/>gcal → calendar_events"]
    STRUCT -- "no (slack / gmail)" --> F1

    subgraph funnel [The funnel — cheap kills first]
        F1["1 · raw_log insert<br/>duplicate? → STOP"] -->|new| F2
        F2["2 · tier check vs people<br/>Tier 2 / unknown → interaction only, STOP"] -->|Tier 1| F3
        F3["3 · heuristic regexes<br/>no task/decision/commitment signal → STOP"] -->|signal| F4
        F4["4 · classifier LLM (haiku)<br/>'worth extracting?' no → STOP"] -->|yes| F5
        F5["5 · extractor LLM (haiku)<br/>→ people, tasks, decisions"]
    end

    F5 --> PERSIST[persist: people → tasks → decisions<br/>+ fts index + tasks.updated on bus]
    UPSERT --> PERSIST2[+ tasks.updated on bus]
    F1 & F2 & F3 & F4 & F5 -.->|outcome stamped on raw_log<br/>+ ai_decisions rows| INSPECT[Inspector · Funnel tab]
```

Outcomes: `DUPLICATE` · `INTERACTION_ONLY` · `NO_SIGNAL` · `CLASSIFIED_OUT` · `EXTRACTED` ·
`UPSERTED`. The Inspector's Funnel tab answers "why did/didn't this message become a task?" for
every single raw event — this inspectability is the core fix over botito.

**Real mode (M4):** the sim drivers are swapped for adapters that read sources through the
claude.ai MCP connectors (Slack, Gmail, Google Calendar) via the Agent SDK — no standalone
tokens, no Slack app. The MCP read happens strictly inside `adapter.fetch()`; everything after
normalization (dedup, funnel, extraction, task writes) is the same deterministic, raw-logged
pipeline in both modes.

## 4. The proactive loop — two layers, biased to silence

This is the anti-nagging machinery. A tick fires every 20 min (heartbeat.md) or on demand.

```mermaid
flowchart TD
    TICK["tick (scheduled / run-now)"] --> TIMING{"quiet hours?<br/>inactive day?"}
    TIMING -- yes --> SKIPT[record skipped tick] --> LOG
    TIMING -- no --> EXPIRE[expire surfaces unanswered > 24h] --> GATHER

    GATHER["gather candidates:<br/>DUE_SOON (≤2d) · NEVER_SURFACED (>4h old)<br/>STALE (5d+) · MEETING_PREP (tier-1, ≤60min)"] --> RULES

    subgraph layer1 ["Layer 1 — rules filter (pure code, no LLM, every rejection logged)"]
        RULES["1 cooldown by surface count: 1→48h · 2→96h · 3+→7d<br/>2 hard cap 3 surfaces/task (unless due &lt;48h)<br/>3 snoozed  4 closed  5 quiet hours<br/>6 global gap ≥30min between nudges<br/>7 user chatting in last 2min<br/>8 max 2 proactive/hour  9 requester muted"]
    end

    RULES --> ANY{survivors?}
    ANY -- no --> LOG["tick_log (+ rejection log) → Inspector · Ticks"]
    ANY -- yes --> JUDGE

    subgraph layer2 [Layer 2 — LLM judgment]
        JUDGE["sonnet, structured output, recorded in ai_decisions<br/>actionability gate first · strong bias to skip<br/>respects dismissal history · max ONE notify/tick unless due &lt;24h"]
    end

    JUDGE --> VALID["validate: drop score &lt; 7 · cap snoozes · drop unknown taskIds"]
    VALID --> ACT{actions}
    ACT -- notify --> NOTIFY["proactive_log + surface_count++<br/>WS notification card + macOS banner"]
    ACT -- snooze / priority --> WRITE[task write + task_history]
    ACT -- skip --> LOG
    NOTIFY & WRITE --> LOG
```

And the feedback half — silence is signal:

```mermaid
sequenceDiagram
    participant L as loop (tick)
    participant U as user
    participant RT as response tracker
    participant PL as proactive_log

    L->>U: nudge (WS card + macOS banner)
    L->>PL: surface recorded
    alt user clicks Done / Snooze / Dismiss(+reason)
        U->>PL: response_type = completed / snoozed / dismissed
    else user replies in chat mentioning it
        U->>RT: chat.userMessage (bus)
        RT->>PL: heuristic match → completed / snoozed
    else 24h of silence
        RT->>PL: response_type = expired
    end
    Note over PL,L: next tick's judgment sees this history —<br/>dismissed/expired tasks are not re-notified
```

**Inferred commitments** ride this same tick judgment rather than a separate scheduler: a hidden
post-turn chat pass (`chat/commitments.ts`) notices short-lived follow-ups ("my interview is
tomorrow at 3") and stores them as `commitments` rows — operational state, not tasks, not durable
memory. `loop/commitments.ts` folds due ones into the judgment context (untrusted-content wrapped,
notify-or-skip only) and delivers them through the same notify path above. See `specs/loop.md`.

## 5. Chat — one thread, sessions sealed invisibly

```mermaid
sequenceDiagram
    participant W as web UI
    participant S as server
    participant C as chat service
    participant M as Memory
    participant LL as LlmClient (Agent SDK)
    participant B as bus
    participant D as SQLite

    W->>S: POST /api/chat/message {text}
    S->>C: handleUserMessage(text)
    C->>D: persist user turn
    C->>B: chat.userMessage (feeds response tracker)
    C->>M: buildChatSystemPrompt(text)
    Note over M: persona.md + team summary +<br/>sealed-session summaries +<br/>FTS5 recall hits + open tasks
    C->>LL: chatTurn(sessionKey, prompt, system)
    LL->>D: resume provider session id (if valid)
    loop streaming
        LL-->>B: chat.chunk / chat.thinking / chat.toolUse
        B-->>W: WS fan-out (live render)
    end
    LL->>D: ai_decisions row (chat_turn)
    C->>D: persist assistant turn + FTS index
    C-->>B: chat.done
    Note over C,D: idle > 30 min ⇒ next send seals the session<br/>synchronously (no double-seal); the summary is<br/>generated on the turn queue — not inline in POST —<br/>and lands before the next queued turn's prompt build
```

Resilience in `llm/sdk.ts`: a 120s inactivity watchdog on the SDK stream, and if a *resumed*
session hangs or fails, one automatic retry with a fresh session — but only when the failed
attempt streamed no output (a retry after partial text would duplicate it) and the failure
wasn't the user's own interrupt.

**External MCP tools** are additional chat tools, re-derived every turn from
`~/.botty/config/mcp.json`'s allowlist (`mcp/tools.ts`). `read`-mode tools call straight through
to the MCP server mid-turn like any built-in tool; `action`-mode tools never do — the model can
only enqueue a `pending_actions` row (`mcp/pending.ts`), and the agent's own MCP client only ever
calls the tool on explicit user approval (`POST /api/actions/:id/approve`). See `specs/mcp.md`.

## 6. Notifications — one event, three surfaces

Everything the loop wants you to see flows through a single path:

```mermaid
flowchart LR
    A[loop action: notify] --> P[(proactive_log)]
    B[briefings: morning / evening] --> P
    T[POST /api/notifications/test] --> BUSN
    A & B --> BUSN([bus: notification event])
    BUSN --> WS[WS hub] --> CARD["in-chat notification card<br/>Done · Snooze · Dismiss buttons"]
    A & B & T --> MACOS["macOS banner<br/>terminal-notifier or osascript"]
    CARD -->|action| API["POST /api/tasks/:id/action"] --> P
```

So "botty told me something" always means: a row in `proactive_log` (auditable), a card in the
chat thread (actionable), and a native macOS banner (attention). `POST /api/notifications/test`
fires the whole path with a canned message.

## 7. Config → behavior

```mermaid
flowchart LR
    subgraph files ["~/.botty/config/ (markdown, yours to edit)"]
        P[persona.md<br/>identity · voice · user context]
        T[team.md<br/>people · weights → tiers · cadence]
        H[heartbeat.md<br/>schedule · thresholds · source intervals]
    end
    WATCH[chokidar watcher<br/>500ms debounce, snapshot to archive/] --> files
    P --> CHATP[chat + judgment system prompts]
    T --> PEOPLE[(people table)] --> TIER[funnel tier check]
    H --> LOOPCFG[tick schedule · quiet hours · caps · briefing times]
    H --> SRCCFG[per-source poll intervals]
    files -.->|config.changed| UIREL[UI Config page refresh]
```

`team.md` is load-bearing: it is simultaneously documentation, the ingestion whitelist (weights
CRITICAL/HIGH ⇒ Tier 1 ⇒ full extraction), and the judgment context about who matters.

## 8. Inspectability & tuning loop

```mermaid
flowchart LR
    RUN[live traffic<br/>sim or real] --> AID[(ai_decisions<br/>full inputs + outputs)]
    AID --> INS[Inspector UI<br/>Funnel · Ticks · Decisions · Sources]
    AID --> REP["replay CLI<br/>npm run timewarp / replay -w @botty/agent"]
    REP -->|"--system-file new-prompt.md<br/>--model claude-opus-4-8"| DIFF[diff table: old vs new decisions<br/>recorded as kind ':replay']
    DIFF --> PROMPTS[edit judgment / classifier prompts] --> RUN
```

This closes the loop that botito never had: when a nudge felt wrong or a task was missed, you
can see exactly what the model saw, change the prompt, and re-run the last N *real* decisions
before shipping the change.

`ai_decisions` also prices out spend: `GET /api/costs` (`server/costs.ts`) rolls every call up by
activity category (chat/intake/proactive/resolution/briefing/other) and model, at USD/MTok rates
(overridable via the `llm.pricing` setting), over today/7d/30d/all-time windows plus a 30-day
daily series — rendered as the web **Costs** page and the TUI `/costs` panel.
