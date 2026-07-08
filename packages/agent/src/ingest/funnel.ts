import {
  ClassifierOutputSchema,
  ExtractorOutputSchema,
  SourceEventSchema,
  type ClassifierOutput,
  type Decision,
  type ExtractorOutput,
  type FunnelOutcome,
  type Person,
  type RawLogRow,
  type SourceEvent,
  type SourceId,
  type Task,
} from '@botty/shared';
import type { Db } from '../db/index.js';
import { matchSignals } from './heuristics.js';
import { handleGcal, handleTaskSource } from './structured.js';
import {
  broadcastTasksUpdated,
  discoverActor,
  insertEventRawLog,
  logInteraction,
  stampOutcome,
  type FunnelCtx,
} from './util.js';

export type { FunnelCtx } from './util.js';

const CLASSIFIER_SYSTEM =
  "You are the ingestion gate of a personal work assistant. Given one inbound message from a key teammate, decide whether it contains actionable content worth extracting: a task or request for the user, a decision that was made, or a commitment someone gave. Social chatter, acknowledgements, rhetorical questions, and FYI noise are NOT worth extracting. Answer with JSON matching { worthExtracting: boolean, confidence: number (0-1), reason: string }.";

const EXTRACTOR_SYSTEM =
  'You extract structured work items from one inbound message for a personal work assistant. Return JSON with: tasks (things the user is asked to do or someone committed to, short imperative description, optional requesterName / dueDate ISO / priority 1-3), decisions (choices that were made, with rationale when stated), and people (anyone mentioned by name, with slackHandle/email when present). Only extract what the message actually supports; empty arrays are fine.';

/**
 * Route one normalized event through ingestion. gcal/jira/github are
 * structured and skip the funnel; slack/gmail go through the 5-step funnel.
 */
export async function processEvent(ctx: FunnelCtx, event: SourceEvent): Promise<FunnelOutcome> {
  switch (event.source) {
    case 'gcal':
      return handleGcal(ctx, event);
    case 'jira':
    case 'github':
      return handleTaskSource(ctx, event);
    default:
      return runFunnel(ctx, event);
  }
}

/**
 * The 5-step funnel (docs/specs/ingestion.md), cheap kills first:
 * raw-log dedup → tier check → heuristic gate → classifier → extractor.
 */
export async function runFunnel(ctx: FunnelCtx, event: SourceEvent): Promise<FunnelOutcome> {
  // 1. Raw log (always). Unique(source, external_id) conflict ⇒ stop.
  const rawLog = insertEventRawLog(ctx.db, event);
  if (!rawLog) return 'DUPLICATE';
  return runFunnelStages(ctx, event, rawLog);
}

interface FunnelRunOpts {
  /** Re-run of an ERROR-stamped raw_log row — the first pass already logged the interaction. */
  retry?: boolean;
  /** 1-based extraction attempt number, stamped into funnelDetail on ERROR. */
  attempt?: number;
}

/** Steps 1b-5 for one already-raw-logged event (also the ERROR-retry entry point). */
async function runFunnelStages(
  ctx: FunnelCtx,
  event: SourceEvent,
  rawLog: RawLogRow,
  opts: FunnelRunOpts = {},
): Promise<FunnelOutcome> {
  // 1b. Outbound (the user's own reply in a thread): never task-extracted —
  // you don't ask yourself for things. Logged as an interaction so the
  // resolution sweep can read "review done" as completion evidence.
  if (event.direction === 'outbound') {
    if (!opts.retry) logInteraction(ctx, event, rawLog.id, null);
    stampOutcome(ctx.db, rawLog, event, 'INTERACTION_ONLY', { outbound: true });
    return 'INTERACTION_ONLY';
  }

  // 2. Tier check: only Tier-1 (CRITICAL/HIGH from TEAM.md) goes further.
  const person = ctx.db.findPersonByActor(event.actor);
  if (!person || person.tier !== 1) {
    const logged = person ?? discoverActor(ctx.db, event.actor);
    if (!opts.retry) logInteraction(ctx, event, rawLog.id, logged?.id ?? null);
    stampOutcome(ctx.db, rawLog, event, 'INTERACTION_ONLY', {
      tier: person?.tier ?? null,
      known: Boolean(person),
    });
    return 'INTERACTION_ONLY';
  }

  // 3. Heuristic gate (deterministic regexes, conservative).
  const signals = matchSignals(event.text);
  if (signals.length === 0) {
    if (!opts.retry) logInteraction(ctx, event, rawLog.id, person.id);
    stampOutcome(ctx.db, rawLog, event, 'NO_SIGNAL');
    return 'NO_SIGNAL';
  }

  // 4. Classifier (LLM). Failure ⇒ degrade to extracting (heuristics already passed).
  let classified: ClassifierOutput | null = null;
  try {
    classified = await ctx.llm.structured({
      task: 'classification',
      system: CLASSIFIER_SYSTEM,
      prompt: eventPrompt(event, person.name, signals),
      schema: ClassifierOutputSchema,
      relatedRef: rawLog.id,
    });
  } catch {
    classified = null;
  }
  if (classified && !classified.worthExtracting) {
    if (!opts.retry) logInteraction(ctx, event, rawLog.id, person.id);
    stampOutcome(ctx.db, rawLog, event, 'CLASSIFIED_OUT', {
      reason: classified.reason,
      confidence: classified.confidence,
    });
    return 'CLASSIFIED_OUT';
  }

  // 5. Extractor (LLM). Persist order: people → tasks → decisions.
  let extracted: ExtractorOutput;
  try {
    extracted = await ctx.llm.structured({
      task: 'extraction',
      system: EXTRACTOR_SYSTEM,
      prompt: eventPrompt(event, person.name, signals),
      schema: ExtractorOutputSchema,
      relatedRef: rawLog.id,
    });
  } catch (err) {
    if (!opts.retry) logInteraction(ctx, event, rawLog.id, person.id);
    stampOutcome(ctx.db, rawLog, event, 'ERROR', {
      stage: 'extraction',
      error: err instanceof Error ? err.message : String(err),
      attempts: opts.attempt ?? 1,
    });
    return 'ERROR';
  }

  const counts = persistExtraction(ctx, event, person, extracted);
  if (!opts.retry) logInteraction(ctx, event, rawLog.id, person.id);
  stampOutcome(ctx.db, rawLog, event, 'EXTRACTED', counts);
  return 'EXTRACTED';
}

/** Max extraction attempts per raw event (first pass + retries). */
const MAX_EXTRACTION_ATTEMPTS = 3;
/** Newest raw_log rows scanned per source when hunting for ERROR rows to retry. */
const RETRY_SCAN_LIMIT = 200;

/**
 * Second-chance pass for ERROR-stamped raw_log rows (extractor LLM failure):
 * an ERROR outcome is never refetched (raw_log dedup + advanced since cursor),
 * so without this a transient LLM outage permanently drops a Tier-1 ask. The
 * row body stores the full serialized SourceEvent, so steps 2-5 re-run without
 * refetching; attempts are bounded via funnelDetail.attempts. Never throws
 * for a single bad row. Returns the number of rows that recovered to EXTRACTED.
 */
export async function retryErroredEvents(ctx: FunnelCtx, source: SourceId): Promise<number> {
  if (source === 'gcal' || source === 'jira' || source === 'github') return 0; // structured — no LLM funnel
  let recovered = 0;
  for (const row of ctx.db.listRawLog({ source, limit: RETRY_SCAN_LIMIT })) {
    let body: unknown;
    try {
      body = JSON.parse(row.body);
    } catch {
      continue;
    }
    const meta = (body as { meta?: Record<string, unknown> }).meta;
    if (meta?.funnelOutcome !== 'ERROR') continue;
    const detail = meta.funnelDetail as { attempts?: unknown } | undefined;
    const attempts = typeof detail?.attempts === 'number' ? detail.attempts : 1;
    if (attempts >= MAX_EXTRACTION_ATTEMPTS) continue;
    const parsed = SourceEventSchema.safeParse(body);
    if (!parsed.success) continue;
    // Strip the previous stamp so the re-run's verdict starts clean.
    const { funnelOutcome: _o, funnelDetail: _d, ...eventMeta } = parsed.data.meta;
    try {
      const outcome = await runFunnelStages(ctx, { ...parsed.data, meta: eventMeta }, row, {
        retry: true,
        attempt: attempts + 1,
      });
      if (outcome === 'EXTRACTED') recovered += 1;
    } catch {
      // keep the ERROR stamp — the next check retries (until the attempt cap)
    }
  }
  return recovered;
}

/**
 * Prompt block for the classifier/extractor. Header lines first so the
 * (possibly multiline) TEXT payload can't shadow them; the TEXT:/ACTOR: line
 * convention also keeps MockLlm deterministic.
 */
function eventPrompt(event: SourceEvent, actorName: string, signals: string[]): string {
  const lines = [
    `SOURCE: ${event.source}`,
    `KIND: ${event.kind}`,
    `ACTOR: ${actorName}`,
    `OCCURRED_AT: ${event.occurredAt}`,
  ];
  if (event.threadRef) lines.push(`THREAD: ${event.threadRef}`);
  if (signals.length > 0) lines.push(`SIGNALS: ${signals.join(', ')}`);
  lines.push(`TEXT: ${event.text}`);
  return lines.join('\n');
}

function resolveRequester(db: Db, requesterName: string | undefined, actorPerson: Person): Person {
  if (!requesterName) return actorPerson;
  return db.getPersonByName(requesterName) ?? db.upsertDiscoveredPerson({ name: requesterName });
}

function persistExtraction(
  ctx: FunnelCtx,
  event: SourceEvent,
  actorPerson: Person,
  extracted: ExtractorOutput,
): { tasks: number; decisions: number; people: number } {
  const { db } = ctx;

  // people first (so requester lookups can hit them)
  for (const p of extracted.people) db.upsertDiscoveredPerson(p);

  // source_ref slots share the thread base (the resolution sweep strips the
  // #n suffix to recover the thread ref), but every DISTINCT item claims its
  // own slot: on a UNIQUE(source, source_ref) conflict, an identical re-send
  // (a repeated nag — same raw text / description) dedups out, while a new
  // distinct item in the same thread moves on to the next free suffix.
  const baseRef = event.threadRef ?? event.externalId;

  // tasks — priority 1 when the requester is Tier 1.
  let tasks = 0;
  let taskSeq = 0;
  for (const t of extracted.tasks) {
    const requester = resolveRequester(db, t.requesterName, actorPerson);
    const priority = t.priority ?? (requester.tier === 1 ? 1 : 2);
    let task: Task | null = null;
    for (;;) {
      const ref = taskSeq === 0 ? baseRef : `${baseRef}#${taskSeq + 1}`;
      taskSeq += 1;
      task = db.insertTask(
        {
          description: t.description,
          rawText: event.text,
          source: event.source,
          sourceRef: ref,
          priority,
          requestedBy: requester.id,
          dueDate: t.dueDate ?? null,
        },
        'funnel',
      );
      if (task) break;
      const existing = db.getTaskBySourceRef(event.source, ref);
      if (existing?.rawText === event.text) break; // repeated nag — keep the original task
      // slot held by a different item in this thread — try the next one
    }
    if (task) {
      db.ftsIndex('task', task.id, task.description);
      tasks += 1;
    }
  }

  // decisions
  let decisions = 0;
  let decisionSeq = 0;
  for (const d of extracted.decisions) {
    let decision: Decision | null = null;
    for (;;) {
      const ref = decisionSeq === 0 ? baseRef : `${baseRef}#d${decisionSeq + 1}`;
      decisionSeq += 1;
      decision = db.insertDecision({
        description: d.description,
        rationale: d.rationale ?? null,
        source: event.source,
        sourceRef: ref,
        decidedAt: event.occurredAt,
      });
      if (decision) break;
      const existing = db
        .listDecisionRows(10_000)
        .find((row) => row.source === event.source && row.sourceRef === ref);
      if (existing?.description === d.description) break; // same decision restated
    }
    if (decision) {
      db.ftsIndex(
        'decision',
        decision.id,
        d.rationale ? `${d.description} — ${d.rationale}` : d.description,
      );
      decisions += 1;
    }
  }

  if (tasks > 0) broadcastTasksUpdated(ctx);
  return { tasks, decisions, people: extracted.people.length };
}
