import { BriefingOutputSchema, type Task } from '@botty/shared';
import type { Bus } from '../bus/index.js';
import type { Db } from '../db/index.js';
import type { HeartbeatConfig } from '../config/parse.js';
import type { LlmClient } from '../llm/types.js';
import { notifyMacos, type MacNotifier } from './notify-macos.js';

/**
 * Morning/evening briefings (docs/specs/loop.md "Briefings"). Content is
 * assembled from deterministic queries and rendered by the LLM into
 * { title, body }. Delivered as a proactive_log row + WS notification + macOS
 * notification. Briefings IGNORE the notify caps — they ARE the digest.
 */

export type BriefKind = 'morning_brief' | 'evening_brief';

export interface BriefingDeps {
  db: Db;
  bus: Bus;
  llm: LlmClient;
  config: { heartbeat(): HeartbeatConfig; persona(): string };
  macNotifier?: MacNotifier;
}

export const BRIEFING_SYSTEM = [
  "You write botty's daily briefings for its user. Input is a set of raw lists (calendar,",
  'tasks, completions). Produce { title, body }: title is one short line; body is tight',
  'markdown — a few sections with bullets, no filler, no preamble. Mention only what is in',
  'the input. If a section is empty, omit it. Morning briefs look forward (today); evening',
  'briefs look back (what happened) and flag what is still open.',
].join('\n');

function startOfLocalDay(now: Date, offsetDays = 0): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function taskLine(t: Task): string {
  const bits = [`[P${t.priority}] ${t.description.slice(0, 140)}`];
  if (t.dueDate) bits.push(`due ${t.dueDate}`);
  if (t.requesterName) bits.push(`from ${t.requesterName}`);
  return `- ${bits.join(' · ')}`;
}

export function buildBriefingPrompt(db: Db, kind: BriefKind, nowIso: string): string {
  const now = new Date(nowIso);
  const dayStart = startOfLocalDay(now).toISOString();
  const dayEnd = startOfLocalDay(now, 1).toISOString();

  const events = db.eventsStartingBetween(dayStart, dayEnd);
  const eventLines = events.map((e) => {
    const bits = [`${e.startAt} — ${e.title}`];
    if (e.location) bits.push(`@ ${e.location}`);
    return `- ${bits.join(' ')}`;
  });

  const open = [...db.openTasks()]
    .sort((a, b) => {
      // Priority scale is 1 (HIGH) .. 3 (LOW) — ascending puts HIGH first.
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999');
    })
    .slice(0, 10);

  const stale = db.staleTasks(nowIso, 5).slice(0, 5);

  // Morning brief reports yesterday's completions; evening brief reports today's.
  const [doneFrom, doneTo] =
    kind === 'morning_brief'
      ? [startOfLocalDay(now, -1).toISOString(), dayStart]
      : [dayStart, dayEnd];
  const completions = db
    .listTasks('done')
    .filter((t) => t.doneAt !== null && t.doneAt >= doneFrom && t.doneAt < doneTo)
    .slice(0, 10);

  const sections = [
    `Briefing kind: ${kind}`,
    `Current time: ${nowIso}`,
    `## Today's calendar\n${eventLines.join('\n') || '(none)'}`,
    `## Top open tasks\n${open.map(taskLine).join('\n') || '(none)'}`,
    `## Stale tasks (no update in 5+ days)\n${stale.map(taskLine).join('\n') || '(none)'}`,
    `## ${kind === 'morning_brief' ? "Yesterday's" : "Today's"} completions\n${
      completions.map(taskLine).join('\n') || '(none)'
    }`,
  ];
  return sections.join('\n\n');
}

/** Run one briefing end to end. Returns the proactive_log id, or null on failure. */
export async function runBriefing(
  deps: BriefingDeps,
  kind: BriefKind,
  nowIso = new Date().toISOString(),
): Promise<string | null> {
  const { db, bus, llm } = deps;
  const mac = deps.macNotifier ?? notifyMacos;
  try {
    const prompt = buildBriefingPrompt(db, kind, nowIso);
    const out = await llm.structured({
      task: 'briefing',
      system: BRIEFING_SYSTEM,
      schema: BriefingOutputSchema,
      prompt,
      relatedRef: `${kind}:${nowIso.slice(0, 10)}`,
    });
    const message = `**${out.title}**\n\n${out.body}`;
    const row = db.insertProactiveLog({
      taskId: null,
      surfaceKind: kind,
      message,
      trigger: 'schedule',
      surfacedAt: nowIso,
    });
    bus.broadcast({
      type: 'notification',
      payload: { id: row.id, taskId: null, kind, message, score: null },
    });
    try {
      mac(out.title, out.body.slice(0, 240));
    } catch {
      /* swallowed */
    }
    return row.id;
  } catch (err) {
    console.error(`[loop] ${kind} failed:`, (err as Error).message);
    return null;
  }
}
