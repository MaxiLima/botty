# botty

Personal, proactive AI assistant. Watches work signals (Slack, Gmail, Calendar, Jira, GitHub),
turns the ones that matter into tracked tasks, remembers people/projects/decisions, and surfaces
the right thing at the right moment — without nagging. Local-first, single user, LLM via your
Claude subscription (Claude Agent SDK). Spec: `docs/SPEC.md`.

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

Useful env vars: `BOTTY_DATA_DIR` (default `~/.botty`), `BOTTY_MODE=sim|real`,
`BOTTY_MOCK_LLM=1` (deterministic LLM stub, no Claude calls), `BOTTY_SIM_URL`.

## Development

```sh
npm run typecheck        # all workspaces
npm test                 # all workspaces
npm run dev:web          # vite dev server on :5173 (proxies to :4820)
npm run replay -w @botty/agent -- --kind judgment --last 20   # re-run recorded AI decisions
```

## TUI

A terminal client, peer of the web app — both talk to the same running agent and
stay in sync live over the same REST + WS protocol:

```sh
npm run dev:tui                    # connect to the default agent port (4820)
npm run dev:tui -- --port 5820     # or --host/--port; BOTTY_URL=<url> also works
```

Chat with streaming tokens, thinking indicator, and tool-use lines; proactive
nudges land inline as botty ✦ messages, and the statusline tracks the connection
and open-task count live. Type `/` for the command menu (↑↓ navigate, Tab
completes): `/tasks`, `/people [name]`, `/inspector`, `/config`, `/health`,
`/new` (fresh context), `/help`, `/quit`.

Keys: **Enter** send · **Esc** interrupt a streaming reply (or clear the draft) ·
**Ctrl+C** quit. Scrolling is your terminal's own scrollback. Panels are
read-only — editing config and acting on tasks stay in the web app — and image
attachments aren't supported in the terminal.

Config lives in `~/.botty/config/` (`persona.md`, `team.md`, `heartbeat.md`) — editable in the
app's Config page, hot-reloaded. Every AI decision (funnel classifications, extractions, tick
judgments) is recorded and browsable in the Inspector, and replayable via the CLI above.

## Layout

- `packages/shared` — frozen contracts: zod schemas, constants, API/WS contract, SQL migrations
- `packages/agent` — the daemon: db, config, memory, LLM layer, ingestion funnel, proactive loop, HTTP/WS server
- `packages/web` — React SPA (Chat · Tasks · People · Inspector · Config)
- `packages/tui` — Ink terminal chat client (`npm run dev:tui`, or the `botty-tui` bin)
- `packages/sim` — source simulator + scenario engine (`scenarios/workweek.json`)
- `docs/` — spec suite (`SPEC.md` + `docs/specs/*`); predecessor spec in `botito-spec.md`
