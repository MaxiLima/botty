import { z } from 'zod';
import type { FunnelOutcome } from './constants.js';

// ---------- Domain entities (camelCase; DB layer maps snake_case columns) ----------

export const PersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  slackHandle: z.string().nullable(),
  email: z.string().nullable(),
  weight: z.enum(['CRITICAL', 'HIGH', 'NORMAL']),
  tier: z.union([z.literal(1), z.literal(2)]),
  cadence: z.string().nullable(),
  notes: z.string().nullable(),
  mutedUntil: z.string().nullable(),
  lastInteractionAt: z.string().nullable(),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // enrichments (list endpoints)
  openTaskCount: z.number().optional(),
});
export type Person = z.infer<typeof PersonSchema>;

export const TaskStatusSchema = z.enum(['open', 'snoozed', 'done', 'cancelled', 'merged', 'archived']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  description: z.string(),
  rawText: z.string().nullable(),
  source: z.string(),
  sourceRef: z.string().nullable(),
  status: TaskStatusSchema,
  priority: z.number(),
  requestedBy: z.string().nullable(),
  requesterName: z.string().nullable().optional(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable().optional(),
  dueDate: z.string().nullable(),
  snoozeUntil: z.string().nullable(),
  doneAt: z.string().nullable(),
  surfaceCount: z.number(),
  lastSurfacedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  openTaskCount: z.number().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const DecisionSchema = z.object({
  id: z.string(),
  description: z.string(),
  rationale: z.string().nullable(),
  source: z.string(),
  sourceRef: z.string().nullable(),
  projectId: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const InteractionSchema = z.object({
  id: z.string(),
  personId: z.string().nullable(),
  source: z.string(),
  kind: z.string(),
  direction: z.string(),
  snippet: z.string().nullable(),
  threadRef: z.string().nullable(),
  rawLogId: z.string().nullable(),
  occurredAt: z.string(),
});
export type Interaction = z.infer<typeof InteractionSchema>;

export const ChatTurnSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  meta: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

export const SessionMetaSchema = z.object({
  id: z.string(),
  kind: z.string(),
  summary: z.string().nullable(),
  status: z.enum(['active', 'sealed']),
  createdAt: z.string(),
  lastActiveAt: z.string(),
});
export type SessionMeta = z.infer<typeof SessionMetaSchema>;

export const TaskHistorySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  field: z.string(),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  changedBy: z.string(),
  changedAt: z.string(),
});
export type TaskHistory = z.infer<typeof TaskHistorySchema>;

export const ProactiveLogSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  surfaceKind: z.string(),
  message: z.string(),
  score: z.number().nullable(),
  trigger: z.string().nullable(),
  surfacedAt: z.string(),
  responseType: z.string().nullable(),
  responseReason: z.string().nullable(),
  responseAt: z.string().nullable(),
});
export type ProactiveLogRow = z.infer<typeof ProactiveLogSchema>;

export const TickLogSchema = z.object({
  id: z.string(),
  trigger: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  candidatesIn: z.number().nullable(),
  candidatesAfterRules: z.number().nullable(),
  actionsJson: z.string().nullable(),
  skippedJson: z.string().nullable(),
  judgmentDecisionId: z.string().nullable(),
  error: z.string().nullable(),
});
export type TickLogRow = z.infer<typeof TickLogSchema>;

export const AiDecisionSchema = z.object({
  id: z.string(),
  kind: z.string(),
  inputJson: z.string(),
  outputJson: z.string().nullable(),
  model: z.string(),
  latencyMs: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  relatedRef: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
export type AiDecision = z.infer<typeof AiDecisionSchema>;

export const AiDecisionSummarySchema = AiDecisionSchema.omit({ inputJson: true, outputJson: true });
export type AiDecisionSummary = z.infer<typeof AiDecisionSummarySchema>;

export const RawLogSchema = z.object({
  id: z.string(),
  source: z.string(),
  externalId: z.string(),
  kind: z.string(),
  actor: z.string().nullable(),
  body: z.string(),
  occurredAt: z.string(),
  capturedAt: z.string(),
  /** Funnel verdict lifted from body.meta.funnelOutcome by the Db read layer; absent until stamped. */
  outcome: z.custom<FunnelOutcome>((v) => typeof v === 'string').optional(),
});
export type RawLogRow = z.infer<typeof RawLogSchema>;

export const SourceCheckSchema = z.object({
  id: z.string(),
  source: z.string(),
  checkedAt: z.string(),
  eventsFetched: z.number(),
  eventsNew: z.number(),
  error: z.string().nullable(),
});
export type SourceCheckRow = z.infer<typeof SourceCheckSchema>;

export const CalendarEventSchema = z.object({
  id: z.string(),
  externalId: z.string(),
  title: z.string(),
  startAt: z.string(),
  endAt: z.string().nullable(),
  location: z.string().nullable(),
  attendees: z.string().nullable(), // JSON array string
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

// ---------- inferred commitments ----------

export const CommitmentStatusSchema = z.enum(['open', 'delivered', 'expired', 'dismissed']);
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;

/**
 * A short-lived follow-up inferred from chat ("my interview is tomorrow at 3") —
 * operational state, NOT a task and NOT durable memory. See chat/commitments.ts
 * (extraction) and loop/commitments.ts (tick delivery).
 */
export const CommitmentSchema = z.object({
  id: z.string(),
  description: z.string(),
  dueAt: z.string(),
  sourceTurnId: z.string().nullable(),
  createdAt: z.string(),
  status: CommitmentStatusSchema,
  deliveredAt: z.string().nullable(),
});
export type Commitment = z.infer<typeof CommitmentSchema>;

// ---------- pending actions (consent-gated external MCP tools) ----------

export const PendingActionStatusSchema = z.enum([
  'pending',
  'executed',
  'failed',
  'dismissed',
  'expired',
]);
export type PendingActionStatus = z.infer<typeof PendingActionStatusSchema>;

/**
 * An outward-facing external-MCP tool call (mcp.json `mode: action`) proposed
 * by the chat model but held for explicit user approval — consent-first: the
 * model can queue, never send. Approve → the agent executes the tool through
 * its own MCP client and stores the result; dismiss → nothing runs. Pending
 * entries expire after 24h.
 */
export const PendingActionSchema = z.object({
  id: z.string(),
  /** MCP server key from mcp.json (e.g. 'slack'). */
  server: z.string(),
  /** Tool name on that server (e.g. 'send_message'). */
  tool: z.string(),
  /** JSON-encoded arguments exactly as the model proposed them. */
  argsJson: z.string(),
  /** One-line human-readable description for the approval card. */
  summary: z.string(),
  status: PendingActionStatusSchema,
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  /** JSON-encoded tool result (status executed) or error detail (failed). */
  resultJson: z.string().nullable(),
  /** Chat turn the model proposed this from, when known. */
  sourceTurnId: z.string().nullable(),
});
export type PendingAction = z.infer<typeof PendingActionSchema>;

// ---------- costs report ----------

export const CostTotalsSchema = z.object({
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  /** Calls whose model has no pricing entry — tokens counted, cost not. */
  unpricedCalls: z.number(),
});
export type CostTotals = z.infer<typeof CostTotalsSchema>;

export const CostModelRowSchema = CostTotalsSchema.extend({
  model: z.string(),
  priced: z.boolean(),
});
export type CostModelRow = z.infer<typeof CostModelRowSchema>;

export const CostWindowSchema = z.object({
  totals: CostTotalsSchema,
  /** Keyed by CostCategory; every category is always present. */
  byCategory: z.record(z.string(), CostTotalsSchema),
  /** Models used inside the window, highest cost first. */
  byModel: z.array(CostModelRowSchema),
});
export type CostWindow = z.infer<typeof CostWindowSchema>;

export const CostDayRowSchema = z.object({
  /** UTC day, YYYY-MM-DD. Continuous over the report range (zero-filled). */
  date: z.string(),
  calls: z.number(),
  costUsd: z.number(),
  /** costUsd per CostCategory. */
  byCategory: z.record(z.string(), z.number()),
});
export type CostDayRow = z.infer<typeof CostDayRowSchema>;

export const CostsReportSchema = z.object({
  generatedAt: z.string(),
  windows: z.object({
    today: CostWindowSchema,
    last7d: CostWindowSchema,
    last30d: CostWindowSchema,
    allTime: CostWindowSchema,
  }),
  /** Last 30 UTC days, oldest first. */
  byDay: z.array(CostDayRowSchema),
  /** Effective USD/MTok rates the report was priced with. */
  pricing: z.record(z.string(), z.object({ inputPerMTok: z.number(), outputPerMTok: z.number() })),
});
export type CostsReport = z.infer<typeof CostsReportSchema>;

// ---------- LLM structured-output schemas ----------

export const ClassifierOutputSchema = z.object({
  worthExtracting: z.boolean(),
  confidence: z.number(),
  reason: z.string(),
});
export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

export const ExtractorOutputSchema = z.object({
  tasks: z
    .array(
      z.object({
        description: z.string(),
        requesterName: z.string().optional(),
        dueDate: z.string().optional(),
        priority: z.number().optional(),
      }),
    )
    .default([]),
  decisions: z
    .array(z.object({ description: z.string(), rationale: z.string().optional() }))
    .default([]),
  people: z
    .array(z.object({ name: z.string(), slackHandle: z.string().optional(), email: z.string().optional() }))
    .default([]),
});
export type ExtractorOutput = z.infer<typeof ExtractorOutputSchema>;

export const JudgmentOutputSchema = z.object({
  tickReasoning: z.string(),
  actions: z
    .array(
      z.object({
        type: z.enum(['notify', 'snooze', 'update_priority']),
        taskId: z.string(),
        score: z.number(),
        message: z.string().optional(),
        snoozeDays: z.number().optional(),
        priority: z.number().optional(),
        reasoning: z.string().default(''),
      }),
    )
    .default([]),
  skipped: z
    .array(z.object({ taskId: z.string(), score: z.number().default(0), reason: z.string().default('') }))
    .default([]),
});
export type JudgmentOutput = z.infer<typeof JudgmentOutputSchema>;

export const ResolutionOutputSchema = z.object({
  /** true = the thread shows this task was already handled (or is moot). */
  resolved: z.boolean(),
  confidence: z.number(), // 0-1
  reason: z.string(),
});
export type ResolutionOutput = z.infer<typeof ResolutionOutputSchema>;

export const BriefingOutputSchema = z.object({
  title: z.string(),
  body: z.string(), // markdown
});
export type BriefingOutput = z.infer<typeof BriefingOutputSchema>;

/**
 * Hidden post-turn commitment-extraction pass (chat/commitments.ts). Shares the
 * 'extraction' LlmTask with the funnel's task/decision extractor — a different
 * call site, distinguished by schema shape, not by task. Empty array is the
 * common, correct answer for most chat turns.
 */
export const CommitmentExtractionSchema = z.object({
  commitments: z
    .array(z.object({ description: z.string(), dueAt: z.string() }))
    .default([]),
});
export type CommitmentExtraction = z.infer<typeof CommitmentExtractionSchema>;
