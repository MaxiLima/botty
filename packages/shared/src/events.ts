import { z } from 'zod';
import { SOURCES } from './constants.js';

/** Normalized event emitted by every SourceAdapter (agent) and produced by the simulator. */
export const SourceEventSchema = z.object({
  source: z.enum(SOURCES),
  externalId: z.string(),
  kind: z.string(), // slack: dm|mention|channel · gmail: email · gcal: event · jira: issue · github: pr|issue
  actor: z.object({
    handle: z.string().optional(),
    email: z.string().optional(),
    displayName: z.string().optional(),
  }),
  /** 'outbound' = sent BY the user (their own reply in a thread). Evidence for the resolution sweep; never task-extracted. */
  direction: z.enum(['inbound', 'outbound']).default('inbound'),
  text: z.string(),
  threadRef: z.string().optional(),
  occurredAt: z.string(), // ISO-8601
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type SourceEvent = z.infer<typeof SourceEventSchema>;

/** Scenario file format for the simulator. */
export const ScenarioEventSchema = z.object({
  atMinute: z.number(),
  source: z.enum(SOURCES),
  kind: z.string(),
  actor: SourceEventSchema.shape.actor.optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  text: z.string(),
  threadRef: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Backfill history event: same shape as a timeline event but atMinute is negative
 * (minutes BEFORE scenario start). Never clock-released — served only by the
 * GET /:source/history endpoint for the agent's backfill run.
 */
export const HistoryEventSchema = ScenarioEventSchema.refine((e) => e.atMinute < 0, {
  message: 'history events must have atMinute < 0 (minutes before scenario start)',
});

export const ScenarioSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  people: z
    .array(z.object({ name: z.string(), slackHandle: z.string().optional(), email: z.string().optional() }))
    .default([]),
  events: z.array(ScenarioEventSchema),
  history: z.array(HistoryEventSchema).default([]),
});
export type Scenario = z.infer<typeof ScenarioSchema>;
export type ScenarioEvent = z.infer<typeof ScenarioEventSchema>;
