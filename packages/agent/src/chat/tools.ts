import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { Task } from '@botty/shared';
import type { Bus } from '../bus/index.js';
import { nowIso, type Db } from '../db/index.js';
import type { ChatToolSpec } from '../llm/types.js';
import type { Memory } from '../memory/index.js';

/**
 * Chat tools — the model-callable actions available during a chat turn
 * (specs/ingestion.md capture_task; task_action mirrors POST /api/tasks/:id/action).
 * Handlers take plain deps and never throw: bad input or a missing task comes
 * back as `{ error }` so a wrong call can't kill the turn. The SDK wrapping
 * (tool() + createSdkMcpServer()) lives in llm/sdk.ts; the mock LLM invokes
 * execute() directly.
 */
export interface ChatToolDeps {
  db: Db;
  memory: Memory;
  bus: Bus;
}

const DAY_MS = 86_400_000;

/** Clip helper for snippets returned to the model. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Wrap a zod object schema + handler into a never-throwing ChatToolSpec. */
function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  schema: z.ZodObject<S>;
  summarize: (input: z.infer<z.ZodObject<S>>) => string;
  run: (input: z.infer<z.ZodObject<S>>) => Record<string, unknown> | Promise<Record<string, unknown>>;
}): ChatToolSpec {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.schema.shape,
    summarize(input) {
      const parsed = def.schema.safeParse(input);
      return parsed.success ? def.summarize(parsed.data) : def.name;
    },
    async execute(input) {
      const parsed = def.schema.safeParse(input);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        return { error: `invalid input — ${issues.join('; ')}` };
      }
      try {
        return await def.run(parsed.data);
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  };
}

export function createChatTools(deps: ChatToolDeps): ChatToolSpec[] {
  const { db, memory, bus } = deps;

  /** Same full-board snapshot POST /api/tasks/:id/action pushes after a write. */
  function broadcastTasks(): void {
    bus.broadcast({ type: 'tasks.updated', payload: { tasks: db.listTasks('open') } });
  }

  const captureTask = defineTool({
    name: 'capture_task',
    description:
      'Create a tracked task from the conversation. Use when the user asks to track, remember, or be reminded about a piece of work.',
    schema: z.object({
      description: z.string().min(1).describe('Short imperative description of the task'),
      priority: z.number().int().min(1).max(3).optional().describe('1=HIGH, 2=NORMAL (default), 3=LOW'),
      dueDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD')
        .optional()
        .describe('Due date, YYYY-MM-DD'),
      requestedBy: z.string().min(1).optional().describe('Name of the person who asked for this, if not the user'),
    }),
    summarize: (input) => clip(input.description, 80),
    run(input) {
      // Mirrors the funnel's resolveRequester: known name → that person, new name → discovered.
      const requester = input.requestedBy
        ? (db.getPersonByName(input.requestedBy) ?? db.upsertDiscoveredPerson({ name: input.requestedBy }))
        : null;
      // Unique per call — chat has no stable external id, so dedup never applies here.
      const sourceRef = `chat:${nanoid(10)}`;
      const task = db.insertTask(
        {
          description: input.description,
          source: 'chat',
          sourceRef,
          priority: input.priority ?? 2,
          requestedBy: requester?.id ?? null,
          dueDate: input.dueDate ?? null,
        },
        'chat',
      );
      if (!task) return { error: 'task not created (duplicate source ref)' };
      broadcastTasks();
      return {
        taskId: task.id,
        description: task.description,
        priority: task.priority,
        ...(task.dueDate ? { dueDate: task.dueDate } : {}),
        ...(requester ? { requestedBy: requester.name } : {}),
      };
    },
  });

  const taskAction = defineTool({
    name: 'task_action',
    description:
      'Act on an existing task by id: mark done, snooze, dismiss, reopen, or change priority. Find task ids in the open-task list or via memory_search.',
    schema: z.object({
      taskId: z.string().min(1),
      action: z.enum(['done', 'snooze', 'dismiss', 'reopen', 'priority']),
      snoozeDays: z.number().int().min(1).max(365).optional().describe('For snooze; default 1'),
      priority: z.number().int().min(1).max(3).optional().describe('For the priority action; 1=HIGH..3=LOW'),
    }),
    summarize: (input) => `${input.action}: ${input.taskId}`,
    run(input) {
      const existing = db.getTask(input.taskId);
      if (!existing) return { error: `task not found: ${input.taskId}` };

      // Mirrors the switch in POST /api/tasks/:id/action (server/routes.ts), changedBy 'chat'.
      let updated: Task;
      switch (input.action) {
        case 'done':
          updated = db.updateTask(input.taskId, { status: 'done', doneAt: nowIso() }, 'chat');
          break;
        case 'snooze': {
          const days = input.snoozeDays ?? 1;
          const until = new Date(Date.now() + days * DAY_MS).toISOString();
          updated = db.updateTask(input.taskId, { status: 'snoozed', snoozeUntil: until }, 'chat');
          break;
        }
        case 'dismiss':
          updated = db.updateTask(input.taskId, { status: 'cancelled' }, 'chat');
          break;
        case 'reopen':
          updated = db.updateTask(input.taskId, { status: 'open', snoozeUntil: null, doneAt: null }, 'chat');
          break;
        case 'priority': {
          if (input.priority === undefined) return { error: 'priority action requires priority (1-3)' };
          updated = db.updateTask(input.taskId, { priority: input.priority }, 'chat');
          break;
        }
      }
      broadcastTasks();
      return {
        taskId: updated.id,
        description: clip(updated.description, 120),
        status: updated.status,
        priority: updated.priority,
        ...(updated.snoozeUntil ? { snoozeUntil: updated.snoozeUntil } : {}),
      };
    },
  });

  const memorySearch = defineTool({
    name: 'memory_search',
    description:
      "Full-text search over botty's memory (tasks, decisions, interactions, chat). Use to recall past work or find a task id.",
    schema: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    summarize: (input) => clip(input.query, 80),
    run(input) {
      const hits = memory.search(input.query, { limit: input.limit ?? 5 });
      return {
        results: hits.map((h) => ({
          kind: h.kind,
          refId: h.refId,
          snippet: clip(h.content, 200),
          ...(h.occurredAt ? { at: h.occurredAt } : {}),
        })),
      };
    },
  });

  const sessionSearch = defineTool({
    name: 'session_search',
    description:
      'Recall past chat conversations. mode="search" full-text searches old turns (requires query); mode="recent" lists recent sessions with summaries; mode="browse" pages through one session\'s turns (requires sessionId; offset/limit to scroll).',
    schema: z.object({
      mode: z.enum(['search', 'recent', 'browse']),
      query: z.string().min(1).optional().describe('search mode: what to look for'),
      sessionId: z.string().min(1).optional().describe('browse mode: which session'),
      offset: z.number().int().min(0).optional().describe('browse mode: first turn index (default 0)'),
      limit: z.number().int().min(1).max(50).optional(),
    }),
    summarize: (input) =>
      input.mode === 'search'
        ? `search: ${clip(input.query ?? '', 60)}`
        : input.mode === 'browse'
          ? `browse: ${input.sessionId ?? '?'}`
          : 'recent sessions',
    run(input) {
      switch (input.mode) {
        case 'search': {
          if (!input.query) return { error: 'search mode requires query' };
          const hits = db.ftsSearchKind('chat', input.query, input.limit ?? 8);
          return {
            results: hits.map((h) => {
              const turn = db.getChatTurn(h.refId);
              return {
                turnId: h.refId,
                ...(turn ? { sessionId: turn.sessionId, role: turn.role } : {}),
                snippet: clip(h.content, 220),
                ...(h.occurredAt ? { at: h.occurredAt } : {}),
              };
            }),
          };
        }
        case 'recent': {
          const sessions = db.listSessions(input.limit ?? 10);
          return {
            sessions: sessions.map((s) => ({
              sessionId: s.id,
              status: s.status,
              lastActiveAt: s.lastActiveAt,
              turns: db.countTurnsForSession(s.id),
              ...(s.summary ? { summary: clip(s.summary, 300) } : {}),
            })),
          };
        }
        case 'browse': {
          if (!input.sessionId) return { error: 'browse mode requires sessionId' };
          if (!db.getSessionMeta(input.sessionId)) return { error: `session not found: ${input.sessionId}` };
          const offset = input.offset ?? 0;
          const limit = input.limit ?? 20;
          const turns = db.turnsForSessionPage(input.sessionId, offset, limit);
          return {
            sessionId: input.sessionId,
            total: db.countTurnsForSession(input.sessionId),
            offset,
            turns: turns.map((t) => ({
              turnId: t.id,
              role: t.role,
              content: clip(t.content, 400),
              at: t.createdAt,
            })),
          };
        }
      }
    },
  });

  return [captureTask, taskAction, memorySearch, sessionSearch];
}
