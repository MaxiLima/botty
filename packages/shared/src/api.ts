import { z } from 'zod';
import {
  AiDecisionSummarySchema,
  ChatTurnSchema,
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
  snoozeDays: z.number().optional(),
  reason: z.string().optional(),
  priority: z.number().optional(),
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
  z.object({ type: z.literal('tick.completed'), payload: z.object({ tick: TickLogSchema }) }),
  z.object({ type: z.literal('source.checked'), payload: z.object({ check: SourceCheckSchema }) }),
  z.object({ type: z.literal('decision.recorded'), payload: z.object({ decision: AiDecisionSummarySchema }) }),
  z.object({ type: z.literal('config.changed'), payload: z.object({ name: z.string() }) }),
]);
export type WsEvent = z.infer<typeof WsEventSchema>;
export type WsEventType = WsEvent['type'];
