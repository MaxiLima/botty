# CLI — @botty/cli

The `botty` bin: one installable entry point that starts/stops the daemon pair
(agent + sim), attaches the clients (TUI, browser), and diagnoses the install.
Product surface only — dev tooling (`timewarp`, `replay`, `sandbox`) stays in npm
scripts. Phase 1 (this spec) runs from a repo checkout via the same tsx
ESM-loader shim as `botty-tui` — no build step, no publish. Phase 2 (bundled,
publishable package) is deliberately deferred to the backlog until
`BOTTY_MODE=real` exists.

## Install

```sh
npm install              # once, at the repo root
npm link -w @botty/cli   # links the `botty` bin globally (undo: npm unlink -g @botty/cli)
botty start
```

(`npm install -g .` is **not** the path: global folder installs pack-and-copy,
which severs the workspace `*` deps. The link keeps the package at its real
path, so Node resolves `@botty/shared`/tsx through the repo's node_modules.)

The bin (`packages/cli/bin/botty.js`) registers tsx's ESM loader with the
package's own tsconfig and imports `src/index.ts` — identical mechanism to
`botty-tui`, so it works from any cwd but requires the checkout on disk.

## Command surface

```
botty <command> [flags]
```

| Command | Behavior |
|---------|----------|
| `start` | Boot detached: sim first (when mode=sim), then agent. Idempotent — running processes are reused. Health-polls both, verifies isolation (`/api/health` `dbPath` under the data dir), prints the app URL. |
| `stop` | SIGTERM the pidfile-owned processes only (see safety model). Foreign listeners are reported and left alone. |
| `restart` | `stop` + `start`. |
| `status` | Per process: pid, port, ownership (`botty cli` / `foreign` / `down`), agent `/api/health` JSON, sim scenario+clock. Exit 0 iff agent healthy. |
| `logs [agent\|sim]` | Print the last 200 log lines (default agent); `-f`/`--follow` tails via `tail -f`. |
| `serve` | Run the **agent in the foreground** (stdio inherited, no pidfile) — for launchd/systemd units or debugging. Assumes the sim is already up when mode=sim; `--with-sim` spawns it detached first. |
| `tui` | Attach the terminal client (spawns `@botty/tui` with stdio inherited). If nothing is listening on the agent port, runs `start` first — `--no-start` turns that into an error instead. |
| `open` (aliases `gui`, `web`) | Ensure the daemon is up (same auto-start + `--no-start` as `tui`), then open the app URL in the default browser (`open` on darwin, `xdg-open` elsewhere). |
| `doctor` | Environment checks, one ✓/✗ line each (see below). Exit 0 iff all pass. |
| `mcp list` | Discover MCP servers across the local Claude Code config (user scope, cwd project scope, enabled plugins, managed settings) and print each with source, transport, and import status. claude.ai connectors are listed as not importable (their auth lives in claude.ai). |
| `mcp import [keys…]` | Copy importable stdio servers into `~/.botty/config/mcp.json` (all of them, or just the named keys). Default-deny: entries land with `tools: {}`, which the agent never spawns — so an import can never disturb a live Claude Code session. `--force` overwrites an existing entry (preserving its `tools` allowlist); `--probe` spawns each imported server once via the agent to discover tools, written as `action`. See "MCP import" below. |
| `backfill [status\|cancel\|resume]` | One-shot historical ingest, **context only** — people, interactions, calendar, decisions; never tasks (docs/specs/backfill.md). Needs a healthy agent (`botty start` first). Default run starts and polls progress once a second (^C detaches, run continues server-side; `--no-wait` skips polling); `status` prints the current/last run; `cancel` stops cooperatively; `resume` continues an errored/cancelled run from its cursors. Exit 1 on error/already-running. |
| `update` (alias `upgrade`) | Update to the latest version. Phase-1 semantics (repo install): fetch, then **ff-only** merge of the tracked upstream (aborts with instructions on local commits/conflicts — never rebases or discards anything). Owned processes are stopped first and restarted after; `npm install` runs iff the diff touched a `package.json`/lockfile; the web dist is rebuilt iff the diff touched `packages/web` (non-dist) or `packages/shared` — skipped with a warning when a foreign agent may be serving it. On a failed step the daemon is restarted on the previous version (the ff-merge is all-or-nothing). No-op with a message when already up to date. |
| `help`, `--help`, `-h` | Usage. `--version`/`-V` prints the package version. |

## Flags & env

Flags win over env vars; env vars keep their existing semantics (README table).

| Flag | Env | Default | Notes |
|------|-----|---------|-------|
| `--port <n>` | `AGENT_PORT` | `4820` (shared constant) | agent HTTP/WS port |
| `--sim-port <n>` | `BOTTY_SIM_PORT` | `4821` (shared constant) | sim port; also derives `BOTTY_SIM_URL` for the agent unless the env var is set explicitly |
| `--data-dir <path>` | `BOTTY_DATA_DIR` | `~/.botty` | pidfiles + logs live under it too |
| `--mock-llm` | `BOTTY_MOCK_LLM` | off | passed through to spawned processes |
| `--no-start` | — | — | `tui`/`open`: never boot the daemon implicitly |
| `--with-sim` | — | — | `serve`: also spawn the sim (detached) |
| `--force` | — | — | `mcp import`: overwrite existing entries, keeping their `tools` allowlist |
| `--probe` | — | — | `mcp import`: spawn each imported server once via the agent to discover tools (single-consumer caveat — see docs/specs/mcp.md) |
| `--source <list>` | — | all of `slack,gmail,gcal` | `backfill`: comma-separated source subset |
| `--days <n>` | — | `30` | `backfill`: lookback window |
| `--max-llm-calls <n>` | — | `50` | `backfill`: distillation call cap; `0` = deterministic only |
| `--no-wait` | — | — | `backfill`: start and return without polling |
| `-f`, `--follow` | — | — | `logs`: tail |

`BOTTY_MODE` is honored (`sim` default). Under `real` (not implemented yet) the
sim is never spawned and sim rows disappear from `status`.

## Process management & safety model

The repo owner runs live dev instances on the default ports (CLAUDE.md hazard),
so the CLI must never kill a process it didn't start:

- **Pidfiles**: `start` writes `<dataDir>/run/{agent,sim}.pid` containing
  `{ pid, port, startedAt }` (JSON). Logs append to the existing
  `<dataDir>/logs/{agent,sim}.log`.
- **Ownership check**: a pidfile claims a process only if the pid is alive
  (`kill(pid, 0)`) **and** its command line (`ps -p <pid> -o command=`) still
  looks like the matching botty entry point. Stale pidfiles are deleted on sight.
- **`stop`** signals owned pids only (SIGTERM, up to 5s wait, then reports —
  never SIGKILL, never kill-by-port). A listener on the port that the pidfile
  doesn't own is printed as `foreign — not stopping` and left running.
- **`start`** with a foreign listener on the target port treats that process as
  the running instance: it reports it, skips spawning, and continues (waits for
  health, prints the URL). This makes `botty tui`/`botty open` cooperate with a
  hand-started `npm run dev:agent` instead of fighting it.
- **Isolation check**: after health, `start` verifies `/api/health`.`dbPath` is
  under the resolved data dir and aborts loudly if not (same guard as
  `scripts/sandbox.ts`).
- Detached spawns invoke tsx directly with the **absolute** entry path
  (`node <repo>/node_modules/.bin/tsx <repo>/packages/{agent,sim}/src/index.ts`)
  — not `npm run`, whose process title collapses to an unidentifiable
  `npm run start` and would defeat the ownership check. Env is composed from
  the flags above. When launched inside a Claude Code session, the nested-session env
  (`CLAUDECODE`/`CLAUDE_CODE_*`/scoped `ANTHROPIC_*`) is stripped exactly as
  `scripts/sandbox.ts` does, so SDK auth falls back to the user's own login.

## Web UI build

The agent serves `packages/web/dist`. `start`/`serve` check that
`dist/index.html` exists and, if absent, run `npm run build -w @botty/web` once
before booting. If `dist` exists it is **never** rebuilt (a live agent may be
serving it — CLAUDE.md rule); `doctor` reports staleness (any `web/src` file
newer than `dist/index.html`) as a warning with the rebuild command, not an
action.

## Doctor checks

| Check | Pass condition |
|-------|----------------|
| node version | `>= 22.12` (engines) |
| web dist | `packages/web/dist/index.html` exists (warn if stale, see above) |
| data dir | resolved path exists or is creatable; prints it |
| agent | `/api/health` reachable on the resolved port; prints mode/onboarded |
| sim | `/control/state` reachable (sim mode only) |
| notifier | `terminal-notifier` on PATH (darwin only; warn, not fail) |
| LLM auth | `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` set, or a Claude Code credentials file exists — warn otherwise that real-LLM calls will fail (mock unaffected) |
| mcp | only shown when > 0: N importable Claude Code MCP servers not yet in botty's mcp.json — warn with `botty mcp import`. Discovery failures never break doctor. |

## MCP import

`mcp list`/`mcp import` bridge the user's existing Claude Code MCP setup into
botty's own `~/.botty/config/mcp.json` (schema and consent model:
`docs/specs/mcp.md`). Discovery (`src/claude-mcp.ts`, pure over injected file
contents) reads, in precedence order — duplicate keys from lower sources are
listed as `shadowed` and skipped on import-all:

1. **managed** — `/Library/Application Support/ClaudeCode/managed-settings.json` `mcpServers`
2. **project** (cwd only) — `<cwd>/.mcp.json` (entries in the project's
   `disabledMcpjsonServers` are excluded from import-all but importable by
   explicit name) plus `~/.claude.json` `projects[<cwd>].mcpServers`
3. **user** — `~/.claude.json` top-level `mcpServers`
4. **plugin** — `~/.claude/settings.json` `enabledPlugins` →
   `~/.claude/plugins/installed_plugins.json` (per-plugin `installPath`) →
   `<installPath>/.mcp.json`; plugins without one are skipped

Remote (`sse`/`http`) servers are skipped (botty is stdio-only), and claude.ai
connectors (recorded only as names in `claudeAiMcpEverConnected`) are reported
as not importable — their auth lives in claude.ai, there is nothing local to
run. Malformed sources become warnings, never errors.

Import semantics: keys are sanitized to `[a-zA-Z0-9_-]+` (batch collisions
suffixed `-2`…); `${CLAUDE_PLUGIN_ROOT}` expands to the plugin's install path
and other `${VAR}`/`${VAR:-default}` placeholders are resolved from the
importing environment **at import time** (botty does no runtime expansion —
a verbatim placeholder would never work), with a printed note when an env
value is baked in and a warning when unresolved. The existing mcp.json is
treated as opaque JSON — unknown keys and untouched entries survive verbatim;
a file that doesn't parse refuses the whole import (the agent may be serving
last-known-good — never clobber it). The previous file is archived to
`config/archive/mcp-<ts>.json` (mirroring `ConfigManager.saveMcp`) and the
agent's watcher hot-reloads the write; no restart or running agent needed.

`--probe` reuses the agent's `POST /api/onboarding/mcp-probe` (spawn once,
`tools/list`, 10s timeout, child always killed) rather than embedding an MCP
client in the CLI; it therefore requires a healthy agent and fails fast before
writing anything when there isn't one. Probed tools land as `action`
(consent-gated); existing modes are never downgraded and re-probes never drop
allowlisted tools. A warning banner precedes probing: spawning a second
instance of a single-consumer server (the telegram plugin's one polling slot
per bot token, fakechat's fixed port) can kill or fight a live Claude Code
session using it.

## Files

| File | Role |
|------|------|
| `bin/botty.js` | tsx ESM-loader shim → `src/index.ts` |
| `src/index.ts` | arg parsing, command dispatch, help/version |
| `src/config.ts` | flags+env → resolved `{ ports, dataDir, urls, mode, mockLlm }` (pure) |
| `src/procs.ts` | pidfile read/write/claim, ownership check, spawn/stop/status |
| `src/commands/*.ts` | one module per command |
| `src/claude-mcp.ts` | pure Claude Code MCP discovery / convert / merge (see "MCP import") |
| `src/http.ts` | `getJson`/`postJson`/`waitHealthy` (ports of the sandbox helpers) |

Pure modules (`config.ts`, pidfile parsing/claiming logic, doctor predicates)
are unit-tested with vitest; process-spawning paths are covered by the e2e smoke
recipe in `docs/TESTING.md` (isolated ports + temp data dir, per the verify
skill).

## Deferred (backlog, low priority)

Phase 2 — publishable package: bundle agent+tui+sim+cli (tsup), ship web `dist`
+ SQL migrations + config templates as package assets, make the three
`import.meta.url` asset resolutions overridable (`server/index.ts` webDistDir,
`shared/src/migrations.ts`, `agent/src/env.ts` templatesDir),
`better-sqlite3` as the only runtime native dep. `botty update` then switches
from git ff-merge to an npm-registry check (`npm install -g botty@latest`) — the
command surface stays the same. Gated on real mode existing —
until then a publish would ship a demo. No single-binary (Node SEA/bun) — the
native sqlite addon makes it painful for no gain on a local-first product.
