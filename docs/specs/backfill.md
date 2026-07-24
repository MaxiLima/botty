# Backfill — one-shot historical ingest (context only)

Location: `packages/agent/src/backfill/` (runner, per-event path, distillation),
`packages/agent/src/server/backfill.ts` (REST), `packages/cli/src/commands/backfill.ts` (`botty backfill`),
`packages/sim/src/engine.ts` `historyFor()` + `GET /:source/history` (sim history serving).
Shipped 2026-07-24.

A fresh install starts with an empty brain: the live scheduler only polls forward from its
`ingest.lastCheck.<source>` cursor, so botty knows no people, no history, no searchable past.
Backfill fixes the cold start: a **manually-triggered, one-shot ingest of the last N days** of
Slack/Gmail/Calendar history that seeds background context.

## What it is / is not

- **Context only — it never creates tasks.** Historical asks are stale; resurrecting them as
  live to-dos would flood the board and the proactive loop. What backfill produces is exactly
  the levers `memory/index.ts` feeds into chat/judgment prompts:
  - `people` — actor discovery (tier 2, `source='discovered'`) + interaction history with the
    event's true `occurred_at` (feeds the ≥5-in-14-days promotion query and
    `last_interaction_at` correctly — both were verified timestamp-safe);
  - `interactions` — FTS-indexed snippets (searchable history via `memory_search`);
  - `calendar_events` — past meetings (harmless to prep queries, which only look forward);
  - `decisions` — distilled from threads by a bounded LLM pass (see below), FTS-indexed,
    `decided_at` = historical event time;
  - discovered-people `notes` — short durable facts from distillation.
- **Manual only.** `botty backfill` (CLI → REST). Not an onboarding step, never automatic.
- **Sources: slack, gmail, gcal** (`BACKFILL_SOURCES` in `@botty/shared`). jira/github are
  excluded on purpose — their structured handler creates tasks. Drive/docs is future work
  (no such source exists in the system yet).
- **Real drivers land at M4.** The real adapter's `fetchHistory` is a throwing stub, same as
  `fetch`. Sim mode works end-to-end today.

## Adapter contract

```ts
interface HistoryPage { events: SourceEvent[]; nextCursor: string | null }
interface SourceAdapter {
  fetch(since: string | null): Promise<SourceEvent[]>;
  /** Optional — an adapter without it cannot backfill. */
  fetchHistory?(opts: { cursor: string | null; oldest: string; limit: number }): Promise<HistoryPage>;
}
```

Pages are newest-first; the cursor is adapter-opaque (sim: engine-minted `"<iso>|<idx>"`;
real M4: Slack cursor / Gmail pageToken). `oldest` (ISO) bounds the window. Refetching a page
is idempotent by construction — `raw_log UNIQUE(source, external_id)`.

Sim serving: scenarios gain a `history` block (`ScenarioEventSchema` with `atMinute < 0` =
minutes before scenario start), materialized at load with stable `<scenario>-hist-<idx>` ids and
served only by `GET /:source/history?cursor=&oldest=&limit=` — never clock-released to pollers.
Fixture: `packages/sim/scenarios/backfill.json` (30 days of Acme-only history).

## Data flow

```
fetchHistory page → per event (backfill/process.ts):
  meta.backfill=true → raw_log (dedup) → find/discover person → interaction (+FTS)
  gcal → handleGcal (calendar_events upsert)                 [no funnel, no LLM, no tasks]
→ distill phase (backfill/distill.ts, slack/gmail only):
  backfilledThreads() newest-first → skip distilled → free decision-signal prefilter
  → one `distill` LLM call per qualifying thread (cap: maxLlmCalls)
  → decisions (source_ref `<thread>#bf<n>`, decided_at = event time, FTS)
  → notes on DISCOVERED people only (team_md notes are owned by TEAM.md and would be
    clobbered by materializePeople) → stamp meta.distilledAt on the thread's newest row
```

The `meta.backfill` marker is set before insert, so it lands in `raw_log.body` and survives
`stampOutcome` (which spreads `event.meta`). Rows stamp `INTERACTION_ONLY` with
`funnelDetail.backfill: true` — the Inspector distinguishes them without widening the frozen
`FunnelOutcome` union.

## Runner (backfill/index.ts)

- **State machine**: `idle → running → done | cancelled | error`. The full `BackfillState`
  blob (per-source cursor/counts + distill progress) is persisted to the agent-owned
  `backfill.state` settings key after every page/LLM call and broadcast as WS
  `backfill.progress`. `backfill.state` is deliberately NOT in `SETTABLE_SETTINGS_KEYS`.
- **Single run at a time** (in-memory guard → `alreadyRunning`); cancel is cooperative
  (checked between pages and LLM calls). A crash mid-run leaves `status: 'running'` in
  settings; the next read lazily normalizes it to `error`.
- **Resume**: `start({resume: true})` on an `error`/`cancelled` state reuses its window and
  per-source cursors; distill resumability comes from the `distilledAt` stamps (finished
  threads are skipped), so no thread list lives in the blob. `error` on all requested
  sources ⇒ run status `error`, otherwise `done`.
- **Caps**: pages of 100, 50 ms pause between pages, `maxLlmCalls` distillation cap per run
  (default 50, `0` = deterministic layer only). Cap hit ⇒ `distill.done: false`; resume
  continues where it stopped.
- **Coexistence with live ingest**: runs concurrently with the scheduler by design — dedup
  makes overlap safe, and the runner never reads or writes `ingest.lastCheck.*`. Disabled
  sources (heartbeat.md) are skipped with a per-source error note. No working-hours gate —
  manual path, like check-now.
- **Cost**: `distill` calls record in `ai_decisions` (kind `distill`, model default
  haiku) and roll up under the `backfill` cost category in `/api/costs`.

## Resolution-sweep guard

A later backfill can insert old rows into a live task's thread. `gatherEvidence`
(loop/resolution-sweep.ts) previously fell back to `originIdx = 0`, which would have made that
history read as "evidence after the ask" — old completion phrases would wrongly auto-close
live tasks and burn the per-sweep LLM budget through the watermark. Backfilled rows
(`body.meta.backfill`) are now filtered out **before** origin matching. This is sound because
backfill never creates tasks: every sweepable task's origin is a live row, and live replies
keep full evidence strength.

## REST + CLI

```
POST /api/backfill/start   { sources?, days=30, maxLlmCalls=50, resume=false }
                           → { started, alreadyRunning?, state }   (fire-and-forget)
GET  /api/backfill         → { state }
POST /api/backfill/cancel  → { state }                             (idempotent)
```

`botty backfill [status|cancel|resume] [--source slack,gmail,gcal] [--days 30]
[--max-llm-calls 50] [--no-wait]` — health-checks the agent first, starts the run, then polls
`GET /api/backfill` once a second printing per-source + distill progress (`--no-wait` skips
polling; ^C detaches, the run continues server-side). Exit 1 on `error`/`alreadyRunning`.

## Ordering guidance

Run backfill **after** filling `team.md` so tier attribution is right from the start. Running
earlier is safe, not wrong: everyone lands tier 2 / discovered, and a later team.md
materialization promotes matching rows via `upsertTeamPerson` (handle/email match). Distilled
notes only ever attach to discovered people either way.

## Tests

`packages/agent/test/backfill/{runner,distill}.test.ts`, `test/server/backfill.test.ts`,
sweep-guard cases in `test/loop/resolution-sweep.test.ts`, sim history in
`packages/sim/test/{engine,server}.test.ts`, CLI in `packages/cli/test/backfill.test.ts`.
