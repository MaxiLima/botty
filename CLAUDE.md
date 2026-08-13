# botty — agent context

Read `README.md` first for what botty is, the sim-mode quickstart, and package layout.
This file covers only what's non-obvious and dangerous to get wrong.

## ⚠️ LIVE-INSTANCE HAZARD — read before running anything

Ports **4820** (agent) and **4821** (sim) are the owner's **live dev processes**
(`tsx watch`, real data in `~/.botty`). Never kill them, restart them, or point tests
at them. Rules:

- **Verify on an isolated instance**: ports **5820/5821** with a temp `BOTTY_DATA_DIR`.
  Full recipe in the `verify` skill (`.claude/skills/verify/SKILL.md`). Sanity check:
  `curl -s http://127.0.0.1:5820/api/health` must show `dbPath` under your temp dir.
- **Never `pkill tsx`** — the live agent is also `tsx watch`. Kill by port, and only
  the listener: `lsof -ti tcp:<port> -sTCP:LISTEN | xargs kill` (without `-sTCP:LISTEN`
  it also kills connected clients, e.g. a TUI attached to that port).
- **Never rebuild `packages/web/dist` during verification** — the live 4820 agent
  serves that directory; a mid-verification rebuild breaks the owner's session.

## Running in sim mode (isolated)

```sh
S=$(mktemp -d)
AGENT_PORT=5820 BOTTY_SIM_PORT=5821 BOTTY_SIM_URL=http://localhost:5821 \
  BOTTY_DATA_DIR=$S BOTTY_MODE=sim BOTTY_MOCK_LLM=1 npm run -w @botty/sim start &
# same env for `npm run -w @botty/agent start`
```

Key env vars: `BOTTY_DATA_DIR` (default `~/.botty`), `BOTTY_MODE=sim|real`,
`BOTTY_MOCK_LLM=1` (deterministic stub — free/instant, but no tool_use events and
judgment always skips), `BOTTY_SIM_URL`.

## Testing the proactive loop — timewarp

Proactive behavior is time-gated (min-age, cooldowns, staleness, snooze). Don't wait —
shift the DB clock: `npm run timewarp -- --hours 6` (or `--days N`). **Stop the agent
first** — it holds a WAL lock. Replay recorded AI decisions with
`npm run replay -- --kind judgment --last 20`. Recipes: `docs/TESTING.md`.

## Contracts and conventions

- `packages/shared` is **frozen contracts**: zod schemas, the REST/WS contract in
  `src/api.ts`, and SQL migrations. Any change there ripples through every package's
  typecheck — treat edits as cross-cutting and run `npm run typecheck` at the root.
- Task priority is **1=HIGH, 2=NORMAL, 3=LOW** everywhere (DB, API, UI).
- Every AI decision (funnel classification, extraction, tick judgment) is recorded in
  `ai_decisions` and browsable in the Inspector — check there before guessing why the
  agent did something.
- Config lives in `~/.botty/config/`: markdown (`persona.md`, `team.md`, `heartbeat.md`) plus
  `mcp.json` (external MCP servers/tools + the consent gate for `action`-mode tools — see
  `docs/specs/mcp.md`). All four are hot-reloaded — no restart needed to test config changes.
- **Interactive chat runs the full Claude Code surface**: it inherits the user's `~/.claude` Skills +
  MCP connectors via `settingSources: ['user']` and appends botty's context onto the `claude_code`
  system-prompt preset. The autonomous paths (funnel/judgment `structured()`, real-mode fetch,
  proactive loop) stay locked (`tools: []`, `settingSources: []`). The safety valve that strips exec +
  file-mutation from the chat surface lives in `packages/agent/src/llm/tool-policy.ts`. Full mechanism:
  `docs/specs/chat-surface.md`.

## Doc map

`docs/SPEC.md` (product spec) · `docs/ARCHITECTURE.md` · `docs/TESTING.md` (behavior
recipes) · `docs/specs/*` (per-feature specs) · `BACKLOG.md` (prioritized pending work).
