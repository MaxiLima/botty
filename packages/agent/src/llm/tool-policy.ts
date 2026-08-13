/**
 * Tool-surface safety valve for the interactive chat path.
 *
 * Chat runs with the full Claude Code tool surface (built-ins + the user's
 * Skills + inherited claude.ai MCP connectors) so botty can act like a real
 * assistant. But ingested email / Slack / calendar content reaches the chat
 * context, and chat auto-runs tools (no interactive approval). That combination
 * is a prompt-injection → execution path: untrusted text could talk the model
 * into running a shell command or writing a file on the owner's machine.
 *
 * The valve removes exactly the tools that turn "read some text" into "change
 * the machine" — shell exec and file mutation — from the ENTIRE surface,
 * including inside subagents (bare tool names in disallowedTools). Everything
 * that survives (reads, searches, connectors, skills) is side-effect-light and
 * auto-runs. `chatCanUseTool` is the live per-tool gate for whatever survives
 * the disallow list; today it auto-allows, and it's the hook where future
 * per-tool policy would slot in without touching the query wiring.
 */

/**
 * Exec + file-mutation tools, removed from the chat surface entirely. Bare
 * names (not `mcp__…`) so the SDK also strips them from subagents.
 */
export const FILE_MUTATING_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit'] as const;

/**
 * Structural subset of the SDK's `PermissionResult` / `CanUseTool` — mirrors the
 * shape the SDK expects while keeping this module free of SDK types (same
 * convention as the rest of llm/).
 */
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal },
) => Promise<PermissionResult>;

/**
 * Auto-allow gate for the chat path. The dangerous tools are already gone via
 * `disallowedTools`, so everything that reaches here is safe to auto-run. Kept
 * as a real callback (not a static allow) so per-tool gating can slot in here
 * later without changing the query wiring.
 */
export const chatCanUseTool: CanUseTool = async () => ({ behavior: 'allow' });
