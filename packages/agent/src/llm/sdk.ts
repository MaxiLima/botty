import type { Db } from '../db/index.js';
import {
  LlmParseError,
  type ChatToolSpec,
  type ChatTurnRequest,
  type ChatTurnResult,
  type DecisionRecorder,
  type LlmClient,
  type ModelResolver,
  type StructuredRequest,
  type TokenUsage,
} from './types.js';
import { jsonInstructionFor, parseStructuredText } from './parse.js';

/**
 * Structural view of the SDK message stream — only the fields we consume.
 * Keeps the rest of the codebase (and tests) independent of SDK types.
 */
export interface SdkMessageLike {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  usage?: { input_tokens?: number; output_tokens?: number };
  event?: {
    type: string;
    content_block?: { type: string };
    delta?: { type: string; text?: string; thinking?: string };
  };
  message?: {
    content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
  };
}

export interface SdkQueryHandle extends AsyncIterable<SdkMessageLike> {
  interrupt?: () => Promise<void>;
}

/**
 * Anthropic content blocks we send on image-bearing turns (structural subset of
 * the SDK's `MessageParam` content — see sdk.d.ts `SDKUserMessage`).
 */
export type SdkContentBlockLike =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** Structural subset of the SDK's `SDKUserMessage` (streaming-input prompt element). */
export interface SdkUserMessageLike {
  type: 'user';
  message: { role: 'user'; content: string | SdkContentBlockLike[] };
  parent_tool_use_id: string | null;
}

/**
 * The single boundary to `@anthropic-ai/claude-agent-sdk`'s `query()`.
 * Tests stub this; production wraps the real SDK (see loadSdkQueryFn).
 * `prompt` mirrors the SDK: a plain string, or an AsyncIterable of user
 * messages when the turn carries image content blocks.
 */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SdkUserMessageLike>;
  options?: Record<string, unknown>;
}) => SdkQueryHandle;

/** Lazily import the Agent SDK so BOTTY_MOCK_LLM runs never load it. */
export async function loadSdkQueryFn(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return (params) => sdk.query(params as Parameters<typeof sdk.query>[0]) as unknown as SdkQueryHandle;
}

/** MCP server name for chat tools → fully-qualified tool names `mcp__botty__<name>`. */
export const CHAT_TOOL_SERVER = 'botty';

/** The query() options fragment that exposes chat tools to a turn. */
export interface ChatToolWiring {
  mcpServers: Record<string, unknown>;
  allowedTools: string[];
}

/**
 * Builds the in-process MCP server carrying the chat tools for one query() call.
 * Injectable so tests can stub it; production uses loadSdkToolServerFactory().
 */
export type ToolServerFactory = (tools: ChatToolSpec[]) => ChatToolWiring;

/**
 * Production ToolServerFactory: wraps ChatToolSpecs with the Agent SDK's
 * tool() + createSdkMcpServer() (in-process SDK MCP transport — no subprocess).
 * Lazily imported for the same reason as loadSdkQueryFn.
 */
export async function loadSdkToolServerFactory(): Promise<ToolServerFactory> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return (specs) => {
    const tools = specs.map((s) =>
      sdk.tool(s.name, s.description, s.inputSchema, async (args) => {
        // execute() never throws by contract, but guard anyway — a handler crash
        // must surface to the model as an error result, not kill the turn.
        let result: Record<string, unknown>;
        try {
          result = await s.execute(args as Record<string, unknown>);
        } catch (err) {
          result = { error: (err as Error).message };
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          ...(typeof result.error === 'string' ? { isError: true } : {}),
        };
      }),
    );
    return {
      mcpServers: { [CHAT_TOOL_SERVER]: sdk.createSdkMcpServer({ name: CHAT_TOOL_SERVER, tools }) },
      allowedTools: specs.map((s) => `mcp__${CHAT_TOOL_SERVER}__${s.name}`),
    };
  };
}

/** Resolve a streamed tool_use block name (`mcp__botty__capture_task` or bare) to its spec. */
export function matchChatTool(tools: ChatToolSpec[] | undefined, blockName: string): ChatToolSpec | undefined {
  return tools?.find((t) => t.name === blockName || blockName === `mcp__${CHAT_TOOL_SERVER}__${t.name}`);
}

interface RunResult {
  text: string;
  usage: TokenUsage;
  latencyMs: number;
  sessionId: string | null;
}

/** Max silence between SDK stream messages before we treat the run as hung. */
const STREAM_INACTIVITY_MS = 120_000;

/** Appended to the prompt when a completed chat turn streamed no text and no tool call. */
export const EMPTY_RESPONSE_NUDGE =
  '\n\n(Your previous reply came back empty. Respond to the message above now — with text, or a tool call if one is appropriate.)';

export class StreamTimeoutError extends Error {
  constructor() {
    super(`llm stream produced no message for ${STREAM_INACTIVITY_MS / 1000}s`);
  }
}

/** Iterate an SDK stream, failing if it goes silent (hung subprocess, dead resume id). */
async function* withInactivityTimeout(
  handle: SdkQueryHandle,
  ms: number,
): AsyncGenerator<SdkMessageLike> {
  const it = handle[Symbol.asyncIterator]();
  let completedNormally = false;
  let interrupted = false;
  const interruptOnce = async () => {
    if (interrupted) return;
    interrupted = true;
    try {
      await handle.interrupt?.();
    } catch {
      /* best effort */
    }
  };
  try {
    while (true) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const res = await Promise.race([
          it.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new StreamTimeoutError()), ms);
          }),
        ]);
        if (res.done) {
          completedNormally = true;
          return;
        }
        yield res.value;
      } catch (err) {
        if (err instanceof StreamTimeoutError) await interruptOnce();
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  } finally {
    // Any abnormal exit — the stream itself threw (e.g. subprocess crash) or
    // the consumer tore the generator down early (e.g. a caller that throws
    // on m.is_error mid-loop, like runOnce) — leaves the underlying SDK
    // handle's subprocess running unless we tell it to stop. Best-effort and
    // idempotent so it never fires on normal completion or double-fires
    // after the timeout path above already interrupted.
    if (!completedNormally) await interruptOnce();
  }
}

/**
 * Build the query() prompt for a chat turn: a plain string normally, or (when the
 * turn has image attachments) a single-message AsyncIterable whose content is
 * [image blocks..., text block]. Built fresh per attempt — generators are one-shot.
 */
export function buildChatPrompt(req: ChatTurnRequest): string | AsyncIterable<SdkUserMessageLike> {
  const attachments = req.attachments ?? [];
  if (attachments.length === 0) return req.prompt;
  const content: SdkContentBlockLike[] = [
    ...attachments.map(
      (a): SdkContentBlockLike => ({
        type: 'image',
        source: { type: 'base64', media_type: a.mimeType, data: a.dataBase64 },
      }),
    ),
    { type: 'text', text: req.prompt },
  ];
  return (async function* () {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content },
      parent_tool_use_id: null,
    };
  })();
}

export class SdkLlmClient implements LlmClient {
  private active = new Map<string, SdkQueryHandle>();
  /** Session keys whose in-flight turn was explicitly interrupted — never auto-retried. */
  private interrupted = new Set<string>();

  constructor(
    private readonly deps: {
      queryFn: QueryFn;
      db: Db;
      modelFor: ModelResolver;
      record: DecisionRecorder;
      /** Wraps req.tools into an SDK MCP server; absent → chat runs tool-less. */
      toolServerFactory?: ToolServerFactory;
    },
  ) {}

  async chatTurn(req: ChatTurnRequest): Promise<ChatTurnResult> {
    const stored = this.deps.db.getProviderSessionId(req.sessionKey);
    // Never hand a MockLlmClient session id (or other junk) to the real SDK.
    const resume = stored && !stored.startsWith('mock-') ? stored : null;
    this.interrupted.delete(req.sessionKey);
    let producedOutput = false;
    const attemptReq: ChatTurnRequest = {
      ...req,
      onEvent: (e) => {
        if (e.type === 'text' || e.type === 'tool_use') producedOutput = true;
        req.onEvent(e);
      },
    };
    let result: ChatTurnResult;
    try {
      result = await this.chatAttempt(attemptReq, resume);
    } catch (err) {
      // A resumed session can be stale/expired and hang or fail — retry once
      // fresh, but only when the failed attempt streamed nothing (a retry after
      // partial output would re-stream duplicate text into the same turn) and
      // the failure wasn't the user's own interrupt.
      if (resume && !producedOutput && !this.interrupted.has(req.sessionKey)) {
        result = await this.chatAttempt(attemptReq, null);
      } else {
        throw err;
      }
    }
    // Empty-response recovery: the run succeeded but produced neither text nor a
    // tool call — retry once with a continuation nudge instead of ending the turn
    // with a blank assistant message. Both attempts land in ai_decisions.
    if (!producedOutput && result.text.trim() === '' && !this.interrupted.has(req.sessionKey)) {
      console.warn(
        `[llm] empty chat response for session ${req.sessionKey} — retrying once with continuation nudge`,
      );
      const nowStored = this.deps.db.getProviderSessionId(req.sessionKey);
      const nudged: ChatTurnRequest = {
        ...attemptReq,
        prompt: `${req.prompt}${EMPTY_RESPONSE_NUDGE}`,
      };
      return await this.chatAttempt(nudged, nowStored && !nowStored.startsWith('mock-') ? nowStored : null);
    }
    return result;
  }

  private async chatAttempt(req: ChatTurnRequest, resume: string | null): Promise<ChatTurnResult> {
    const model = this.deps.modelFor('chat');
    const started = Date.now();
    // Chat tools ride in as an in-process SDK MCP server; `tools: []` still
    // disables every built-in tool (Bash, Read, …) — only our four are exposed.
    const toolWiring =
      req.tools?.length && this.deps.toolServerFactory ? this.deps.toolServerFactory(req.tools) : null;
    const handle = this.deps.queryFn({
      prompt: buildChatPrompt(req),
      options: {
        model,
        systemPrompt: req.systemPrompt,
        includePartialMessages: true,
        tools: [],
        ...(toolWiring ? { mcpServers: toolWiring.mcpServers, allowedTools: toolWiring.allowedTools } : {}),
        permissionMode: 'dontAsk',
        maxTurns: 8,
        ...(resume ? { resume } : {}),
      },
    });
    this.active.set(req.sessionKey, handle);

    let streamed = '';
    let resultText = '';
    let sessionId: string | null = null;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let thinkingOpen = false;
    let error: string | null = null;
    let thrown: unknown;

    try {
      for await (const m of withInactivityTimeout(handle, STREAM_INACTIVITY_MS)) {
        if (m.session_id) sessionId = m.session_id;
        if (m.type === 'stream_event' && m.event) {
          const e = m.event;
          if (e.type === 'content_block_start' && e.content_block?.type === 'thinking') {
            thinkingOpen = true;
            req.onEvent({ type: 'thinking', on: true });
          } else if (e.type === 'content_block_stop' && thinkingOpen) {
            thinkingOpen = false;
            req.onEvent({ type: 'thinking', on: false });
          } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
            streamed += e.delta.text;
            req.onEvent({ type: 'text', text: e.delta.text });
          }
        } else if (m.type === 'assistant') {
          for (const block of m.message?.content ?? []) {
            if (block.type === 'tool_use' && block.name) {
              // Our chat tools stream as `mcp__botty__<name>` — emit the friendly
              // name plus a short input-derived summary for the UIs.
              const spec = matchChatTool(req.tools, block.name);
              if (spec) {
                req.onEvent({
                  type: 'tool_use',
                  name: spec.name,
                  summary: spec.summarize((block.input ?? {}) as Record<string, unknown>),
                });
              } else {
                req.onEvent({ type: 'tool_use', name: block.name });
              }
            }
          }
        } else if (m.type === 'result') {
          usage = {
            inputTokens: m.usage?.input_tokens ?? 0,
            outputTokens: m.usage?.output_tokens ?? 0,
          };
          if (m.is_error) error = m.errors?.join('; ') || `llm error: ${m.subtype ?? 'unknown'}`;
          else if (typeof m.result === 'string' && m.result.length > 0) resultText = m.result;
        }
      }
    } catch (err) {
      // Stream threw (inactivity timeout, subprocess crash) — still record the
      // call in ai_decisions below, then rethrow.
      thrown = err;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      this.active.delete(req.sessionKey);
      if (thinkingOpen) req.onEvent({ type: 'thinking', on: false });
      req.onEvent({ type: 'done' });
    }

    const text = resultText || streamed;
    const latencyMs = Date.now() - started;
    // Never persist a session id from a run that died mid-stream.
    if (sessionId && thrown === undefined) this.deps.db.setProviderSessionId(req.sessionKey, sessionId);
    this.deps.record({
      kind: 'chat_turn',
      // Attachment binaries never land in ai_decisions — count + mime types only.
      input: {
        prompt: req.prompt,
        ...(req.attachments?.length ? { attachments: req.attachments.map((a) => a.mimeType) } : {}),
      },
      output: error ? undefined : { text },
      model,
      latencyMs,
      inputTokens: usage.inputTokens || null,
      outputTokens: usage.outputTokens || null,
      relatedRef: req.sessionKey,
      error,
    });
    if (thrown !== undefined) throw thrown;
    if (error) throw new Error(error);
    return { text, providerSessionId: sessionId ?? resume ?? '', usage };
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const model = this.deps.modelFor(req.task);
    const system = req.system + jsonInstructionFor(req.schema);
    let latencyMs = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let lastText = '';

    const attempt = async (prompt: string): Promise<{ text: string } | { failed: string }> => {
      const r = await this.runOnce(model, system, prompt);
      latencyMs += r.latencyMs;
      inputTokens += r.usage.inputTokens;
      outputTokens += r.usage.outputTokens;
      lastText = r.text;
      return { text: r.text };
    };

    const baseDecision = {
      kind: req.task,
      input: { system: req.system, prompt: req.prompt },
      model,
      relatedRef: req.relatedRef ?? null,
    };

    try {
      const first = await attempt(req.prompt);
      let parsed = parseStructuredText('text' in first ? first.text : '', req.schema);
      if (!parsed.ok) {
        // One retry with the validation error appended.
        const retryPrompt =
          `${req.prompt}\n\nYour previous response could not be used: ${parsed.error}\n` +
          `Previous response (for reference):\n${lastText.slice(0, 2000)}\n` +
          `Return ONLY a corrected JSON object.`;
        const second = await attempt(retryPrompt);
        parsed = parseStructuredText('text' in second ? second.text : '', req.schema);
      }
      if (!parsed.ok) {
        this.deps.record({
          ...baseDecision,
          latencyMs,
          inputTokens: inputTokens || null,
          outputTokens: outputTokens || null,
          error: `parse failed after retry: ${parsed.error}`,
          output: { rawText: lastText.slice(0, 4000) },
        });
        throw new LlmParseError(`LLM ${req.task} output failed validation after retry: ${parsed.error}`, lastText);
      }
      this.deps.record({
        ...baseDecision,
        output: parsed.value,
        latencyMs,
        inputTokens: inputTokens || null,
        outputTokens: outputTokens || null,
      });
      return parsed.value;
    } catch (err) {
      if (err instanceof LlmParseError) throw err;
      this.deps.record({
        ...baseDecision,
        latencyMs,
        // Tokens consumed by any completed attempt before the failure.
        inputTokens: inputTokens || null,
        outputTokens: outputTokens || null,
        error: (err as Error).message,
      });
      throw err;
    }
  }

  async interrupt(sessionKey: string): Promise<void> {
    const handle = this.active.get(sessionKey);
    if (handle?.interrupt) {
      // Mark before interrupting so a resulting attempt failure is never
      // auto-retried (which would silently regenerate the stopped answer).
      this.interrupted.add(sessionKey);
      await handle.interrupt();
    }
  }

  /** One ephemeral (non-persisted, tool-less, low-maxTurns) SDK run; returns the final text. */
  private async runOnce(model: string, systemPrompt: string, prompt: string): Promise<RunResult> {
    const started = Date.now();
    const handle = this.deps.queryFn({
      prompt,
      options: {
        model,
        systemPrompt,
        tools: [],
        permissionMode: 'dontAsk',
        maxTurns: 2,
        persistSession: false,
      },
    });
    let assistantText = '';
    let resultText = '';
    let sessionId: string | null = null;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    for await (const m of withInactivityTimeout(handle, STREAM_INACTIVITY_MS)) {
      if (m.session_id) sessionId = m.session_id;
      if (m.type === 'assistant') {
        for (const block of m.message?.content ?? []) {
          if (block.type === 'text' && block.text) assistantText += block.text;
        }
      } else if (m.type === 'result') {
        usage = {
          inputTokens: m.usage?.input_tokens ?? 0,
          outputTokens: m.usage?.output_tokens ?? 0,
        };
        if (m.is_error) throw new Error(m.errors?.join('; ') || `llm error: ${m.subtype ?? 'unknown'}`);
        if (typeof m.result === 'string' && m.result.length > 0) resultText = m.result;
      }
    }
    return { text: resultText || assistantText, usage, latencyMs: Date.now() - started, sessionId };
  }
}
