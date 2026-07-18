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

// ---------- Onboarding wizard (docs/specs/onboarding.md) ----------
// Both clients collect the same structured answers object; the agent renders and
// writes the files (config/render.ts). Clients never generate markdown/JSON.

/** Wizard steps that write something. Welcome and Review are not listed — they own no file. */
export const ONBOARDING_STEPS = ['persona', 'team', 'sources', 'mcp', 'schedule', 'directives'] as const;
export const OnboardingStepNameSchema = z.enum(ONBOARDING_STEPS);
export type OnboardingStepName = z.infer<typeof OnboardingStepNameSchema>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const HhMmSchema = z.string().regex(HHMM, 'expected HH:MM');

/**
 * persona.md is free-form prose, so answers come in one of three shapes:
 * - `fields`: first-run guided composition — the renderer assembles the template sections.
 * - `sections`: re-run editing — current file text per template section, edited in place.
 * - `raw`: degraded path — the file no longer matches the template headings; full-file editor.
 */
export const PersonaAnswersSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('fields'),
    name: z.string(),
    role: z.string(),
    addressAs: z.string(),
    timezone: z.string(),
    tone: z.string(),
    banned: z.string(),
  }),
  z.object({
    kind: z.literal('sections'),
    identity: z.string(),
    about: z.string(),
    /** Original `## About …` heading text (e.g. "About Maxo") — preserved on re-render. */
    aboutHeading: z.string().optional(),
    voice: z.string(),
    banned: z.string(),
  }),
  z.object({ kind: z.literal('raw'), content: z.string() }),
]);
export type PersonaAnswers = z.infer<typeof PersonaAnswersSchema>;

export const TeamMemberAnswerSchema = z.object({
  name: z.string().min(1),
  weight: z.enum(['CRITICAL', 'HIGH', 'NORMAL']),
  slackHandle: z.string().optional(),
  email: z.string().optional(),
  cadence: z.string().optional(),
  notes: z.string().optional(),
});
export type TeamMemberAnswer = z.infer<typeof TeamMemberAnswerSchema>;
export const TeamAnswersSchema = z.object({ people: z.array(TeamMemberAnswerSchema) });
export type TeamAnswers = z.infer<typeof TeamAnswersSchema>;

export const SourceToggleSchema = z.object({
  enabled: z.boolean(),
  /** Poll interval override in minutes; absent ⇒ mode default (SOURCE_INTERVALS_*). */
  intervalMin: z.number().int().min(1).optional(),
});
export const SourcesAnswersSchema = z.object({
  slack: SourceToggleSchema,
  gmail: SourceToggleSchema,
  gcal: SourceToggleSchema,
  jira: SourceToggleSchema,
  github: SourceToggleSchema,
});
export type SourcesAnswers = z.infer<typeof SourcesAnswersSchema>;

/** Mirrors McpConfigSchema (packages/agent/src/config/mcp.ts) — stdio only in v1. */
export const McpServerAnswerSchema = z.object({
  type: z.literal('stdio').default('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  tools: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.enum(['read', 'action'])).default({}),
});
export type McpServerAnswer = z.infer<typeof McpServerAnswerSchema>;
export const McpAnswersSchema = z.object({
  servers: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), McpServerAnswerSchema),
});
export type McpAnswers = z.infer<typeof McpAnswersSchema>;

export const ScheduleAnswersSchema = z.object({
  workingHours: z.object({ start: HhMmSchema, end: HhMmSchema }),
  quietHours: z.object({ start: HhMmSchema, end: HhMmSchema }),
  /** 0=Sun .. 6=Sat, same convention as HEARTBEAT_DEFAULTS.activeDays. */
  activeDays: z.array(z.number().int().min(0).max(6)),
  tickIntervalMin: z.number().int().min(1),
  morningBriefAt: HhMmSchema,
  eveningBriefAt: HhMmSchema,
});
export type ScheduleAnswers = z.infer<typeof ScheduleAnswersSchema>;

export const ChecklistItemAnswerSchema = z.object({
  every: z.number().int().min(1),
  unit: z.enum(['m', 'h', 'd']),
  text: z.string().min(1),
});
export const DirectivesAnswersSchema = z.object({
  instructions: z.string(),
  thisWeek: z.string(),
  checklist: z.array(ChecklistItemAnswerSchema),
  /** Curated `## Behavior` subset only — everything else is carried through verbatim at apply. */
  advanced: z.object({
    surfacingThreshold: z.number().int().min(1).max(10).optional(),
    maxProactivePerHour: z.number().int().min(0).optional(),
    minGapBetweenNudgesMin: z.number().int().min(0).optional(),
    autoResolveTasks: z.boolean().optional(),
    inferCommitments: z.boolean().optional(),
    commitmentsMaxPerDay: z.number().int().min(0).optional(),
    /** llm.models routing (settings key, not a file). Keys must be LlmTask names. */
    models: z.record(z.string(), z.string()).optional(),
  }),
});
export type DirectivesAnswers = z.infer<typeof DirectivesAnswersSchema>;

export const OnboardingAnswersSchema = z.object({
  persona: PersonaAnswersSchema.optional(),
  team: TeamAnswersSchema.optional(),
  sources: SourcesAnswersSchema.optional(),
  mcp: McpAnswersSchema.optional(),
  schedule: ScheduleAnswersSchema.optional(),
  directives: DirectivesAnswersSchema.optional(),
});
export type OnboardingAnswers = z.infer<typeof OnboardingAnswersSchema>;

/** Per-target mtimes (ms epoch, null = file absent) captured when prefill was served;
 * echoed back on apply so the server can flag files that changed on disk mid-wizard. */
export const OnboardingMtimesSchema = z.object({
  persona: z.number().nullable(),
  team: z.number().nullable(),
  heartbeat: z.number().nullable(),
  mcp: z.number().nullable(),
});
export type OnboardingMtimes = z.infer<typeof OnboardingMtimesSchema>;

export const OnboardingStateSchema = z.object({
  onboarded: z.boolean(),
  completedAt: z.string().nullable(),
  checks: z.object({
    mode: z.enum(['sim', 'real']),
    llmAuth: z.boolean(),
    mockLlm: z.boolean(),
    /** null on non-darwin platforms. */
    notifier: z.boolean().nullable(),
    dataDir: z.string(),
  }),
  prefill: OnboardingAnswersSchema,
  prefillWarnings: z.array(z.string()),
  mtimes: OnboardingMtimesSchema,
});
export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export const OnboardingApplyRequestSchema = z.object({
  answers: OnboardingAnswersSchema,
  /** Steps the user actually visited/confirmed — only their files are written. */
  steps: z.array(OnboardingStepNameSchema).min(1),
  mtimes: OnboardingMtimesSchema.optional(),
});
export type OnboardingApplyRequest = z.infer<typeof OnboardingApplyRequestSchema>;

export const OnboardingApplyResponseSchema = z.object({
  ok: z.boolean(),
  /** Per-file parser/staleness warnings, keyed by file name — same semantics as PUT /api/config/:name. */
  warnings: z.record(z.string(), z.array(z.string())),
});
export type OnboardingApplyResponse = z.infer<typeof OnboardingApplyResponseSchema>;

/** Review-step preview: same body as apply, but only renders — writes nothing.
 * Keeps the one renderer server-side while both clients show diffs/content. */
export const OnboardingPreviewResponseSchema = z.object({
  /** Keyed by target file (persona|team|heartbeat|mcp) for the steps included. */
  files: z.record(
    z.string(),
    z.object({ content: z.string(), current: z.string().nullable(), changed: z.boolean() }),
  ),
  /** Settings the apply would patch (llm.models routing), when any. */
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type OnboardingPreviewResponse = z.infer<typeof OnboardingPreviewResponseSchema>;

export const McpProbeRequestSchema = z.object({ server: McpServerAnswerSchema });
export const McpProbeResponseSchema = z.object({
  ok: z.boolean(),
  tools: z.array(z.string()),
  error: z.string().optional(),
});
export type McpProbeResponse = z.infer<typeof McpProbeResponseSchema>;

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
