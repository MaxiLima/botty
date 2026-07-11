# TUI — @botty/tui

Ink 5 + React 18 terminal chat client. A **peer of the web app**, not a subset bolted on: it
speaks the same REST + WS protocol from `@botty/shared`, watches the same single chat session,
and adopts streams started by other clients (the TUI is a window onto the same conversation as
the browser). Runs via the `botty-tui` bin (tsx, no build step). Requires a TTY.

## Startup & connection

```
botty-tui [--host <host>] [--port <port>]
```

- `--host` (default `127.0.0.1`) / `--port` (default `$AGENT_PORT` or the shared `AGENT_PORT`
  constant). If either flag is given, the base URL is built from them.
- Otherwise `BOTTY_URL=<url>` sets the full base (flags win over it). Must start with
  `http://` or `https://` — a scheme-less URL fails at startup with a clear message, not at
  first request.
- The WS URL is derived from the base (`http→ws`, `https→wss`) by appending `/ws` to any
  existing path, so a proxy prefix (`BOTTY_URL=https://host/botty`) keeps working.
- `historyLimit` is 60 turns on boot; event-driven refetches pull only a 20-turn tail.

Boot does one parallel round trip — `/api/health` + open tasks + chat history — and prints a
welcome banner (mascot, version, mode, base URL, open-task count). If the agent is down, boot
prints an error and the **first-ever** WS open retries it (`useOnReconnect(first)`); later
re-opens instead clear any pending stream, print "reconnected", and refetch history.

## Files

| File | Role |
|------|------|
| `index.tsx` | Entry: `--help`, config parse, TTY check, `render(<App/>)`, `stopWs()` on exit |
| `App.tsx` | The app: transcript state, WS handlers, send/command dispatch, input, statusline |
| `panels.tsx` | Transcript blocks for slash commands + the welcome banner |
| `commands.ts` | `COMMANDS` table, slash parsing, menu filtering, dispatch resolution |
| `ws.ts` | Port of `web/src/lib/ws.ts`: listener registry, reconnect/backoff, Node WebSocket |
| `api.ts` | Port of `web/src/lib/api.ts` parameterized by base URL; zod-inferred bodies |
| `transcript.ts` | Pure `PendingTurn` reducers (`applyChunk`/`applyThinking`/`applyToolUse`) + dedup |
| `format.ts` | Mirrors `web/src/lib/format.ts` (ages, priority labels/colors, board sort) |
| `markdown.ts` | Terminal markdown via `marked` + `marked-terminal` |
| `mascot.ts` | The ◍ bot (`MASCOT_LINES`), statusline `face(wsStatus)`, tagline |
| `config.ts` | Flag/env parsing → `{ baseUrl, wsUrl, historyLimit }`, `HELP` text |

## Transcript

Append-only, rendered through Ink's `<Static>` — scrolling is the terminal's own scrollback.
Item kinds: `turn` (you/botty with timestamp), `seam` (session boundary), `cmd` (echoed slash
command), `panel`, `info`, `error`, `nudge`, and `partial` (a reply that errored mid-stream —
the text the user watched stream is kept, with the error under it, never vaporized).

History pages are ascending, consistent supersets, so `takeUnseen` filters already-printed turn
ids and appends the rest in order. A seam (`── new context ─────`) is drawn from the data
whenever a turn arrives with a different `sessionId` than the previous one — sealing itself only
prints an info line.

## Streaming

A single `PendingTurn` (`turnId`, accumulated `text`, `thinking`, `tools[]`) mirrors the web
app's live region:

- `chat.chunk` appends the delta; `chat.thinking` toggles a spinner (a trailing "thinking off"
  for an untracked turn is ignored — it would materialize an empty ghost reply);
  `chat.toolUse` appends a `⚙ name — summary` line. At most 8 tool lines show, older ones
  collapse into `⚙ … N earlier tool calls`.
- Long streams show only the last 12 lines (`StreamTail` — rewriting a growing block every
  chunk is O(n²) in terminal output, and Ink can't erase past the screen height); the full
  reply lands in the transcript on `chat.done`.
- `chat.done` refetches the history tail first and only falls back to appending the payload
  turn, so the transcript stays ordered (user turn before reply) even on instant replies.
- **Adoption**: a stream for a turnId the TUI didn't start means another client sent a message
  — the reducers create a pending turn for it and the app pulls in the missing user turn with
  a tail refetch (skipped when our own POST is in flight, since its refetch covers the echo).

`tasks.updated` updates the statusline count (counting `open` only — ingest/loop broadcast
all-status or touched-subset lists). `notification` events render **inline as nudge blocks**:
message, kind, score `n/10`, and a hint that actions live in the web app — or just reply here.

## Slash commands

An unindented `/` opens the autocomplete menu; a leading space escapes to chat. The menu
prefix-filters while the command *name* is typed and closes once an argument starts — dispatch
then goes through exact-name lookup, so menu presentation can never change what Enter runs. Six
rows show at a time in a window that slides with the selection (Enter must never run a hidden
command). ↑↓ move, Tab completes, Enter runs. Passing an argument to a no-arg command errors.

| Command | Panel |
|---------|-------|
| `/help` | commands & keys |
| `/tasks` | open board, sorted most-urgent-then-oldest (same as web) |
| `/people [name]` | roster, or one person: weight/tier, notes, open tasks, recent interactions |
| `/inspector` | recent AI decisions (8), ticks (5), source checks (5) — summaries only |
| `/config [persona\|team\|heartbeat]` | view a config file (default persona) |
| `/costs` | LLM spend report (`GET /api/costs`): totals + byCategory/byModel breakdown |
| `/health` | agent status, version, mode, db path |
| `/new` | `POST /api/chat/seal` — next message starts fresh |
| `/quit` | exit |

Panels are **read-only views**. Config editing, task actions, and full Inspector detail live in
the web app — panels say so in their footers. Image attachments are web-only: an attachment-
bearing turn renders as `⧉ N images (view in the web app)`; quoted replies show a dim `↩ preview`
line.

## Statusline & keys

One dim line under the composer: `face(wsStatus) botty · host:port · ws <status> · N tasks ·`
then either `✳ /<cmd>…` (command in flight), `✳ Ns · esc interrupts` (streaming stopwatch,
keyed per turnId so an adopted stream restarts the clock), or `/help`. The face tracks the
connection: `(◍‿◍)` open, `(◍.◍)` connecting, `(◍×◍)` closed. The composer border turns yellow
while streaming.

Keys: **Enter** sends (double-Enter in one stdin chunk is guarded). **Esc** interrupts a
streaming reply (`POST /api/chat/interrupt`, draft kept); with nothing streaming it clears the
draft. **Ctrl+C** quits. ↑↓/Tab drive the menu.

## WS & API modules

`ws.ts` is a module singleton: `startWs(url)` once from bootstrap, `useWsEvent(type, cb)` /
`useWsStatus()` / `useOnReconnect(cb)` hooks, zod (`WsEventSchema`) validation on every message,
listener errors swallowed (Ink owns stdout — no console). Backoff: `min(15s, 500ms · 2^n)`.
Unlike the web client (whose page always boots after the server), the open callback also fires
on the first-ever connect with `first=true` so a TUI launched before the agent can retry boot.

`api.ts` wraps `fetch` against `baseUrl` with the same endpoints and response shapes as the web
client; request bodies are `z.infer`'d from the shared schemas the server validates against, so
they can't drift. Errors surface as `ApiError { status, detail }`.
