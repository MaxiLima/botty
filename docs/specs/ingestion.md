# Ingestion — adapters, scheduler, funnel

Location: `packages/agent/src/ingest/`. Fetching is deterministic code; the LLM only appears at
funnel steps 4–5.

## Normalized event

Every adapter emits `SourceEvent` (zod schema in `@botty/shared`):

```ts
{
  source: 'slack'|'gmail'|'gcal'|'jira'|'github',
  externalId: string,        // stable upstream id → raw_log dedup
  kind: string,              // slack: dm|mention|channel · gmail: email · gcal: event
                             // jira: issue · github: pr|issue
  actor: { handle?: string, email?: string, displayName?: string },
  direction: 'inbound'|'outbound',  // default inbound; outbound = sent BY the user
  text: string,              // subject+body / message text / issue title+body
  threadRef?: string,
  occurredAt: string,        // ISO
  meta: Record<string, unknown>   // source-specific extras (attendees, labels, url, status)
}
```

## SourceAdapter contract

```ts
interface SourceAdapter {
  readonly source: SourceId;
  /** Fetch events newer than `since` (ISO). Must be idempotent; dedup happens downstream. */
  fetch(since: string | null): Promise<SourceEvent[]>;
}
```

Two driver families per source, selected by `BOTTY_MODE`:
- **sim** (v1 ships all five): thin HTTP clients against `@botty/sim` (see `specs/simulator.md`).
- **real** (M4): claude.ai MCP connectors (Slack/Gmail/GCal) read through the Agent SDK — a
  fetch-only, structured-output SDK call per poll that returns normalized `SourceEvent`s;
  Jira/GitHub via REST/CLI. Same contract, drop-in. Unlike botito, the MCP read is confined to
  `fetch()` — dedup/funnel/extraction stay deterministic and raw-logged.

## Scheduler

`SourceScheduler` polls each enabled source on its interval from `HEARTBEAT.md`
(defaults: slack 10m, gmail 30m, gcal 60m, jira 120m, github 120m; in sim mode default all to
60s so demos feel live). Staggered start (~5 s apart), respects quiet hours only for *surfacing*
(polling continues). Each run: `fetch(since)` → pipeline per event → write `source_check_log` →
WS `source.checked`. `since` = last successful check per source (persisted in `settings`).
`POST /api/sources/:source/check-now` triggers one immediately.

Special handling:
- **gcal**: events upsert into `calendar_events` (not tasks) and are ALSO raw-logged. Events
  starting within 60 min with a Tier-1 attendee raise a `meeting_prep` candidate for the loop.
- **jira/github**: assigned items upsert tasks directly (they're already structured — skip the
  classifier/extractor; `source_ref` = issue key / PR ref; status sync: upstream closed ⇒ task
  done via `task_history` changed_by='funnel').

## The funnel (slack, gmail; chat/manual capture bypasses to step 5)

Per event, in order — cheap kills first:

1. **Raw log** (always): insert into `raw_log`; `UNIQUE(source, external_id)` conflict ⇒ stop
   (`DUPLICATE`).
   - **Outbound** (the user's own reply in a thread, `direction: 'outbound'`) stops here:
     `interactions` row with direction outbound, stamped `INTERACTION_ONLY {outbound: true}`.
     Never classified/extracted — you don't ask yourself for things. Raw-logged under its
     `threadRef` so the resolution sweep (loop.md) can read "review done" as completion
     evidence.
2. **Tier check**: resolve actor against `people` (slack_handle/email/name). Tier 2 or unknown ⇒
   insert `interactions` row, stop (`INTERACTION_ONLY`). Unknown actors with ≥5 interactions in
   14 days are flagged in the people page as promotion candidates.
3. **Heuristic gate** (regex, conservative — false positives OK): task signals ("can you",
   "please", "?", "by <weekday>", "blocked on", "waiting on", "remind me", "follow up", "asap",
   "before the meeting"), decision signals ("we decided", "going with", "agreed to",
   "approved", "signed off"), commitment signals ("i'll", "i will", "on my list", "i own").
   No signal ⇒ `interactions` row, stop (`NO_SIGNAL`).
4. **Classifier** (`llm.structured`, task `classification`): schema
   `{ worthExtracting: boolean, confidence: number, reason: string }`. False ⇒ `interactions`
   row, stop (`CLASSIFIED_OUT`). LLM failure ⇒ degrade to extracting (heuristics already passed).
5. **Extractor** (`llm.structured`, task `extraction`): schema
   `{ tasks: [{description, requesterName?, dueDate?, priority?, owner?}], decisions:
   [{description, rationale?}], people: [{name, slackHandle?, email?}] }`. `owner` (`'me'|'them'`,
   optional — defaults to `'me'` at persist time in `ingest/funnel.ts`'s `persistExtraction`) tells
   apart the user's own to-do from the *other* person's stated promise to the user
   (e.g. "I'll send you the latency doc tomorrow" ⇒ `owner: 'them'`, a "waiting on `<them>`"
   reminder, not a task instructing the user to send the doc — see migration 006 in
   `specs/data-model.md`). Persist order: people (upsert by
   name_lower) → tasks (priority 1 if requester Tier 1; `source_ref` = threadRef||externalId;
   UNIQUE dedup) → decisions. Also insert an `interactions` row for the actor. Outcome
   `EXTRACTED`.
   - **Dedup slots**: the first task/decision in a thread takes the base ref; additional
     *distinct* items claim `#n`-suffixed slots (`<ref>#2`, `#3`, … tasks; `<ref>#d2`, …
     decisions). On a `UNIQUE(source, source_ref)` conflict, an identical re-send (repeated
     nag — same raw text) dedups against the existing slot; a genuinely new item in the same
     thread moves on to the next free suffix. The resolution sweep strips the suffix to
     recover the thread ref.

Every event's outcome (`FunnelOutcome` = DUPLICATE | INTERACTION_ONLY | NO_SIGNAL |
CLASSIFIED_OUT | EXTRACTED | ERROR) is stored in `raw_log`-adjacent memory? No — outcome +
stage details go into the classifier/extractor `ai_decisions.related_ref` and a `funnel` field
inside `raw_log.body.meta.funnelOutcome` updated post-processing, so the Inspector can answer
"why didn't this become a task?" for every raw event.

`ERROR` is not terminal: an errored event is never refetched (raw_log dedup + advanced `since`
cursor), so each source check also runs `retryErroredEvents` — it re-runs steps 2–5 for
ERROR-stamped `raw_log` rows (the row body stores the full serialized `SourceEvent`), bounded
by `MAX_EXTRACTION_ATTEMPTS = 3` per event, so a transient LLM outage can't permanently drop a
Tier-1 ask.

Also: index extracted tasks/decisions and interaction snippets into `memory_fts`.

## Manual capture

`POST /api/chat/message` content is normal chat; the chat system prompt instructs the model to
call a `capture_task` tool (SDK custom tool) when the user asks to track something — the tool
handler writes the task directly (source `chat`). Keep this minimal in v1.

## Chat tools

Location: `packages/agent/src/chat/tools.ts` (`createChatTools`). Four model-callable SDK custom
tools available on every chat turn (external MCP tools from `mcp.json` are additional and
per-turn-derived — see `specs/mcp.md`). Each is a never-throwing `ChatToolSpec`: a bad call or a
missing id comes back as `{ error }` data rather than killing the turn; the SDK wrapping
(`tool()` + `createSdkMcpServer()`) lives in `llm/sdk.ts`, and the mock LLM invokes `execute()`
directly.

| Tool | Purpose |
|---|---|
| `capture_task` | Create a tracked task from the conversation (source `chat`, `source_ref` a fresh `chat:<nanoid>` so dedup never applies). Mirrors the funnel's requester resolution: a known name → that person, a new name → `upsertDiscoveredPerson`. |
| `task_action` | Act on an existing task by id: `done`\|`snooze`\|`dismiss`\|`reopen`\|`priority` — mirrors the switch in `POST /api/tasks/:id/action` (`changedBy: 'chat'`). `snoozeUntil` (exact wall-clock instant, ISO with offset) takes precedence over `snoozeDays` for "until tomorrow 9am"-style requests. |
| `memory_search` | Full-text search over tasks/decisions/interactions/chat via `Memory.search` — recall past work or find a task id. |
| `session_search` | Recall past chat conversations: `mode: 'search'` (FTS over old turns), `'recent'` (list sessions + summaries), `'browse'` (page through one session's turns by offset/limit). |

Every task-board write (`capture_task`, `task_action`) broadcasts the same full open-board
`tasks.updated` snapshot that `POST /api/tasks/:id/action` does (`db.listTasks('open')`) — chat
writes and REST writes stay indistinguishable to WS consumers.
