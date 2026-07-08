---
name: judgment-replay
description: Replay stored ai_decisions against a changed prompt or model before shipping — the prompt-tuning loop for judgment (and classification/extraction/briefing/resolution). Use when editing any LLM system prompt in packages/agent (e.g. JUDGMENT_SYSTEM), comparing models for a task, or asked to check whether a prompt change alters past decisions.
---

# Judgment replay — testing prompt changes against recorded decisions

## The harness

`packages/agent/src/replay/cli.ts` (spec: docs/specs/loop.md "Replay harness"):

```sh
npm run replay -w @botty/agent -- --kind judgment --last 20
npm run replay -w @botty/agent -- --kind judgment --last 20 --model claude-opus-4-8
npm run replay -w @botty/agent -- --kind judgment --system-file ./new-prompt.md
npm run replay -w @botty/agent -- --kind classification --last 50 --diff-only
```

Flags (exact, from `parseArgs` in cli.ts):
- `--kind` (required): `judgment | classification | extraction | briefing | resolution`
  (every `LlmTask` except chat).
- `--last N` (default 20): N most recent rows of that kind, replayed chronologically.
- `--model M`: override the model for the re-run.
- `--system-file F`: replace the stored system prompt with the file's contents.
- `--diff-only`: print only CHANGED/ERROR rows in the table.

Output: per-row table (`id · created · old · new · diff`) with compact per-kind
summaries (judgment: `notify(taskid,score)` per action or `skip all (N skipped)`),
plus a `changed / unchanged / errors` summary. Comparison is key-order-insensitive
JSON equality.

## How decisions are recorded

Every `llm.structured` call inserts an `ai_decisions` row: `kind`, `input_json`
(`{system, prompt}`), `output_json`, `model`, `latency_ms`, `input_tokens`,
`output_tokens`, `related_ref`, `error`, `created_at`. The replay re-runs the
**same stored inputs** and records its own runs with kind **`<kind>:replay`**
(e.g. `judgment:replay`) so re-runs never pollute the primary log — the primary
query filters by exact kind, so replays are invisible to it. Browse rows via
`GET :4820/api/decisions` or sqlite directly.

## Which DB / which LLM

The CLI uses `loadEnv()`: it reads `$BOTTY_DATA_DIR/data/botty.db` (default
`~/.botty`). For prompt tuning you usually WANT the live DB's real decisions —
that's read-plus-`:replay`-rows only, safe alongside the running agent (WAL).
`BOTTY_MOCK_LLM=1` swaps in the mock client, which is useless for prompt
evaluation — run replays with the real SDK client.

## Prompt-tuning workflow (before shipping a prompt change)

1. The judgment system prompt is `JUDGMENT_SYSTEM` in
   `packages/agent/src/loop/judgment.ts` (other kinds live next to their loop
   stage). Copy the current prompt text to a scratch file, apply your edit there.
2. Baseline sanity: `--kind judgment --last 20` with **no** overrides — stored
   old vs re-run new shows pure model nondeterminism. Expect some noise;
   note the changed count.
3. Candidate: same command plus `--system-file ./candidate.md --diff-only`.
4. Judge the diffs: changed rows should be the behavior you intended (e.g.
   fewer notifies on social noise) and nothing else. Changed count ≫ baseline
   noise in unintended rows ⇒ iterate.
5. Ship: apply the edit to the source constant, run `npm test -w @botty/agent`,
   then the ship skill.

## Eval-set curation (BACKLOG.md P1 — future intent)

After ~1 week of real traffic, curate `ai_decisions` judgment rows into a
**pinned eval set** (known-good expected outputs, not just "latest N"), and run
the replay harness against it for every prompt change. Until that exists,
`--last N` over recent live rows is the stand-in; prefer running it when the
DB holds a representative mix (busy weekday, not a quiet Sunday).
