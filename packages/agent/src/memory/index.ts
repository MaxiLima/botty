import type { Task } from '@botty/shared';
import type { Db, FtsHit } from '../db/index.js';
import type { HeartbeatConfig } from '../config/parse.js';

/** The slice of ConfigManager the ContextBuilder needs (kept narrow for tests). */
export interface MemoryConfigSource {
  persona(): string;
  heartbeat(): HeartbeatConfig;
}

/** A loop candidate: a task plus why it's being considered this tick. */
export type ProactiveCandidate = Task & { reminderReason?: string };

export interface Memory {
  /** bm25 FTS over tasks/decisions/interactions/chat with recency tiebreak. */
  search(query: string, opts?: { limit?: number }): FtsHit[];
  /**
   * System prompt for a chat turn: persona + team summary + last 3 sealed session
   * summaries + top-5 recall hits for the user message + open-task one-liners.
   * Capped at ~2k tokens (~8k chars).
   */
  buildChatSystemPrompt(userMessage: string): string;
  /** Context block for the loop's judgment call: instructions + persona excerpt + candidate cards. */
  buildProactiveContext(candidates: ProactiveCandidate[]): string;
}

// ~2k tokens ≈ 8k chars total; per-section caps below.
const TOTAL_BUDGET = 8_000;
const PERSONA_CAP = 3_200;
const SECTION_CAP = 1_400;

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Collapse whitespace so untrusted text can't inject extra prompt lines. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function ageDays(iso: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(iso)) / 86_400_000));
}

export function createMemory(deps: { db: Db; config: MemoryConfigSource }): Memory {
  const { db, config } = deps;

  function taskOneLiner(t: Task): string {
    const bits = [`[P${t.priority}] ${flat(t.description)}`];
    if (t.requesterName) bits.push(`from ${flat(t.requesterName)}`);
    if (t.dueDate) bits.push(`due ${t.dueDate.slice(0, 10)}`);
    return `- ${clip(bits.join(' · '), 160)}`;
  }

  return {
    search(query, opts) {
      return db.ftsSearch(query, opts?.limit ?? 5);
    },

    buildChatSystemPrompt(userMessage) {
      const sections: string[] = [];

      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      sections.push(`Current time: ${new Date().toISOString()} (${tz})`);

      const persona = config.persona().trim();
      if (persona) sections.push(clip(persona, PERSONA_CAP));

      const people = db.listPeople();
      if (people.length > 0) {
        const lines = people
          .filter((p) => p.tier === 1)
          .slice(0, 12)
          .map((p) => {
            const bits = [`${p.name} (${p.weight}`];
            if (p.slackHandle) bits.push(p.slackHandle);
            if (p.email) bits.push(p.email);
            let line = `- ${bits.join(', ')})`;
            if (p.notes) line += ` — ${p.notes}`;
            return clip(line, 160);
          });
        const others = people.filter((p) => p.tier !== 1).length;
        if (others > 0) lines.push(`- (+${others} tier-2 ${others === 1 ? 'person' : 'people'} tracked)`);
        sections.push(clip(`## Team\n${lines.join('\n')}`, SECTION_CAP));
      }

      const summaries = db.recentSealedSummaries(3);
      if (summaries.length > 0) {
        const lines = summaries.map(
          (s) => `- (${s.lastActiveAt.slice(0, 10)}) ${clip(s.summary.replace(/\n+/g, ' '), 300)}`,
        );
        sections.push(clip(`## Recent conversation summaries\n${lines.join('\n')}`, SECTION_CAP));
      }

      const hits = db.ftsSearch(userMessage, 5);
      if (hits.length > 0) {
        const lines = hits.map((h) => {
          // Task hits keep their status: a done/cancelled task must not read as live work.
          let tag = h.kind;
          if (h.kind === 'task') {
            const t = db.getTask(h.refId);
            if (t && t.status !== 'open') {
              tag = `task, ${t.status} ${(t.doneAt ?? t.updatedAt).slice(0, 10)}`;
            }
          }
          return `- [${tag}] ${clip(h.content.replace(/\n+/g, ' '), 220)}`;
        });
        sections.push(clip(`## Possibly relevant memory\n${lines.join('\n')}`, SECTION_CAP));
      }

      const open = db.openTasks().slice(0, 15);
      if (open.length > 0) {
        sections.push(clip(`## Open tasks\n${open.map(taskOneLiner).join('\n')}`, SECTION_CAP));
      }

      return clip(sections.join('\n\n'), TOTAL_BUDGET);
    },

    buildProactiveContext(candidates) {
      const now = Date.now();
      const sections: string[] = [];

      const hb = config.heartbeat();
      if (hb.instructions) sections.push(`## Agent instructions\n${clip(hb.instructions, 800)}`);
      if (hb.thisWeek) sections.push(`## This week\n${clip(hb.thisWeek, 600)}`);

      const persona = config.persona().trim();
      if (persona) sections.push(`## Persona excerpt\n${clip(persona, 600)}`);

      const cards = candidates.map((t) => {
        const requester = t.requestedBy ? db.getPerson(t.requestedBy) : undefined;
        const surfaces = db.surfacesForTask(t.id, 3);
        const lines = [
          `### Task ${t.id}`,
          `description: ${clip(flat(t.description), 200)}`,
          `requester: ${requester ? `${flat(requester.name)} (tier ${requester.tier})` : 'unknown'}`,
          `status: ${t.status} · priority: P${t.priority} · age: ${ageDays(t.createdAt, now)}d`,
          `timesSurfaced: ${t.surfaceCount}${t.lastSurfacedAt ? ` · lastSurfaced: ${t.lastSurfacedAt}` : ''}`,
        ];
        if (t.dueDate) lines.push(`due: ${t.dueDate}`);
        if (t.reminderReason) lines.push(`reminderReason: ${t.reminderReason}`);
        if (surfaces.length > 0) {
          const hist = surfaces
            .map((s) => `${s.surfacedAt.slice(0, 16)} → ${s.responseType ?? 'no response'}`)
            .join('; ');
          lines.push(`recentSurfaces: ${hist}`);
        }
        return lines.join('\n');
      });
      sections.push(`## Candidates (${candidates.length})\n\n${cards.join('\n\n')}`);

      return clip(sections.join('\n\n'), TOTAL_BUDGET * 2);
    },
  };
}
