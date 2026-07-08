# LLM layer — Claude Agent SDK

All model access goes through **one module**: `packages/agent/src/llm/`. Nothing else imports the
SDK. The public surface is the `LlmClient` interface so the rest of the codebase is
SDK-agnostic and tests can inject a `MockLlmClient`.

## Provider

`@anthropic-ai/claude-agent-sdk` (TypeScript). It authenticates via the user's existing Claude
Code login (subscription-backed — no API key required; it resolves the same credentials Claude
Code uses). **Implementation note for the builder agent:** verify the current SDK API against
https://docs.claude.com/en/api/agent-sdk/typescript (WebFetch) before writing code — function
names below describe OUR wrapper, not the SDK. Do not guess SDK symbols; read the docs. The SDK's
`query()` generator with `options.resume` / session management is the expected primitive.

## Interface

```ts
// packages/agent/src/llm/types.ts
export interface LlmClient {
  /** Streaming chat turn on a resumable session. */
  chatTurn(req: {
    sessionKey: string;                 // our sessions.id; provider id persisted/rehydrated
    prompt: string;
    attachments?: ChatTurnAttachment[]; // images, passed as Anthropic image content blocks
    systemPrompt: string;               // assembled from PERSONA.md + context
    onEvent: (e: ChatStreamEvent) => void; // {type:'text'|'thinking'|'tool_use'|'done', ...}
  }): Promise<{ text: string; providerSessionId: string; usage: TokenUsage }>;

  /** One-shot structured call. Validates against the zod schema, retries once on parse failure. */
  structured<T>(req: {
    task: LlmTask;                      // 'chat'|'classification'|'extraction'|'judgment'|'briefing'|'resolution'
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    relatedRef?: string;                // raw_log id / tick id for ai_decisions
  }): Promise<T>;

  interrupt(sessionKey: string): Promise<void>;
}
```

## Task → model routing

From `@botty/shared` constants, overridable via `settings` table key `llm.models`:

```
chat: claude-sonnet-5 · judgment: claude-sonnet-5 · briefing: claude-sonnet-5
classification: claude-haiku-4-5 · extraction: claude-haiku-4-5
resolution: claude-sonnet-5   (wrongly closing a task is worse than a missed nudge)
```

`claude-opus-4-8` is a valid override value. Use exact IDs — no date suffixes.

## Decision recording (mandatory)

Every `structured()` call writes an `ai_decisions` row: kind, full `input_json`
(`{system, prompt}`), `output_json`, model, latency, tokens, `related_ref`, error (on failure).
`chatTurn` writes a row with kind `chat_turn` (input = prompt only, output = final text) — chat
history itself lives in `chat_turns`.

## Structured output strategy

The Agent SDK returns text; `structured()` must instruct the model to emit a single JSON object
(no prose, no code fence — but tolerate and strip fences), parse, validate with zod, and on
failure retry once with the validation error appended. Persistent failure throws `LlmParseError`
and records the error in `ai_decisions`. Keep `maxTurns` low (1–2) and disallow tools for
structured calls.

## Sessions

- Chat uses one active session at a time (single continuous thread in the UI). On idle > 30 min
  the session is *sealed*: a summary is generated (task `briefing` model), stored on
  `sessions.summary`, status → `sealed`; the next message starts a fresh provider session whose
  system prompt includes recent sealed summaries.
- `providerSessionId` is persisted on our `sessions` row and passed back for resume.

## MockLlmClient

For unit tests and `BOTTY_MOCK_LLM=1`: deterministic canned outputs keyed by task kind
(classifier says yes iff heuristic strings present; extractor does a trivial regex extraction;
judgment returns skip-everything). Lives in `packages/agent/src/llm/mock.ts`.
