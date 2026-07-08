import type { z } from 'zod';
import type { LlmTask } from '@botty/shared';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ChatStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; on: boolean }
  | { type: 'tool_use'; name: string; summary?: string }
  | { type: 'done' };

/** Inline image sent alongside a chat prompt (agent-internal; not part of @botty/shared). */
export interface ChatTurnAttachment {
  mimeType: string;
  dataBase64: string;
}

export interface ChatTurnRequest {
  /** Our sessions.id; the provider session id is persisted/rehydrated internally. */
  sessionKey: string;
  prompt: string;
  /** Images passed to the model as Anthropic image content blocks before the text. */
  attachments?: ChatTurnAttachment[];
  /** Assembled from PERSONA.md + memory context. */
  systemPrompt: string;
  onEvent: (e: ChatStreamEvent) => void;
}

export interface ChatTurnResult {
  text: string;
  providerSessionId: string;
  usage: TokenUsage;
}

export interface StructuredRequest<T> {
  task: Exclude<LlmTask, 'chat'>;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** raw_log id / tick id / session id — lands in ai_decisions.related_ref. */
  relatedRef?: string;
}

export interface LlmClient {
  /** Streaming chat turn on a resumable session. */
  chatTurn(req: ChatTurnRequest): Promise<ChatTurnResult>;
  /** One-shot structured call. Validates against the zod schema, retries once on parse failure. */
  structured<T>(req: StructuredRequest<T>): Promise<T>;
  interrupt(sessionKey: string): Promise<void>;
}

/** Thrown when the model's output can't be parsed/validated even after one retry. */
export class LlmParseError extends Error {
  constructor(
    message: string,
    public readonly rawText: string,
  ) {
    super(message);
    this.name = 'LlmParseError';
  }
}

/** Resolves the model for a task, honoring the `llm.models` settings override. */
export type ModelResolver = (task: LlmTask) => string;

/** Records an ai_decisions row + emits decision.recorded. Returns the decision id. */
export type DecisionRecorder = (input: {
  kind: string;
  input: unknown;
  output?: unknown;
  model: string;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  relatedRef?: string | null;
  error?: string | null;
}) => string;
