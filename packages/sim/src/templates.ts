import { z } from 'zod';
import { SOURCES, SourceEventSchema } from '@botty/shared';

/**
 * Canned inject templates served by GET /control/templates and used by the
 * control panel's inject form. Scenario files may ship their own under a
 * top-level `templates` key (outside the frozen ScenarioSchema, parsed here).
 */
export const InjectTemplateSchema = z.object({
  id: z.string(),
  label: z.string(),
  event: z.object({
    source: z.enum(SOURCES),
    kind: z.string(),
    actor: SourceEventSchema.shape.actor.optional(),
    direction: z.enum(['inbound', 'outbound']).optional(),
    text: z.string(),
    threadRef: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type InjectTemplate = z.infer<typeof InjectTemplateSchema>;

export const DEFAULT_TEMPLATES: InjectTemplate[] = [
  {
    id: 'slack-dm-urgent',
    label: 'Urgent Slack DM from Marian',
    event: {
      source: 'slack',
      kind: 'dm',
      actor: { handle: '@marian', displayName: 'Marian Gutiérrez' },
      text: 'Necesito que mires esto ya — can you jump on a call in 10? Prod alert en fraud-rules.',
      threadRef: 'T-INJ-1',
    },
  },
  {
    // Pairs with slack-dm-urgent (same thread): inject after it to watch the
    // resolution sweep auto-close the task it created.
    id: 'slack-outbound-done',
    label: 'My reply in Marian’s thread: done',
    event: {
      source: 'slack',
      kind: 'dm',
      direction: 'outbound',
      actor: { displayName: 'me' },
      text: 'Listo, ya está resuelto — deployed the fix, review done ✅',
      threadRef: 'T-INJ-1',
    },
  },
  {
    id: 'slack-dm-social',
    label: 'Social noise DM from Sofi',
    event: {
      source: 'slack',
      kind: 'dm',
      actor: { handle: '@sofi', displayName: 'Sofi Blanco' },
      text: 'jajaja terrible el meme que mandó Diego 😂',
    },
  },
  {
    id: 'gmail-urgent',
    label: 'Urgent email from Sofi',
    event: {
      source: 'gmail',
      kind: 'email',
      actor: { email: 'sofi@acme.example', displayName: 'Sofi Blanco' },
      text: 'Subject: [URGENTE] Rollback plan R-77\n\nPlease send me the rollback plan for rule R-77 before 15:00 — legal lo está pidiendo.',
    },
  },
  {
    id: 'gcal-soon',
    label: 'Calendar event starting in 30 min',
    event: {
      source: 'gcal',
      kind: 'event',
      text: 'Incident review — chargeback spike',
      meta: {
        startAtMinute: 30,
        durationMin: 30,
        attendees: ['marian@acme.example', 'yo@maxolabs.io'],
        location: 'Meet',
      },
    },
  },
  {
    id: 'jira-assigned',
    label: 'New Jira issue assigned',
    event: {
      source: 'jira',
      kind: 'issue',
      actor: { displayName: 'Jira' },
      text: 'FRAUD-9999: Investigate anomalous approval rate drop on MX',
      meta: { key: 'FRAUD-9999', status: 'To Do', url: 'https://jira.acme.example/browse/FRAUD-9999' },
    },
  },
  {
    id: 'github-pr',
    label: 'GitHub PR review requested',
    event: {
      source: 'github',
      kind: 'pr',
      actor: { handle: 'diegopaz', displayName: 'Diego Paz' },
      text: 'Review requested: acme-example/fraud-rules#501 — Hotfix: cap velocity window at 24h',
      meta: { repo: 'acme-example/fraud-rules', number: 501, state: 'open', url: 'https://github.com/acme-example/fraud-rules/pull/501' },
    },
  },
];
