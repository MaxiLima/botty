import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JudgmentOutputSchema, type JudgmentOutput, type WsEvent } from '@botty/shared';
import { createBus, type Bus } from '../../src/bus/index.js';
import { parseHeartbeat, type HeartbeatConfig } from '../../src/config/parse.js';
import { Db } from '../../src/db/index.js';
import type { LlmClient, StructuredRequest } from '../../src/llm/types.js';
import { createMemory } from '../../src/memory/index.js';
import {
  commitmentCandidateId,
  eligibleCommitments,
  COMMITMENT_STALE_GRACE_HOURS,
} from '../../src/loop/commitments.js';
import { validateJudgment } from '../../src/loop/judgment.js';
import { createResponseTracker } from '../../src/loop/response-tracker.js';
import { runTick, type TickDeps } from '../../src/loop/tick.js';

/**
 * Inferred commitments (feature #2): due commitments ride the tick as extra
 * judgment candidates, wrapped in the untrusted-content boundary markers
 * (conversation-derived, unlike checklist.ts's trusted user-authored items).
 */

function heartbeat(over: Partial<HeartbeatConfig> = {}): HeartbeatConfig {
  return {
    ...parseHeartbeat('', 'sim'),
    workingHours: { start: '00:00', end: '00:00' }, // gate off
    quietHours: { start: '00:00', end: '00:00' }, // never quiet
    activeDays: [0, 1, 2, 3, 4, 5, 6],
    // commitmentMinAgeMin/commitmentsMaxPerDay default to 30/3 via HEARTBEAT_DEFAULTS
    // (parseHeartbeat('', ...) above) — override per-test via `over`.
    ...over,
  };
}

function stubLlm(db: Db, judgment: JudgmentOutput) {
  const structured = vi.fn(async (req: StructuredRequest<unknown>) => {
    const value = req.schema.parse(JudgmentOutputSchema.parse(judgment));
    db.insertAiDecision({
      kind: req.task,
      input: { system: req.system, prompt: req.prompt },
      output: value,
      model: 'stub',
      relatedRef: req.relatedRef ?? null,
    });
    return value;
  });
  const llm: LlmClient = {
    chatTurn: async () => {
      throw new Error('not used');
    },
    structured: structured as LlmClient['structured'],
    interrupt: async () => undefined,
  };
  return { llm, structured };
}

function makeDeps(db: Db, bus: Bus, hb: HeartbeatConfig, judgment: JudgmentOutput) {
  const config = { heartbeat: () => hb, persona: () => '' };
  const memory = createMemory({ db, config });
  const tracker = createResponseTracker({ db, bus });
  const { llm, structured } = stubLlm(db, judgment);
  const macNotifier = vi.fn();
  const deps: TickDeps = { db, bus, config, llm, memory, tracker, macNotifier };
  return { deps, structured, macNotifier };
}

const skipAll: JudgmentOutput = { tickReasoning: 'skip', actions: [], skipped: [] };

/** Insert a commitment and force its createdAt so the min-age guard is deterministic. */
function insertCommitmentAt(db: Db, opts: { description: string; dueAt: string; createdAt: string }) {
  const c = db.insertCommitment({ description: opts.description, dueAt: opts.dueAt });
  db.raw.prepare('UPDATE commitments SET created_at=? WHERE id=?').run(opts.createdAt, c.id);
  return db.getCommitment(c.id)!;
}

describe('eligibleCommitments', () => {
  it('excludes commitments younger than minAgeMin (echo-back guard)', () => {
    const db = new Db(':memory:');
    const now = '2026-07-09T12:00:00.000Z';
    insertCommitmentAt(db, {
      description: 'too fresh',
      dueAt: '2026-07-09T11:00:00.000Z',
      createdAt: '2026-07-09T11:50:00.000Z', // 10 min ago
    });
    const old = insertCommitmentAt(db, {
      description: 'old enough',
      dueAt: '2026-07-09T11:00:00.000Z',
      createdAt: '2026-07-09T11:00:00.000Z', // 60 min ago
    });
    const eligible = eligibleCommitments(db, now, { minAgeMin: 30, maxPerDay: 3 });
    expect(eligible.map((c) => c.id)).toEqual([old.id]);
  });

  it('caps at the remaining maxPerDay budget — over-cap commitments are simply not offered', () => {
    const db = new Db(':memory:');
    const now = '2026-07-09T12:00:00.000Z';
    const created = '2026-07-09T00:00:00.000Z';
    for (let i = 0; i < 4; i++) {
      insertCommitmentAt(db, { description: `c${i}`, dueAt: '2026-07-09T01:00:00.000Z', createdAt: created });
    }
    const eligible = eligibleCommitments(db, now, { minAgeMin: 30, maxPerDay: 2 });
    expect(eligible).toHaveLength(2);
  });

  it('remaining budget accounts for deliveries already made in the trailing 24h', () => {
    const db = new Db(':memory:');
    const now = '2026-07-09T12:00:00.000Z';
    const alreadyDelivered = db.insertCommitment({ description: 'x', dueAt: '2026-07-08T00:00:00.000Z' });
    db.markCommitmentDelivered(alreadyDelivered.id, '2026-07-09T06:00:00.000Z');
    insertCommitmentAt(db, {
      description: 'due now',
      dueAt: '2026-07-09T01:00:00.000Z',
      createdAt: '2026-07-09T00:00:00.000Z',
    });
    const eligible = eligibleCommitments(db, now, { minAgeMin: 30, maxPerDay: 1 });
    expect(eligible).toEqual([]); // budget already spent
  });
});

describe('validateJudgment — commitment candidates', () => {
  const validTaskIds = new Set(['t1']);
  const commitmentId = 'commitment:abc123';
  const commitmentIds = new Set([commitmentId]);

  it('accepts notify actions on commitment ids, exempt from threshold and notify cap', () => {
    const res = validateJudgment(
      {
        tickReasoning: 'r',
        actions: [
          { type: 'notify', taskId: 't1', score: 9, message: 'task', reasoning: '' },
          { type: 'notify', taskId: commitmentId, score: 1, message: 'interview tomorrow', reasoning: '' },
        ],
        skipped: [],
      },
      { surfacingThreshold: 7, validTaskIds, commitmentIds },
    );
    expect(res.actions.map((a) => a.taskId)).toEqual(['t1', commitmentId]);
    expect(res.dropped).toEqual([]);
  });

  it('drops snooze/update_priority on commitment ids and unknown commitment ids', () => {
    const res = validateJudgment(
      {
        tickReasoning: 'r',
        actions: [
          { type: 'snooze', taskId: commitmentId, score: 5, snoozeDays: 2, reasoning: '' },
          { type: 'notify', taskId: 'commitment:hallucinated', score: 9, reasoning: '' },
        ],
        skipped: [],
      },
      { surfacingThreshold: 7, validTaskIds, commitmentIds },
    );
    expect(res.actions).toEqual([]);
    expect(res.dropped).toEqual([
      { taskId: commitmentId, type: 'snooze', reason: 'commitment_action' },
      { taskId: 'commitment:hallucinated', type: 'notify', reason: 'unknown_task' },
    ]);
  });
});

describe('runTick — commitments', () => {
  let db: Db;
  let bus: Bus;
  let events: WsEvent[];

  beforeEach(() => {
    db = new Db(':memory:');
    bus = createBus();
    events = [];
    bus.onBroadcast((e) => events.push(e));
  });

  it('zero-cost floor still holds with no survivors, no checklist, and no due commitments', async () => {
    const { deps, structured } = makeDeps(db, bus, heartbeat(), skipAll);
    const id = await runTick(deps, { trigger: 'run-now' });
    expect(db.getTick(id)!.candidatesIn).toBe(0);
    expect(structured).not.toHaveBeenCalled();
  });

  it('a due commitment alone reaches judgment; its context is labeled and untrusted', async () => {
    const now = '2026-07-09T12:00:00.000Z';
    const c = insertCommitmentAt(db, {
      description: 'my interview is tomorrow at 3',
      dueAt: '2026-07-09T11:00:00.000Z',
      createdAt: '2026-07-09T11:00:00.000Z', // 60 min old — past the default 30 min guard
    });
    const { deps, structured } = makeDeps(db, bus, heartbeat(), skipAll);
    await runTick(deps, { trigger: 'run-now', now });
    expect(structured).toHaveBeenCalledTimes(1);
    const req = structured.mock.calls[0]![0] as StructuredRequest<unknown>;
    expect(req.prompt).toContain('Due inferred commitments (1)');
    expect(req.prompt).toContain(commitmentCandidateId(c));
    expect(req.prompt).toContain('untrusted ingested content');
    expect(req.prompt).toContain('my interview is tomorrow at 3');
  });

  it('the echo-back guard holds a freshly created commitment back from judgment', async () => {
    const now = '2026-07-09T12:00:00.000Z';
    insertCommitmentAt(db, {
      description: 'just mentioned',
      dueAt: '2026-07-09T11:00:00.000Z',
      createdAt: '2026-07-09T11:50:00.000Z', // 10 min old — under the 30 min guard
    });
    const { deps, structured } = makeDeps(db, bus, heartbeat(), skipAll);
    const id = await runTick(deps, { trigger: 'run-now', now });
    expect(structured).not.toHaveBeenCalled();
    expect(db.getTick(id)!.candidatesIn).toBe(0);
  });

  it('the maxPerDay cap holds extra due commitments back for a later tick', async () => {
    const now = '2026-07-09T12:00:00.000Z';
    const created = '2026-07-09T00:00:00.000Z';
    for (let i = 0; i < 5; i++) {
      insertCommitmentAt(db, { description: `c${i}`, dueAt: '2026-07-09T01:00:00.000Z', createdAt: created });
    }
    const { deps, structured } = makeDeps(db, bus, heartbeat({ commitmentsMaxPerDay: 3 }), skipAll);
    await runTick(deps, { trigger: 'run-now', now });
    const req = structured.mock.calls[0]![0] as StructuredRequest<unknown>;
    expect(req.prompt).toContain('Due inferred commitments (3)');
    expect(db.dueCommitments(now)).toHaveLength(5); // the other 2 are still open, untouched
  });

  it('judgment notify on a commitment id delivers: proactive_log + WS notification + markCommitmentDelivered', async () => {
    const now = '2026-07-09T12:00:00.000Z';
    const c = insertCommitmentAt(db, {
      description: 'call the plumber back',
      dueAt: '2026-07-09T11:00:00.000Z',
      createdAt: '2026-07-09T11:00:00.000Z',
    });
    const candidateId = commitmentCandidateId(c);
    const judgment: JudgmentOutput = {
      tickReasoning: 'due now',
      actions: [{ type: 'notify', taskId: candidateId, score: 8, message: 'Call the plumber back', reasoning: 'due' }],
      skipped: [],
    };
    const { deps, macNotifier } = makeDeps(db, bus, heartbeat(), judgment);
    const id = await runTick(deps, { trigger: 'run-now', now });
    const tick = db.getTick(id)!;

    const actions = JSON.parse(tick.actionsJson!) as { type: string; taskId: string; proactiveLogId?: string }[];
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'notify', taskId: candidateId });

    const surface = db.raw
      .prepare('SELECT * FROM proactive_log WHERE surface_kind=?')
      .get('commitment') as { task_id: string | null; message: string } | undefined;
    expect(surface).toMatchObject({ task_id: null, message: 'Call the plumber back' });
    expect(macNotifier).toHaveBeenCalledWith('botty', 'Call the plumber back');

    const notification = events.find((e) => e.type === 'notification');
    expect(notification?.payload).toMatchObject({ kind: 'commitment', taskId: null });

    expect(db.getCommitment(c.id)!.status).toBe('delivered');
    expect(db.getCommitment(c.id)!.deliveredAt).toBe(now);
  });

  it('judgment skip on a commitment leaves it open for a later tick', async () => {
    const now = '2026-07-09T12:00:00.000Z';
    const c = insertCommitmentAt(db, {
      description: 'not urgent right now',
      dueAt: '2026-07-09T11:00:00.000Z',
      createdAt: '2026-07-09T11:00:00.000Z',
    });
    const { deps } = makeDeps(db, bus, heartbeat(), skipAll);
    await runTick(deps, { trigger: 'run-now', now });
    expect(db.getCommitment(c.id)!.status).toBe('open');
  });

  it('a stale commitment (due long ago, never delivered) is expired before gathering', async () => {
    const now = '2026-07-09T12:00:00.000Z';
    const stale = insertCommitmentAt(db, {
      description: 'ancient',
      dueAt: '2026-07-08T00:00:00.000Z', // > 24h ago
      createdAt: '2026-07-08T00:00:00.000Z',
    });
    const { deps, structured } = makeDeps(db, bus, heartbeat(), skipAll);
    await runTick(deps, { trigger: 'run-now', now });
    expect(db.getCommitment(stale.id)!.status).toBe('expired');
    expect(structured).not.toHaveBeenCalled(); // nothing else due ⇒ zero-cost floor still holds
    expect(COMMITMENT_STALE_GRACE_HOURS).toBe(24);
  });
});
