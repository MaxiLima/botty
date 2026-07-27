# botty

Personal, proactive AI assistant. Watches work signals (Slack, Gmail, Calendar, Jira, GitHub),
turns the ones that matter into tracked tasks, remembers people/projects/decisions, and surfaces
the right thing at the right moment — without nagging. Local-first, single user, LLM via your
Claude subscription (Claude Agent SDK). Spec: `docs/SPEC.md`.

**Reality check**: `BOTTY_MODE=real` polls **Gmail and Google Calendar for real** through your
claude.ai MCP connectors (zero extra credentials — see "Real mode" below). Slack/Jira/GitHub
real drivers still need user-supplied credentials and throw until configured (`BACKLOG.md`
P0 #1). The built-in **simulator** (fake Slack/Gmail/GCal/Jira/GitHub) remains the default
mode and the way to try everything without touching real data.

## Prerequisites

| Requirement | Why |
|---|---|
| Node.js **≥ 22.12** | `engines.node` in the root `package.json` |
| A native build toolchain (Xcode Command Line Tools on macOS; `build-essential` on Linux) | `better-sqlite3` compiles a native addon on install |
| `terminal-notifier` (`brew install terminal-notifier`, macOS only) | proactive nudges' primary desktop-banner path — optional, but see `docs/TESTING.md` §1 if banners don't show |

## Installing where npm is proxied/restricted (corporate registries)

Runtime installs don't need any build tooling: the web UI ships pre-built in
`packages/web/dist`, so

```sh
npm install --omit=dev     # runtime deps only — no vite/postcss/vitest
npm link -w @botty/cli
botty start
```

is a complete install. The lockfile deliberately pins a few transitive deps to
versions old enough for mirror quarantine windows (`overrides` in the root
`package.json`: `@modelcontextprotocol/sdk` 1.29.0, `@hono/node-server` 1.19.14 —
re-accepting two Windows-only moderate advisories in code paths botty never
executes; `postcss` 8.5.18). Revisit the pins once your mirror has synced newer
versions. Dev work (tests, web rebuild) needs a full `npm install`.

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

## The `botty` CLI

One installable command wraps all of the above (spec: `docs/specs/cli.md`):

```sh
npm link -w @botty/cli   # once — links the global `botty` bin (undo: npm unlink -g @botty/cli)

botty start              # boot the agent in REAL mode (default; builds the web UI if missing)
botty start --sim        # sim mode instead: boots simulator + agent against fake sources
botty tui                # attach the terminal client (starts the daemon if needed)
botty open               # open the web app in the browser (aliases: gui, web)
botty status             # pid/port/ownership + agent health, sim state
botty logs -f            # tail the agent log (`botty logs sim` for the sim)
botty stop               # stop what botty started — never touches processes it doesn't own
botty serve              # run the agent in the foreground (for launchd/systemd)
botty doctor             # check node, web build, agent health, notifier, LLM auth
botty backfill           # one-shot historical ingest — context only, never tasks (docs/specs/backfill.md)
botty update             # pull the latest version (ff-only), rebuild if needed, restart

```

`--port/--sim-port/--data-dir/--mock-llm` override the env vars below; `start` is
idempotent and pidfile-safe — a hand-started `npm run dev:agent` on the same port is
detected as a foreign instance, reused, and never killed. Dev tooling stays in npm
scripts (`sandbox`, `timewarp`, `replay`).

## LLM auth

botty talks to Claude through the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), not a
direct API key — it authenticates with whatever credentials the SDK resolves ambiently (the same
resolution Claude Code itself uses: an `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` env var if set,
otherwise your logged-in Claude Code / `ant auth login` session). In practice: if `claude` (Claude
Code) already works on this machine, botty's real-LLM calls will too — no separate setup, no
per-token API bill. Set `BOTTY_MOCK_LLM=1` to skip the SDK entirely (see the env var table below).

## Real mode (Gmail + Google Calendar via claude.ai connectors)

```sh
botty start                        # real mode is the CLI default (--sim for the simulator)
```

Real-mode gmail/gcal polls run one fetch-only Agent SDK call each, using the **claude.ai
connectors** already linked to your account (claude.ai → Settings → Connectors). Requirements:

- You're logged into Claude Code with your claude.ai account on this machine (connectors do
  **not** load under `ANTHROPIC_API_KEY` auth — botty strips it for fetch runs on purpose).
- The Gmail / Google Calendar connectors are connected on claude.ai.

Disable sources you don't want polled (slack/jira/github throw until their drivers get
credentials) in `~/.botty/config/heartbeat.md` under `sources`. Each poll is a real LLM call
billed to your subscription — intervals live in the same file (defaults: gmail 30m, gcal 60m).
Every fetch is recorded in the Inspector (`ai_decisions` kind `fetch`).

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
npm run sandbox          # persistent manual-testing playground on 6820/6821 + TUI — docs/TESTING.md §0
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
Config page (mcp.json is edited on disk), hot-reloaded. MCP servers you already run in Claude
Code can be copied in with `botty mcp import` (default-deny; see `docs/specs/mcp.md`). Every AI decision (funnel
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
- `packages/cli` — the `botty` bin: daemon lifecycle + client launchers (`docs/specs/cli.md`)
- `packages/sim` — source simulator + scenario engine (`scenarios/workweek.json`)
- `docs/` — spec suite (`SPEC.md` + `docs/specs/*`); predecessor spec in `botito-spec.md`
