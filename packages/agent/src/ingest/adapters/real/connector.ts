import type { z } from 'zod';
import type { SourceId } from '@botty/shared';
import type { DecisionRecorder, ModelResolver } from '../../../llm/types.js';
import { jsonInstructionFor, parseStructuredText } from '../../../llm/parse.js';
import { withInactivityTimeout, type QueryFn } from '../../../llm/sdk.js';

/**
 * Real-mode fetch through claude.ai MCP connectors (Gmail / Google Calendar):
 * one isolated, fetch-only Agent SDK run per poll. The model searches the
 * source with the connector's read tools and returns normalized events as a
 * single JSON object (validated against the caller's zod schema, one retry).
 *
 * Isolation is deliberate and load-bearing:
 * - `settingSources: []` — never load the user's Claude Code settings or
 *   plugins. A plugin MCP server spawned here would be a SECOND instance of
 *   it, and single-consumer servers (e.g. a Telegram bot's one getUpdates
 *   slot) would steal the user's live session (docs/specs/mcp.md).
 * - env is passed WITHOUT ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN: claude.ai
 *   connectors only load under the user's Claude subscription login, never
 *   under API-key auth (verified in the 2026-07-27 M4 spike).
 * - `allowedTools` is a per-source read-only allowlist + ToolSearch (connector
 *   tools are deferred behind tool search); every built-in that could touch
 *   the machine or the network is explicitly disallowed. Connector results are
 *   untrusted content — a prompt injection inside an email must find no tool
 *   that can act on it.
 */

/** Max silence between SDK stream messages before the fetch counts as hung. */
const FETCH_INACTIVITY_MS = 120_000;

/** ToolSearch + connector calls + one retry leave headroom under this. */
const FETCH_MAX_TURNS = 16;

/** Built-ins a fetch run must never use, even if a future default enables them. */
const FETCH_DISALLOWED_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Task',
  'TodoWrite',
  'Skill',
];

export interface ConnectorFetchDeps {
  queryFn: QueryFn;
  modelFor: ModelResolver;
  record: DecisionRecorder;
}

export interface ConnectorFetchRequest<T> {
  source: SourceId;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Fully-qualified connector tool names this fetch may call (read-only). */
  connectorTools: string[];
}

/** process.env minus every Anthropic auth override, so the SDK falls back to
 * the user's Claude subscription login (required for claude.ai connectors). */
export function connectorEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN') continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue;
    env[key] = value;
  }
  return env;
}

export type ConnectorFetch = <T>(req: ConnectorFetchRequest<T>) => Promise<T>;

export function createConnectorFetch(deps: ConnectorFetchDeps): ConnectorFetch {
  async function runOnce(
    model: string,
    system: string,
    prompt: string,
    connectorTools: string[],
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const handle = deps.queryFn({
      prompt,
      options: {
        model,
        systemPrompt: system,
        // NOTE: no `tools` override — an explicit tools list suppresses the
        // deferred-tool machinery that surfaces connector tools via ToolSearch.
        settingSources: [],
        permissionMode: 'dontAsk',
        allowedTools: ['ToolSearch', ...connectorTools],
        disallowedTools: FETCH_DISALLOWED_TOOLS,
        maxTurns: FETCH_MAX_TURNS,
        persistSession: false,
        env: connectorEnv(),
      },
    });
    let assistantText = '';
    let resultText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const m of withInactivityTimeout(handle, FETCH_INACTIVITY_MS)) {
      if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text' && block.text) assistantText += block.text;
        }
      } else if (m.type === 'result') {
        inputTokens = m.usage?.input_tokens ?? 0;
        outputTokens = m.usage?.output_tokens ?? 0;
        if (m.is_error) throw new Error(m.errors?.join('; ') || `llm error: ${m.subtype ?? 'unknown'}`);
        if (typeof m.result === 'string' && m.result.length > 0) resultText = m.result;
      }
    }
    return { text: resultText || assistantText, inputTokens, outputTokens };
  }

  return async function connectorFetch<T>(req: ConnectorFetchRequest<T>): Promise<T> {
    const model = deps.modelFor('fetch');
    const system = req.system + jsonInstructionFor(req.schema);
    const started = Date.now();
    let inputTokens = 0;
    let outputTokens = 0;
    let lastText = '';
    const baseDecision = {
      kind: 'fetch',
      input: { system: req.system, prompt: req.prompt },
      model,
      relatedRef: `ingest:${req.source}`,
    };

    const attempt = async (prompt: string): Promise<string> => {
      const r = await runOnce(model, system, prompt, req.connectorTools);
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      lastText = r.text;
      return r.text;
    };

    try {
      let parsed = parseStructuredText(await attempt(req.prompt), req.schema);
      if (!parsed.ok) {
        const retryPrompt =
          `${req.prompt}\n\nYour previous response could not be used: ${parsed.error}\n` +
          `Previous response (for reference):\n${lastText.slice(0, 2000)}\n` +
          `Return ONLY a corrected JSON object.`;
        parsed = parseStructuredText(await attempt(retryPrompt), req.schema);
      }
      if (!parsed.ok) {
        deps.record({
          ...baseDecision,
          latencyMs: Date.now() - started,
          inputTokens: inputTokens || null,
          outputTokens: outputTokens || null,
          error: `parse failed after retry: ${parsed.error}`,
          output: { rawText: lastText.slice(0, 4000) },
        });
        throw new Error(`${req.source} connector fetch output failed validation after retry: ${parsed.error}`);
      }
      deps.record({
        ...baseDecision,
        output: parsed.value,
        latencyMs: Date.now() - started,
        inputTokens: inputTokens || null,
        outputTokens: outputTokens || null,
      });
      return parsed.value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes('failed validation after retry')) {
        deps.record({
          ...baseDecision,
          latencyMs: Date.now() - started,
          inputTokens: inputTokens || null,
          outputTokens: outputTokens || null,
          error: message,
        });
      }
      // Auth failures are the common first-run stumble: connectors need the
      // Claude subscription login, not an API key.
      if (/credit balance|authentication|not logged in|api key/i.test(message)) {
        throw new Error(
          `${req.source} connector fetch failed (${message}) — real gmail/gcal ingestion uses your ` +
            `claude.ai connectors via your Claude Code login. Run \`claude\` once and log in with your ` +
            `claude.ai account, and make sure the ${req.source === 'gmail' ? 'Gmail' : 'Google Calendar'} ` +
            `connector is connected at claude.ai/settings/connectors.`,
        );
      }
      throw err;
    }
  };
}
