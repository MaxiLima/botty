# botty

Personal, proactive AI assistant. Watches work signals (Slack, Gmail, Calendar, Jira, GitHub),
turns the ones that matter into tracked tasks, remembers people/projects/decisions, and surfaces
the right thing at the right moment — without nagging. Local-first, single user, LLM via your
Claude subscription (Claude Agent SDK). Spec: `docs/SPEC.md`.

**Reality check**: v1 runs end-to-end against the built-in **simulator** (fake Slack/Gmail/GCal/
Jira/GitHub). `BOTTY_MODE=real` is not implemented yet — `createRealAdapterStub` throws on every
fetch (see `BACKLOG.md` P0 #1). Everything below is written for sim mode.

## Prerequisites

| Requirement | Why |
|---|---|
| Node.js **≥ 22.12** | `engines.node` in the root `package.json` |
| A native build toolchain (Xcode Command Line Tools on macOS; `build-essential` on Linux) | `better-sqlite3` compiles a native addon on install |
| `terminal-notifier` (`brew install terminal-notifier`, macOS only) | proactive nudges' primary desktop-banner path — optional, but see `docs/TESTING.md` §1 if banners don't show |

## Quickstart (sim mode — no credentials needed)

```sh
npm install
npm run build -w @botty/web        # build the UI once (agent serves it)

# terminal 1 — simulator (fake Slack/Gmail/GCal/Jira/GitHub + scenario engine)
npm run dev:sim                    # control panel at http://localhost:4821

# terminal 2 — the agent
npm run dev:agent                  # app at http://localhost:4820
```

Then in the sim panel (`:4821`): load the `workweek` scenario → Advance 120 min.
In the app (`:4820`): Inspector → Sources → check-now, watch tasks appear, run a tick,
chat about what's on your plate.

## LLM auth

botty talks to Claude through the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), not a
direct API key — it authenticates with whatever credentials the SDK resolves ambiently (the same
resolution Claude Code itself uses: an `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` env var if set,
otherwise your logged-in Claude Code / `ant auth login` session). In practice: if `claude` (Claude
Code) already works on this machine, botty's real-LLM calls will too — no separate setup, no
per-token API bill. Set `BOTTY_MOCK_LLM=1` to skip the SDK entirely (see the env var table below).

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `BOTTY_DATA_DIR` | `~/.botty` | DB, config, logs, attachments all live under here |
| `BOTTY_MODE` | `sim` | `sim` \| `real` — `real` is not implemented yet, see the reality check above |
| `BOTTY_MOCK_LLM` | unset (off) | `1`/`true` swaps in a deterministic stub — free/instant, but no `tool_use` events and judgment always skips |
| `BOTTY_SIM_URL` | `http://localhost:4821` | agent → sim base URL, sim-mode adapters only |
| `AGENT_PORT` | `4820` (shared `AGENT_PORT` constant) | agent's HTTP/WS port; also what the TUI defaults to if no `--port`/`BOTTY_URL` |
| `BOTTY_SIM_PORT` | `4821` (shared `SIM_PORT` constant) | sim's HTTP port |
| `BOTTY_SIM_SCENARIOS_DIR` | `packages/sim/scenarios/` | override where the sim loads scenario JSON from |
| `BOTTY_URL` | unset | TUI only — full base URL (`http://` or `https://…`), overrides `--host`/`--port`/`AGENT_PORT` |

## Development

```sh
npm run typecheck        # all workspaces
npm test                 # all workspaces
npm run dev:web          # vite dev server on :5173 (proxies to :4820)
npm run timewarp -- --hours 6                  # shift the DB clock to test the proactive loop
npm run replay -- --kind judgment --last 20    # re-run recorded AI decisions
```

## TUI

A terminal client, peer of the web app — both talk to the same running agent and
stay in sync live over the same REST + WS protocol:

```sh
npm run dev:tui                    # connect to the default agent port (4820)
npm run dev:tui -- --port 5820     # or --host/--port; BOTTY_URL=<url> also works
npx botty-tui                      # works too, from the repo root (bin: packages/tui)
```

Chat with streaming tokens, thinking indicator, and tool-use lines; proactive
nudges land inline as botty ✦ messages, and the statusline tracks the connection
and open-task count live. Type `/` for the command menu (↑↓ navigate, Tab
completes): `/tasks`, `/people [name]`, `/inspector`, `/config`, `/costs`, `/health`,
`/new` (fresh context), `/help`, `/quit`.

Keys: **Enter** send · **Esc** interrupt a streaming reply (or clear the draft) ·
**Ctrl+C** quit. Scrolling is your terminal's own scrollback. Panels are
read-only — editing config and acting on tasks stay in the web app — and image
attachments aren't supported in the terminal.

Config lives in `~/.botty/config/`: `persona.md`, `team.md`, `heartbeat.md`, and `mcp.json`
(external MCP servers/tools + the consent gate — `docs/specs/mcp.md`) — editable in the app's
Config page (mcp.json is edited on disk), hot-reloaded. Every AI decision (funnel
classifications, extractions, tick judgments) is recorded and browsable in the Inspector, and
replayable via the CLI above.

## Doc map

`docs/ARCHITECTURE.md` (how the pieces fit together, with diagrams) · `docs/TESTING.md` (behavior
recipes — notification troubleshooting is in §1) · `BACKLOG.md` (prioritized pending work) ·
`docs/specs/*` (per-subsystem contracts: api, data-model, ingestion, loop, mcp, tui, web-ui, …).

## Layout

- `packages/shared` — frozen contracts: zod schemas, constants, API/WS contract, SQL migrations
- `packages/agent` — the daemon: db, config, memory, LLM layer, ingestion funnel, proactive loop, HTTP/WS server
- `packages/web` — React SPA (Chat · Tasks · People · Inspector · Costs · Config)
- `packages/tui` — Ink terminal chat client (`npm run dev:tui`, or the `botty-tui` bin)
- `packages/sim` — source simulator + scenario engine (`scenarios/workweek.json`)
- `docs/` — spec suite (`SPEC.md` + `docs/specs/*`); predecessor spec in `botito-spec.md`
