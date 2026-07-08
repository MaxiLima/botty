---
name: verify
description: Build/launch/drive recipe for verifying botty changes end-to-end (agent, web, TUI) against an isolated instance — never against the live dev agent on 4820.
---

# Verifying botty changes

## Isolated instance (NEVER use 4820/4821 — those are the owner's live processes)

```sh
S=$(mktemp -d)   # or the session scratchpad
AGENT_PORT=5820 BOTTY_SIM_PORT=5821 BOTTY_SIM_URL=http://localhost:5821 \
  BOTTY_DATA_DIR=$S BOTTY_MODE=sim BOTTY_MOCK_LLM=1 npm run -w @botty/sim start &
AGENT_PORT=5820 BOTTY_SIM_PORT=5821 BOTTY_SIM_URL=http://localhost:5821 \
  BOTTY_DATA_DIR=$S BOTTY_MODE=sim BOTTY_MOCK_LLM=1 npm run -w @botty/agent start &
curl -s http://127.0.0.1:5820/api/health   # confirm dbPath is under $S, not ~/.botty
```

Kill by port when done (`lsof -ti tcp:5820 | xargs kill`) — never `pkill tsx`
(the live agent is also `tsx watch`).

## Web UI

The agent serves `packages/web/dist` if present — don't rebuild it during verification
(the live 4820 agent serves the same directory). Drive with puppeteer-core +
system Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`);
composer selector: `.composer-input`, thread: `.chat-thread`.

## TUI (`packages/tui`)

Drive in isolated tmux: `tmux -L <name> new-session -d -x 100 -y 30 -c <repo> \
'npx tsx packages/tui/src/index.tsx --port 5820; sleep 120'`.
Send text and Enter as **separate** `send-keys` calls (a combined call is treated
as a paste and doesn't submit). Capture with `capture-pane -p`.

## Gotchas

- `BOTTY_MOCK_LLM=1` chat replies are `[mock] <prompt>`, streamed in 2 chunks
  **instantly**, no tool_use events — interrupt/tool-line behavior can't be observed
  with it. Use a protocol stub (REST + `/ws` per `packages/shared/src/api.ts`
  `WsEventSchema`) with slow chunks for those paths.
- The server broadcasts no WS event for **user** turns; clients learn about other
  clients' messages via the assistant stream + a history refetch.
- `chat.done` can arrive before the `POST /api/chat/message` response resolves
  (instant replies) — a client that sets pending state from the POST response must
  guard against resurrecting a finished turn.
