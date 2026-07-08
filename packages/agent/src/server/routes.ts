import fs from 'node:fs';
import { Router } from 'express';
import { z } from 'zod';
import {
  CONFIG_FILE_NAMES,
  ChatMessageRequestSchema,
  ConfigSaveRequestSchema,
  MuteRequestSchema,
  SOURCES,
  TaskActionRequestSchema,
  TaskStatusSchema,
  type ConfigFileName,
  type SourceId,
  type Task,
} from '@botty/shared';
import type { AgentContext } from '../context.js';
import type { Ingest } from '../ingest/index.js';
import type { Loop } from '../loop/index.js';
import { nowIso, type Db } from '../db/index.js';
import { badRequest, notFound, param, parseBody, queryInt, queryStr, wrap } from './errors.js';
import { nanoid } from 'nanoid';
import { notifyMacos } from '../loop/notify-macos.js';

export const AGENT_VERSION = '0.1.0';

const SettingsPatchSchema = z.object({ patch: z.record(z.string(), z.unknown()) });

const DAY_MS = 86_400_000;

// ---------- enrichment helpers ----------

function projectName(db: Db, projectId: string | null): string | null {
  if (!projectId) return null;
  const row = db.raw.prepare('SELECT name FROM projects WHERE id=?').get(projectId) as
    | { name: string }
    | undefined;
  return row?.name ?? null;
}

/** Single-task enrichment (list queries already join these in). */
function enrichTask(db: Db, task: Task): Task {
  return {
    ...task,
    requesterName: task.requestedBy ? (db.getPerson(task.requestedBy)?.name ?? null) : null,
    projectName: projectName(db, task.projectId),
  };
}

function openTaskCountsBy(db: Db, column: 'requested_by' | 'project_id'): Map<string, number> {
  const rows = db.raw
    .prepare(
      `SELECT ${column} AS id, COUNT(*) AS n FROM tasks WHERE status='open' AND ${column} IS NOT NULL GROUP BY ${column}`,
    )
    .all() as { id: string; n: number }[];
  return new Map(rows.map((r) => [r.id, r.n]));
}

// ---------- router ----------

export function buildApiRouter(ctx: AgentContext, deps: { ingest: Ingest; loop: Loop }): Router {
  const { db, bus, config, chat, env } = ctx;
  const router = Router();

  /** Full refreshed open board — pushed on every task write. */
  const broadcastTasks = (): void => {
    bus.broadcast({ type: 'tasks.updated', payload: { tasks: db.listTasks('open') } });
  };

  // ----- health -----

  router.get(
    '/health',
    wrap((_req, res) => {
      res.json({ ok: true, version: AGENT_VERSION, mode: env.mode, dbPath: env.dbPath });
    }),
  );

  // ----- chat -----

  router.get(
    '/chat/history',
    wrap((req, res) => {
      const limit = queryInt(req.query.limit, 'limit');
      const before = queryStr(req.query.before);
      res.json({ turns: db.chatHistory({ limit, before }), sessions: db.listSessions() });
    }),
  );

  router.post(
    '/chat/message',
    wrap(async (req, res) => {
      const { text, attachments, quotedTurnId } = parseBody(ChatMessageRequestSchema, req.body);
      const { turnId } = await chat.handleUserMessage(text, { attachments, quotedTurnId });
      res.json({ turnId });
    }),
  );

  // Attachment binaries live on disk (<dataDir>/attachments); turn meta carries refs here.
  router.get(
    '/chat/attachments/:id',
    wrap((req, res) => {
      const id = param(req, 'id');
      const att = chat.getAttachment(id);
      if (!att) throw notFound(`attachment ${id}`);
      let data: Buffer;
      try {
        data = fs.readFileSync(att.filePath);
      } catch {
        throw notFound(`attachment ${id}`);
      }
      res.setHeader('Content-Type', att.mimeType);
      res.send(data);
    }),
  );

  router.post(
    '/chat/interrupt',
    wrap(async (_req, res) => {
      await chat.interrupt();
      res.json({ ok: true });
    }),
  );

  router.post(
    '/chat/seal',
    wrap(async (_req, res) => {
      await chat.seal();
      res.json({ ok: true });
    }),
  );

  // ----- tasks -----

  router.get(
    '/tasks',
    wrap((req, res) => {
      const raw = queryStr(req.query.status);
      let status;
      if (raw !== undefined) {
        const parsed = TaskStatusSchema.safeParse(raw);
        if (!parsed.success) {
          throw badRequest(`status must be one of ${TaskStatusSchema.options.join(', ')}`);
        }
        status = parsed.data;
      }
      res.json({ tasks: db.listTasks(status) });
    }),
  );

  router.get(
    '/tasks/:id',
    wrap((req, res) => {
      const id = param(req, 'id');
      const task = db.getTask(id);
      if (!task) throw notFound(`task ${id}`);
      res.json({
        task: enrichTask(db, task),
        history: db.taskHistory(id),
        surfaces: db.surfacesForTask(id),
      });
    }),
  );

  router.post(
    '/tasks/:id/action',
    wrap((req, res) => {
      const id = param(req, 'id');
      const body = parseBody(TaskActionRequestSchema, req.body);
      const existing = db.getTask(id);
      if (!existing) throw notFound(`task ${id}`);

      let updated: Task;
      switch (body.action) {
        case 'done':
          updated = db.updateTask(id, { status: 'done', doneAt: nowIso() }, 'user');
          break;
        case 'snooze': {
          const days = body.snoozeDays ?? 1;
          if (days <= 0) throw badRequest('snoozeDays must be positive');
          const until = new Date(Date.now() + days * DAY_MS).toISOString();
          updated = db.updateTask(id, { status: 'snoozed', snoozeUntil: until }, 'user');
          break;
        }
        case 'dismiss':
          updated = db.updateTask(id, { status: 'cancelled' }, 'user');
          break;
        case 'reopen':
          updated = db.updateTask(id, { status: 'open', snoozeUntil: null, doneAt: null }, 'user');
          break;
        case 'priority': {
          if (body.priority === undefined) throw badRequest('priority action requires priority');
          updated = db.updateTask(id, { priority: body.priority }, 'user');
          break;
        }
      }
      if (body.reason) db.appendTaskHistory(id, 'action_reason', null, body.reason, 'user');
      broadcastTasks();
      res.json({ task: enrichTask(db, updated) });
    }),
  );

  // ----- people & projects -----

  router.get(
    '/people',
    wrap((_req, res) => {
      const counts = openTaskCountsBy(db, 'requested_by');
      const people = db.listPeople().map((p) => ({ ...p, openTaskCount: counts.get(p.id) ?? 0 }));
      res.json({ people });
    }),
  );

  router.get(
    '/people/:id',
    wrap((req, res) => {
      const id = param(req, 'id');
      const person = db.getPerson(id);
      if (!person) throw notFound(`person ${id}`);
      const tasks = db.listTasks().filter((t) => t.requestedBy === id);
      res.json({ person, interactions: db.interactionsForPerson(id), tasks });
    }),
  );

  router.post(
    '/people/:id/mute',
    wrap((req, res) => {
      const id = param(req, 'id');
      const { until } = parseBody(MuteRequestSchema, req.body);
      if (!db.getPerson(id)) throw notFound(`person ${id}`);
      res.json({ person: db.setPersonMuted(id, until) });
    }),
  );

  router.get(
    '/projects',
    wrap((_req, res) => {
      const counts = openTaskCountsBy(db, 'project_id');
      const projects = db
        .listProjects()
        .map((p) => ({ ...p, openTaskCount: counts.get(p.id) ?? 0 }));
      res.json({ projects });
    }),
  );

  // ----- inspector -----

  router.get(
    '/decisions',
    wrap((req, res) => {
      res.json({
        decisions: db.listAiDecisions({
          kind: queryStr(req.query.kind),
          limit: queryInt(req.query.limit, 'limit'),
          before: queryStr(req.query.before),
        }),
      });
    }),
  );

  router.get(
    '/ticks',
    wrap((req, res) => {
      res.json({ ticks: db.listTicks(queryInt(req.query.limit, 'limit')) });
    }),
  );

  router.get(
    '/ticks/:id',
    wrap((req, res) => {
      const tick = db.getTick(param(req, 'id'));
      if (!tick) throw notFound(`tick ${param(req, 'id')}`);
      const judgment = tick.judgmentDecisionId
        ? db.getAiDecision(tick.judgmentDecisionId)
        : undefined;
      res.json({ tick, ...(judgment ? { judgment } : {}) });
    }),
  );

  router.get(
    '/raw-log',
    wrap((req, res) => {
      res.json({
        events: db.listRawLog({
          source: queryStr(req.query.source),
          limit: queryInt(req.query.limit, 'limit'),
        }),
      });
    }),
  );

  router.get(
    '/source-checks',
    wrap((req, res) => {
      res.json({ checks: db.listSourceChecks(queryInt(req.query.limit, 'limit')) });
    }),
  );

  // ----- config -----

  router.get(
    '/config',
    wrap((_req, res) => {
      res.json({
        files: {
          persona: config.raw('persona'),
          team: config.raw('team'),
          heartbeat: config.raw('heartbeat'),
        },
      });
    }),
  );

  router.put(
    '/config/:name',
    wrap((req, res) => {
      const name = param(req, 'name') as ConfigFileName;
      if (!CONFIG_FILE_NAMES.includes(name)) {
        throw badRequest(`name must be one of ${CONFIG_FILE_NAMES.join(', ')}`);
      }
      const { content } = parseBody(ConfigSaveRequestSchema, req.body);
      const { warnings } = config.save(name, content);
      res.json({ ok: true, warnings });
    }),
  );

  // ----- control -----

  router.post(
    '/loop/run-now',
    wrap(async (_req, res) => {
      const tickId = await deps.loop.runNow();
      res.json({ tickId });
    }),
  );

  router.post(
    '/loop/sweep-now',
    wrap(async (_req, res) => {
      const result = await deps.loop.sweepNow();
      res.json({ result });
    }),
  );

  router.post(
    '/sources/:source/check-now',
    wrap(async (req, res) => {
      const source = param(req, 'source') as SourceId;
      if (!SOURCES.includes(source)) {
        throw badRequest(`source must be one of ${SOURCES.join(', ')}`);
      }
      const checkId = await deps.ingest.checkNow(source);
      res.json({ checkId });
    }),
  );

  // Fires the full notification path (WS card + macOS banner) with a canned
  // message — lets the user verify the channel works without waiting for a tick.
  router.post(
    '/notifications/test',
    wrap((_req, res) => {
      const id = nanoid();
      bus.broadcast({
        type: 'notification',
        payload: {
          id,
          taskId: null,
          kind: 'test',
          message: 'Notificación de prueba — si ves esto, el canal funciona.',
          score: null,
        },
      });
      notifyMacos('botty', 'Notificación de prueba — si ves esto, el canal funciona.');
      res.json({ ok: true, id });
    }),
  );

  router.get(
    '/settings',
    wrap((_req, res) => {
      res.json({ settings: db.allSettings() });
    }),
  );

  router.put(
    '/settings',
    wrap((req, res) => {
      const { patch } = parseBody(SettingsPatchSchema, req.body);
      for (const [key, value] of Object.entries(patch)) db.setSetting(key, value);
      res.json({ settings: db.allSettings() });
    }),
  );

  // Unknown /api routes → JSON 404 (never the SPA fallback).
  router.use((req, res) => {
    res.status(404).json({ error: 'not_found', detail: `${req.method} /api${req.path}` });
  });

  return router;
}
