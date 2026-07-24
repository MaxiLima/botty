import type { Router } from 'express';
import { BackfillStartRequestSchema } from '@botty/shared';
import type { Backfill } from '../backfill/index.js';
import { parseBody, wrap } from './errors.js';

/**
 * Backfill REST surface (docs/specs/backfill.md), driven by `botty backfill`:
 *   POST /api/backfill/start  — launch (fire-and-forget; poll GET for progress)
 *   GET  /api/backfill        — current/last state blob
 *   POST /api/backfill/cancel — cooperative cancel (idempotent)
 * The state blob lives under the agent-owned `backfill.state` settings key,
 * which is intentionally NOT in SETTABLE_SETTINGS_KEYS.
 */
export function registerBackfillRoutes(router: Router, backfill: Backfill): void {
  router.post(
    '/backfill/start',
    wrap((req, res) => {
      const opts = parseBody(BackfillStartRequestSchema, req.body ?? {});
      // start() launches the run fire-and-forget (like check-now): a full run
      // can take minutes — never await it here.
      res.json(backfill.start(opts));
    }),
  );

  router.get(
    '/backfill',
    wrap((_req, res) => {
      res.json({ state: backfill.status() });
    }),
  );

  router.post(
    '/backfill/cancel',
    wrap((_req, res) => {
      res.json({ state: backfill.cancel() });
    }),
  );
}
