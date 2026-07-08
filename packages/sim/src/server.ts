import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import { SOURCES, SourceEventSchema, type SourceId } from '@botty/shared';
import { SimEngine, type InjectInput } from './engine.js';
import { listScenarios, loadScenarioFile } from './scenarios.js';
import { DEFAULT_TEMPLATES } from './templates.js';
import { PANEL_HTML } from './panel.js';

const LoadBodySchema = z.object({ name: z.string() });
const PlayBodySchema = z.object({ speed: z.number().positive().optional() }).default({});
const AdvanceBodySchema = z.object({ minutes: z.number().nonnegative() });
const InjectBodySchema = z.object({
  source: z.enum(SOURCES),
  kind: z.string(),
  externalId: z.string().optional(),
  actor: SourceEventSchema.shape.actor.optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  text: z.string(),
  threadRef: z.string().optional(),
  occurredAt: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

function handle(res: Response, fn: () => unknown): void {
  try {
    res.json(fn() ?? { ok: true });
  } catch (err) {
    const message = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
    res.status(400).json({ error: message });
  }
}

export function createApp(engine: SimEngine): Express {
  const app = express();
  app.use(express.json());

  // ── Control panel ────────────────────────────────────────────────────────
  app.get('/', (_req, res) => {
    res.type('html').send(PANEL_HTML);
  });

  // ── Source endpoints (polled by the agent's sim drivers) ────────────────
  for (const source of SOURCES) {
    app.get(`/${source}/events`, (req: Request, res: Response) => {
      const since = typeof req.query.since === 'string' ? req.query.since : null;
      res.json({ events: engine.eventsFor(source as SourceId, since) });
    });
  }

  // ── Control API ──────────────────────────────────────────────────────────
  app.get('/control/state', (_req, res) => {
    res.json({ ...engine.state(), available: listScenarios() });
  });

  app.post('/control/reset', (_req, res) => {
    handle(res, () => {
      engine.reset();
      return { ok: true };
    });
  });

  app.post('/control/scenario/load', (req, res) => {
    handle(res, () => {
      const { name } = LoadBodySchema.parse(req.body);
      const { scenario, templates } = loadScenarioFile(name);
      engine.loadScenario(scenario, templates);
      return { ok: true, scenario: engine.state().scenario };
    });
  });

  app.post('/control/scenario/play', (req, res) => {
    handle(res, () => {
      const { speed } = PlayBodySchema.parse(req.body ?? {});
      engine.play(speed);
      return { ok: true, clock: engine.state().clock };
    });
  });

  app.post('/control/scenario/pause', (_req, res) => {
    handle(res, () => {
      engine.pause();
      return { ok: true, clock: engine.state().clock };
    });
  });

  app.post('/control/advance', (req, res) => {
    handle(res, () => {
      const { minutes } = AdvanceBodySchema.parse(req.body);
      engine.advance(minutes);
      return { ok: true, clock: engine.state().clock };
    });
  });

  app.post('/control/inject', (req, res) => {
    handle(res, () => {
      const input = InjectBodySchema.parse(req.body) as InjectInput;
      const event = engine.inject(input);
      return { ok: true, event };
    });
  });

  app.get('/control/templates', (_req, res) => {
    const templates = engine.templates();
    res.json({ templates: templates.length > 0 ? templates : DEFAULT_TEMPLATES });
  });

  return app;
}
