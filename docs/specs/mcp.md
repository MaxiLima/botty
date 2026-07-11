# External MCP tools — config, allowlist, consent gate

Location: `packages/agent/src/config/mcp.ts` (config schema/parsing), `packages/agent/src/mcp/`
(`connections.ts`, `tools.ts`, `pending.ts`, `schema.ts`). Lets the chat model call tools on
user-declared external MCP servers (stdio only in v1), with `action`-mode tools always held for
explicit user approval before anything actually runs — the model can queue, never send.

## `~/.botty/config/mcp.json`

JSON, not markdown, so it lives outside the `persona.md`/`team.md`/`heartbeat.md` trio (its own
`MCP_FILE_NAME`/`MCP_KEY` in `config/index.ts`) but is watched/hot-reloaded the same way. Seeded
on first run from `packages/agent/config-templates/mcp.json`, which ships as an empty config:

```json
{
  "servers": {}
}
```

Shape (`McpConfigSchema` in `config/mcp.ts`):

```ts
{
  servers: {
    [serverKey: string]: {
      type: 'stdio',                    // only transport in v1
      command: string,
      args?: string[],                  // default []
      env?: Record<string, string>,     // default {} — never logged (secrets)
      tools?: Record<string, 'read' | 'action'>,  // default {} — explicit allowlist
    }
  }
}
```

Example — a Slack MCP server with one read tool and one action tool allowlisted:

```json
{
  "servers": {
    "slack": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@some-org/slack-mcp-server"],
      "env": { "SLACK_BOT_TOKEN": "xoxb-..." },
      "tools": {
        "list_channels": "read",
        "send_message": "action"
      }
    }
  }
}
```

Server keys and tool names are restricted to `[a-zA-Z0-9_-]+` so they compose safely into the
chat-tool name `<server>_<tool>` (e.g. `slack_send_message`).

## `read` vs `action` — the allowlist semantics

Every tool on every configured server is **default-deny**: a server with no `tools` entry (or an
empty one) exposes nothing to the chat model, even if the underlying MCP server offers dozens of
tools. Only tools explicitly listed in `tools` become chat-callable, and only in the mode given:

- **`read`** — calls straight through to the MCP server (`connections.callTool`) mid-turn, same as
  any other chat tool. No approval step.
- **`action`** — the chat model's call **never** reaches the MCP server mid-turn. It only enqueues
  a `pending_actions` row via `mcp/pending.ts`'s `enqueue()` and returns `{ queued: true, actionId,
  summary, note }` to the model, which is instructed (via a `CONSENT_NOTE` appended to the tool's
  description) to tell the user it's queued, not that it ran. `connections.callTool` is called for
  an action tool **exclusively** from `approve()` — that is the one and only path.

`mcp/tools.ts` builds one `ChatToolSpec` per allowlisted `(server, tool)` pair, re-derived fresh
every chat turn (`createMcpToolsFactory`) so a hot `mcp.json` reload takes effect on the very next
turn without an agent restart. `tools/list` results are cached per server, keyed by that server's
config (command/args/env keys, never env values) — a normal turn doesn't re-hit the MCP server
unless its config actually changed since the last successful fetch. An unreachable server still
lets its allowlisted tools build (with a generic description) so a call can enqueue/attempt rather
than silently vanishing from the model's tool list.

Tool descriptions shown to the model are the server's own `tools/list` description (or a generic
fallback) plus the tool's JSON Schema serialized as text — `mcp/schema.ts` also does a best-effort
JSON-Schema → zod conversion for the flat-object subset (string/number/integer/boolean, string
enums, arrays of those, required/optional) so args are typed where possible; anything else
degrades to `z.unknown()` per property rather than dropping it.

## `pending_actions` lifecycle

Table: `pending_actions` (migration 005, see `specs/data-model.md`). Queue behavior lives entirely
in `mcp/pending.ts`'s `createPendingActionQueue`:

- **Enqueue**: `enqueue({ server, tool, args, summary, sourceTurnId })`. Never throws — bad
  outcomes come back as `{ error }` data, not exceptions. Two guards:
  - **Dedup**: an identical `(server, tool, args)` call (args compared as the same JSON string)
    against an existing row returns that row instead of inserting a duplicate.
  - **Cap**: at most `PENDING_ACTIONS_CAP = 10` rows with `status = 'pending'` at once; past the
    cap, `enqueue` returns
    `{ error: 'approval queue full — ask the user to review pending actions' }` instead of
    inserting.
  - A successful enqueue broadcasts WS `action.pending` and the row starts `status: 'pending'`.
- **Approve** (`POST /api/actions/:id/approve`): parses the stored `argsJson`, calls
  `connections.callTool(server, tool, args, { timeoutMs: 30_000 })`, and resolves the row to
  `'executed'` (result in `resultJson`) or `'failed'` (error in `resultJson`). Broadcasts WS
  `action.resolved` either way.
  - **In-process race guard**: an id currently awaiting its `callTool` is claimed in an in-memory
    `Set` *before* the first `await`, so a second concurrent `approve()` — or a `dismiss()` racing
    an in-flight `approve()` — sees `{ kind: 'conflict' }` (surfaced as HTTP 409) rather than
    double-executing the external call or overwriting the row mid-flight.
- **Dismiss** (`POST /api/actions/:id/dismiss`): resolves to `'dismissed'` without ever calling the
  tool. Also refuses (`{ kind: 'conflict' }` → 409) if an `approve()` for that id is in flight, so
  a dismiss can never race an executing call and silently overwrite its outcome.
- **Expiry**: pending rows older than `PENDING_ACTION_TTL_MS = 24h` are lazily flipped to
  `'expired'` (broadcasting `action.resolved`) at the top of every `list()`/`get()`/`enqueue()`/
  `approve()`/`dismiss()` call — there is no background timer, so an idle agent with no chat/API
  traffic simply expires stale rows the next time anything touches the queue.

Terminal statuses: `executed`, `failed`, `dismissed`, `expired` — every one of them fires WS
`action.resolved` exactly once. REST surface: `GET /api/actions?status=`,
`POST /api/actions/:id/approve`, `POST /api/actions/:id/dismiss` (see `specs/api.md`). Web UI renders
each pending row as an inline approval card in the chat thread (`specs/web-ui.md`); the TUI has no
approve/dismiss UI in v1 — resolve pending actions from the web app.

## Hot reload + last-known-good

`mcp.json` follows the exact same last-known-good discipline as `heartbeat.md`
(`config/index.ts`): a revision that fails to parse (invalid JSON, or valid JSON that fails
`McpConfigSchema`) **never replaces** a previously-good config — the manager keeps serving the last
config that parsed cleanly (or the empty `{ servers: {} }` if none has, e.g. a broken file present
at first boot). Warnings for the currently-rejected on-disk content are exposed via
`config.mcpIssues()`, surfaced as `issues.mcp` on `GET /api/config` and on the `config.changed` WS
event's optional `warnings` field when a reload fires with a bad file. `parseMcpConfig` never
throws: invalid JSON or a shape that fails validation comes back as `{ config: EMPTY_MCP_CONFIG,
warnings: [...] }` with one warning per zod issue (`path: message`), never a field value (secrets
in `env` are never logged even in a warning).
