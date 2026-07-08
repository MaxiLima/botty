import { DEFAULT_MODELS, AiDecisionSummarySchema, type LlmTask } from '@botty/shared';
import type { AgentEnv } from '../env.js';
import type { Bus } from '../bus/index.js';
import type { Db } from '../db/index.js';
import { MockLlmClient } from './mock.js';
import { SdkLlmClient, loadSdkQueryFn, type QueryFn } from './sdk.js';
import type { DecisionRecorder, LlmClient, ModelResolver } from './types.js';

export type {
  ChatStreamEvent,
  ChatTurnAttachment,
  ChatTurnRequest,
  ChatTurnResult,
  LlmClient,
  StructuredRequest,
  TokenUsage,
} from './types.js';
export { LlmParseError } from './types.js';
export { MockLlmClient, MOCK_SIGNAL_REGEXES } from './mock.js';
export {
  SdkLlmClient,
  buildChatPrompt,
  type QueryFn,
  type SdkQueryHandle,
  type SdkMessageLike,
  type SdkContentBlockLike,
  type SdkUserMessageLike,
} from './sdk.js';
export { parseStructuredText, JSON_ONLY_INSTRUCTION } from './parse.js';

export interface CreateLlmOptions {
  env: Pick<AgentEnv, 'mockLlm'>;
  db: Db;
  bus: Bus;
  /** Inject a stub SDK boundary for tests. Ignored when env.mockLlm is true. */
  queryFn?: QueryFn;
}

/** Task→model routing: DEFAULT_MODELS overridable via settings key `llm.models`. */
export function makeModelResolver(db: Db): ModelResolver {
  return (task: LlmTask) => {
    const overrides = db.getSetting<Partial<Record<LlmTask, string>>>('llm.models');
    return overrides?.[task] ?? DEFAULT_MODELS[task];
  };
}

/** Every LLM call lands in ai_decisions and emits decision.recorded on the bus. */
export function makeDecisionRecorder(db: Db, bus: Bus): DecisionRecorder {
  return (input) => {
    const decision = db.insertAiDecision(input);
    bus.broadcast({
      type: 'decision.recorded',
      payload: { decision: AiDecisionSummarySchema.parse(decision) },
    });
    return decision.id;
  };
}

export async function createLlm(opts: CreateLlmOptions): Promise<LlmClient> {
  const modelFor = makeModelResolver(opts.db);
  const record = makeDecisionRecorder(opts.db, opts.bus);
  if (opts.env.mockLlm) {
    return new MockLlmClient({ db: opts.db, modelFor, record });
  }
  const queryFn = opts.queryFn ?? (await loadSdkQueryFn());
  return new SdkLlmClient({ queryFn, db: opts.db, modelFor, record });
}
