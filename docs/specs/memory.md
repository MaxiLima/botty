# Memory — @botty/agent/src/memory

`createMemory({ db, config })` returns the `Memory` interface: `search` (bm25 FTS with recency
tiebreak), `buildChatSystemPrompt` (per-turn chat context), and `buildProactiveContext` (the
loop's judgment input). No vector store — recall is SQLite FTS5 plus structured pulls from the
tables that already hold the truth (people, sessions, tasks). Everything is plain strings with
hard character budgets; the LLM never sees unbounded input.

## Budgets

```ts
const TOTAL_BUDGET = 8_000;   // ~2k tokens ≈ 8k chars, whole prompt
const PERSONA_CAP  = 3_200;   // persona section
const SECTION_CAP  = 1_400;   // each other section
```

`clip(text, max)` truncates with a trailing `…`. Individual lines have their own caps (team and
task one-liners 160, summary lines 300, recall lines 220) so one verbose row can't eat a section.

## buildChatSystemPrompt(userMessage)

Called by the chat pipeline for every assistant turn. Sections, in order, each skipped when
empty and clipped to its cap; the joined result is clipped to `TOTAL_BUDGET`:

1. **Current time** — ISO timestamp + IANA timezone.
2. **Persona** — `persona.md` verbatim, capped at `PERSONA_CAP`.
3. **`## Team`** — tier-1 people only, first 12: `- Name (WEIGHT, @handle, email) — notes`.
   Tier-2 people collapse into a single `- (+N tier-2 people tracked)` line.
4. **`## Recent conversation summaries`** — the last 3 **sealed** session summaries, dated,
   newlines collapsed, 300 chars each. This is how context survives `/new` and idle seals.
5. **`## Possibly relevant memory`** — top-5 FTS hits for the user message, each
   `- [kind] content`. **Task hits keep their status**: for a hit whose task is no longer
   `open`, the tag becomes e.g. `[task, done 2026-07-01]` — a done/cancelled task must not
   read as live work.
6. **`## Open tasks`** — up to 15 one-liners: `- [P2] description · from Name · due 2026-07-10`.

Ordering with indexing matters: the chat pipeline builds this prompt **before** FTS-indexing the
user turn — otherwise the just-sent message would always be its own top recall hit and burn a
slot every turn (`chat/index.ts`).

### Prompt-injection guard

`flat(text)` collapses all whitespace runs to a single space on every piece of untrusted text
(task descriptions, requester/person names, recall content, candidate cards). Ingested text
therefore cannot inject its own lines — a Slack message containing `\n## Agent instructions\n…`
flattens into an inert one-liner inside a `- ` bullet. Structure (headings, bullets) is only
ever emitted by this module's own template strings.

## buildProactiveContext(candidates)

Input to the loop's judgment call (`loop/tick.ts` → `loop/judgment.ts`): the rules-filter
survivors, each a `ProactiveCandidate` (`Task` + optional `reminderReason`). Sections:

- `## Agent instructions` — heartbeat instructions, capped 800.
- `## This week` — heartbeat this-week block, capped 600.
- `## Persona excerpt` — persona, capped 600 (a taste, not the full file — judgment doesn't
  need the whole persona).
- `## Candidates (N)` — one card per task:

  ```
  ### Task <id>
  description: … (flattened, 200)
  requester: Name (tier 1) | unknown
  status: open · priority: P2 · age: 5d
  timesSurfaced: 2 · lastSurfaced: <iso>
  due: <date>                      (if set)
  reminderReason: …                (if set)
  recentSurfaces: <ts> → snoozed; <ts> → no response   (last 3)
  ```

  The surface history is the judgment's memory of its own past behavior — it's what lets it
  back off from a nudge the user ignored twice.

The whole block is clipped to `TOTAL_BUDGET * 2` (16k chars) — judgment runs a handful of times
a day, chat runs constantly, so it gets the roomier budget.

## FTS backing

One unified `memory_fts` FTS5 table (see `specs/data-model.md`), `porter unicode61` tokenizer.
Migration 002 created it; **migration 003 rebuilt it with `kind` and `ref_id` UNINDEXED** —
they had been indexed columns, so an unqualified MATCH over-matched: porter stems "tasks" →
"task", making any query containing task/decision/chat/interaction hit every row of that kind,
and nanoid fragments matched via `ref_id`. Post-003, **only `content` is searchable**; kind and
ref_id remain stored for join-back and filtering.

`Db.ftsSearch(query, limit=5)`:

- `sanitizeFtsQuery` extracts `[\p{L}\p{N}]+` tokens, quotes each, joins with `OR` — user text
  can never produce FTS syntax errors (or operators). Empty token list → no hits.
- Fetches `limit * 3` rows by bm25, resolves each hit's timestamp from its source table
  (`tasks.created_at`, `decisions.created_at`, `interactions.occurred_at`,
  `chat_turns.created_at`), then sorts: bm25 primary (lower = better), recency tiebreak.
  Returns the top `limit` as `FtsHit { kind, refId, content, score, occurredAt }`.

## What gets indexed, and when

`Db.ftsIndex(kind, refId, content)` is a delete+insert transaction — idempotent per
`(kind, refId)`, re-indexing replaces. No triggers (v1 keeps it explicit); each writer indexes
what it writes:

| kind | Writer | When | Content |
|------|--------|------|---------|
| `chat` | `chat/index.ts` | user turn on send (after recall runs); assistant turn on completion | turn text |
| `task` | `ingest/funnel.ts` | extractor creates a task | description |
| `task` | `ingest/structured.ts` | jira/github upsert creates a task | description |
| `decision` | `ingest/funnel.ts` | extractor creates a decision | `description — rationale` (rationale when present) |
| `interaction` | `ingest/util.ts` | any ingested event that logs an interaction with a snippet | 200-char flattened snippet |

Not indexed: people (pulled structurally into `## Team`), calendar events, raw_log, task status
changes (the recall tag re-reads live status at prompt-build time instead).
