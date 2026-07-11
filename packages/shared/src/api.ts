import { z } from 'zod';
import {
  AiDecisionSummarySchema,
  ChatTurnSchema,
  PendingActionSchema,
  SourceCheckSchema,
  TaskSchema,
  TickLogSchema,
} from './types.js';

// ---------- REST request bodies ----------

export const ChatAttachmentSchema = z.object({
  mimeType: z.string(), // image/png | image/jpeg | image/webp | image/gif
  dataBase64: z.string().max(7_000_000), // ~5MB binary
  name: z.string().optional(),
});
export type ChatAttachment = z.infer<typeof ChatAttachmentSchema>;

export const ChatMessageRequestSchema = z.object({
  text: z.string().min(1),
  attachments: z.array(ChatAttachmentSchema).max(4).optional(),
  /** WhatsApp-style reply: id of the chat turn being quoted. */
  quotedTurnId: z.string().optional(),
});

export const TaskActionRequestSchema = z.object({
  action: z.enum(['done', 'snooze', 'dismiss', 'reopen', 'priority']),
  // User-initiated snooze isn't clamped to the AI judgment's 1-14 day promise
  // (loop/actions.ts:95) but still needs a sane ceiling — a year covers any
  // legitimate "come back to this later" use.
  snoozeDays: z.number().int().min(1).max(365).optional(),
  // Exact wall-clock instant to snooze until (e.g. "tomorrow 9am"); takes
  // precedence over snoozeDays when both are present. Must include an
  // offset/zone (offset: true) since callers compute this from local time.
  snoozeUntil: z.string().datetime({ offset: true }).optional(),
  reason: z.string().optional(),
  // 1=HIGH .. 3=LOW everywhere (DB, API, UI) — see docs/specs/data-model.md.
  priority: z.number().int().min(1).max(3).optional(),
});

export const ConfigSaveRequestSchema = z.object({ content: z.string() });
export const MuteRequestSchema = z.object({ until: z.string().nullable() });

export const CONFIG_FILE_NAMES = ['persona', 'team', 'heartbeat'] as const;
export type ConfigFileName = (typeof CONFIG_FILE_NAMES)[number];

// ---------- WebSocket events (server -> client) ----------

export const WsEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat.chunk'), payload: z.object({ turnId: z.string(), delta: z.string() }) }),
  z.object({ type: z.literal('chat.thinking'), payload: z.object({ turnId: z.string(), on: z.boolean() }) }),
  z.object({
    type: z.literal('chat.toolUse'),
    payload: z.object({ turnId: z.string(), name: z.string(), summary: z.string().optional() }),
  }),
  z.object({ type: z.literal('chat.done'), payload: z.object({ turnId: z.string(), turn: ChatTurnSchema }) }),
  z.object({ type: z.literal('chat.error'), payload: z.object({ turnId: z.string(), error: z.string() }) }),
  // Always a FULL open-board snapshot, never a delta of just the touched
  // task(s) — every sender must broadcast the full result of
  // db.listTasks('open') after a write (open tasks only, not the whole
  // table). Consumers are free to treat `tasks` as authoritative (e.g.
  // derive an open-task count from it) without merging against prior state.
  z.object({ type: z.literal('tasks.updated'), payload: z.object({ tasks: z.array(TaskSchema) }) }),
  z.object({
    type: z.literal('notification'),
    payload: z.object({
      id: z.string(),
      taskId: z.string().nullable(),
      kind: z.string(),
      message: z.string(),
      score: z.number().nullable(),
    }),
  }),
  // Consent-gated external MCP tool calls (mcp.json `mode: action`). Queued by
  // the chat model, resolved by the user. REST: GET /api/actions?status=…,
  // POST /api/actions/:id/approve, POST /api/actions/:id/dismiss — each returns
  // { action }. `action.resolved` fires for every terminal transition
  // (executed / failed / dismissed / expired).
  z.object({ type: z.literal('action.pending'), payload: z.object({ action: PendingActionSchema }) }),
  z.object({ type: z.literal('action.resolved'), payload: z.object({ action: PendingActionSchema }) }),
  z.object({ type: z.literal('tick.completed'), payload: z.object({ tick: TickLogSchema }) }),
  z.object({ type: z.literal('source.checked'), payload: z.object({ check: SourceCheckSchema }) }),
  z.object({ type: z.literal('decision.recorded'), payload: z.object({ decision: AiDecisionSummarySchema }) }),
  z.object({
    type: z.literal('config.changed'),
    payload: z.object({
      name: z.string(),
      // Parser warnings from the reloaded file, when any. For heartbeat.md a
      // warning-producing hot reload keeps serving the last-known-good config;
      // these warnings describe the pending (rejected) content.
      warnings: z.array(z.string()).optional(),
    }),
  }),
]);
export type WsEvent = z.infer<typeof WsEventSchema>;
export type WsEventType = WsEvent['type'];
