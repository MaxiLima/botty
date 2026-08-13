# Chat tool surface - full Claude Code, valve-guarded

The interactive chat path runs the **full Claude Code tool surface** - built-in tools, the
user's `~/.claude` Skills, and the claude.ai MCP connectors they've already linked - so botty
acts like a real assistant, not a four-tool bot.
A safety valve strips shell exec and file mutation from that surface.
The autonomous paths (funnel, judgment, real-mode fetch, proactive loop) are deliberately
**unchanged** and stay locked - this capability is chat-only.

Location: `packages/agent/src/llm/sdk.ts` (`chatAttempt`), `packages/agent/src/llm/tool-policy.ts`
(the valve), `packages/agent/src/subscription-env.ts`, `packages/agent/src/env.ts` (`workspaceDir`),
wired in `packages/agent/src/llm/index.ts` (`createLlm`).

## Chat vs the autonomous paths

Two shapes of SDK call, deliberately different:

- **Chat** (`chatAttempt`, task `chat`): the full surface described below.
  User-initiated, interactive, one turn at a time.
- **Autonomous** - `structured()`/`runOnce()` (classification, extraction, judgment, resolution,
  briefing) and the real-mode connector fetch (`ingest/adapters/real/connector.ts`) - stay locked:
  `tools: []` (or a read-only connector allowlist for fetch), `permissionMode: 'dontAsk'`,
  `settingSources: []`, low `maxTurns`.
  See `specs/llm.md` (structured) and `specs/ingestion.md` (real fetch).

The split is intentional: chat is user-driven and interactive, so it gets the whole toolbox; the
autonomous loop acts on its own schedule over untrusted ingested content, so it gets no built-ins,
no inherited config, and no skills.

## Chat `query()` options

From `chatAttempt` in `llm/sdk.ts`:

```ts
{
  model,                                              // task 'chat' → sonnet by default
  systemPrompt: { type: 'preset', preset: 'claude_code', append: req.systemPrompt },
  includePartialMessages: true,
  settingSources: ['user'],                           // inherit ~/.claude: Skills, subagents, CLAUDE.md, MCP servers
  skills: 'all',                                      // all discovered skills enabled (SDK auto-adds the Skill tool)
  // botty's own chat tools ride alongside as an in-process SDK MCP server, when present:
  ...(toolWiring ? { mcpServers: toolWiring.mcpServers, allowedTools: toolWiring.allowedTools } : {}),
  disallowedTools: [...FILE_MUTATING_TOOLS],          // ['Bash','Write','Edit','NotebookEdit'] - the valve
  permissionMode: 'default',
  canUseTool: chatCanUseTool,                         // auto-allow gate; hook for future per-tool policy
  cwd: workspaceDir,                                  // <BOTTY_DATA_DIR>/workspace
  env: subscriptionEnv(),                             // strip API-key auth so claude.ai connectors load
  maxTurns: 30,
  ...(resume ? { resume } : {}),
}
```

- **`systemPrompt` preset + append**: Claude Code's own tool instructions, with botty's
  persona/memory/task context appended (the string from `memory/buildChatSystemPrompt`, assembled in
  `chat/index.ts`).
  botty is a real assistant that also knows its own context, not a from-scratch prompt.
- **`settingSources: ['user']`**: the user's `~/.claude` config - Skills, subagents, `CLAUDE.md`, and
  MCP servers - is inherited.
  This is where the claude.ai connectors the user already linked (Gmail, Calendar, Drive, Slack, ...)
  come from.
- **`skills: 'all'`**: every discovered skill is enabled; the SDK auto-adds the `Skill` tool.
- botty's four in-process chat tools (`capture_task`/`task_action`/`memory_search`/`session_search`,
  `specs/ingestion.md` "Chat tools") still attach as the `mcp__botty__*` SDK MCP server; the valve
  does not touch them (they're `mcp__...`, not bare built-in names).

## The valve - `llm/tool-policy.ts`

Chat auto-runs tools (no interactive approval), and its context includes untrusted ingested content -
email, Slack, and calendar text funneled in.
Full surface + auto-run + untrusted text is a prompt-injection → execution path: injected text could
talk the model into a shell command or a file write on the owner's machine.
The valve removes exactly the tools that turn "read some text" into "change the machine":

- **`FILE_MUTATING_TOOLS = ['Bash','Write','Edit','NotebookEdit']`** in `disallowedTools`.
  Bare tool names (not `mcp__...`), so the SDK strips them from the whole surface, including inside
  subagents.
  Exec and file mutation are gone; reads, searches, connectors, and skills survive.
- **`permissionMode: 'default'` + `canUseTool: chatCanUseTool`**: everything that survives the
  disallow list is side-effect-light, so `chatCanUseTool` auto-allows it (`{ behavior: 'allow' }`).
  It's kept as a live callback, not a static allow, so per-tool policy can slot in there later
  without touching the query wiring.

## Isolation - `workspaceDir` + `subscriptionEnv`

- **`cwd: env.workspaceDir`** (`<BOTTY_DATA_DIR>/workspace`, `env.ts`): chat sessions run in a scratch
  cwd so Claude Code's auto-memory and session files namespace there, away from the owner's real repos.
  Falls back to `process.cwd()` only for tests/replay that don't set it.
- **`env: subscriptionEnv()`** (`subscription-env.ts`): `process.env` minus `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDECODE`, and `CLAUDE_CODE_*`.
  claude.ai connectors only load under the Claude *subscription* login, never under API-key auth
  (verified in the 2026-07-27 M4 spike) - the same reason the real-mode fetch strips them.
  Lives in its own module so the llm and ingest layers can share it without an import cycle.

## Escape hatches (available, unused today)

- **`strictMcpConfig: true`** - inherit Skills/subagents/`CLAUDE.md` via `settingSources: ['user']`
  but ignore all inherited MCP servers, supplying MCP explicitly instead.
  Reach for it if inheriting every configured server becomes undesirable.
- **`disabledMcpjsonServers` / `enabledMcpjsonServers`** (settings.json) - trim individual inherited
  servers rather than the all-or-nothing switch above.

Neither is wired today.
Empirical note from the design spike: with the user's real config, SDK init measured ~1-2.5s and
inherited MCP servers come up lazily (`pending`, connected on first use), so inheriting them all is
cheap per turn (171 skills loaded).
Revisit if a heavy or single-consumer inherited server becomes a problem.

## Fast-follow

See `BACKLOG.md`: approval-routing the mutating tools through `pending_actions`
(deny → enqueue → mid-turn approval card) instead of denying them outright, and optionally extending
the full surface to the proactive loop (which would need every autonomous action gated).
