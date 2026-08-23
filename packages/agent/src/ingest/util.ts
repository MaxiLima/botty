import type { FunnelOutcome, Person, RawLogRow, SourceEvent, Task } from '@botty/shared';
import type { Bus } from '../bus/index.js';
import type { Db, TaskPatch } from '../db/index.js';
import type { LlmClient } from '../llm/types.js';

/** The slice of AgentContext the funnel needs (kept narrow for tests). */
export interface FunnelCtx {
  db: Db;
  llm: LlmClient;
  bus: Bus;
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function actorLabel(actor: SourceEvent['actor']): string | null {
  return actor.handle ?? actor.email ?? actor.displayName ?? null;
}

/** Funnel step 1 — append to raw_log. Returns null on (source, externalId) conflict (DUPLICATE). */
export function insertEventRawLog(db: Db, event: SourceEvent): RawLogRow | null {
  return db.insertRawLog({
    source: event.source,
    externalId: event.externalId,
    kind: event.kind,
    actor: actorLabel(event.actor),
    body: JSON.stringify(event),
    occurredAt: event.occurredAt,
  });
}

/**
 * Write the funnel verdict back into raw_log.body.meta.funnelOutcome (plus an
 * optional funnelDetail blob) so the Inspector can answer "why didn't this
 * become a task?" for every raw event.
 */
export function stampOutcome(
  db: Db,
  rawLog: RawLogRow,
  event: SourceEvent,
  outcome: FunnelOutcome,
  detail?: Record<string, unknown>,
): void {
  const body = {
    ...event,
    meta: { ...event.meta, funnelOutcome: outcome, ...(detail ? { funnelDetail: detail } : {}) },
  };
  db.updateRawLogBody(rawLog.id, JSON.stringify(body));
}

/** Insert an interactions row for the event's actor + FTS-index the snippet. */
export function logInteraction(
  ctx: Pick<FunnelCtx, 'db'>,
  event: SourceEvent,
  rawLogId: string,
  personId: string | null,
): void {
  const snippet = clip(event.text.replace(/\s+/g, ' ').trim(), 200) || null;
  const interaction = ctx.db.insertInteraction({
    personId,
    source: event.source,
    kind: event.kind,
    direction: event.direction,
    snippet,
    threadRef: event.threadRef ?? null,
    rawLogId,
    occurredAt: event.occurredAt,
  });
  if (snippet) ctx.db.ftsIndex('interaction', interaction.id, snippet);
}

/**
 * Local parts (and slack handles) that belong to a machine, not a person:
 * `noreply@github.com`, `billing@aws-billing.example`, `notifications+abc@…`,
 * `mailer-daemon@…`, `dependabot[bot]`. Matched against the local part with
 * separators normalized away, and against each `+`-tag separately — automation
 * routinely tags (`github+noreply@`, `billing+invoice@`).
 */
const AUTOMATED_LOCAL_RE =
  /^(noreply|noresponse|donotreply|dontreply|notification|notifications|notify|mailerdaemon|daemon|bounce|bounces|billing|invoices?|receipts?|postmaster|automated|automation|robot|bot|alerts?|newsletter|mailer)(\d+)?$/;

/** `dependabot[bot]`, `@ci-bot`, `renovate[bot]` — a bot however it spells itself. */
const BOT_SUFFIX_RE = /(\[bot\]|[-_.]bot)$/i;

/**
 * True when this actor is a machine sender that must never become a
 * "discovered person" (2026-08-21 report, MEDIUM "Ingestion": `billing@aws…`
 * and `noreply@github` were verified live as tier-2 people, polluting the
 * roster, the promotion-candidate query and every prompt built from it).
 *
 * Identity-only: an automated sender still gets its interaction row (with a
 * null person_id), it just doesn't get a person.
 */
export function isAutomatedActor(actor: SourceEvent['actor']): boolean {
  const handle = actor.handle?.replace(/^@/, '');
  if (handle && (BOT_SUFFIX_RE.test(handle) || isAutomatedLocalPart(handle))) return true;
  if (actor.displayName && BOT_SUFFIX_RE.test(actor.displayName)) return true;
  const email = actor.email?.toLowerCase();
  if (!email) return false;
  const local = email.split('@')[0] ?? '';
  // base + every `+`-tag: `notifications+kd83@github.com`, `acme+noreply@…`
  return local.split('+').some((part) => isAutomatedLocalPart(part));
}

function isAutomatedLocalPart(part: string): boolean {
  const flat = part.toLowerCase().replace(/[._-]/g, '');
  return AUTOMATED_LOCAL_RE.test(flat);
}

/**
 * Upsert a tier-2 'discovered' person for an unknown actor so interactions
 * attach to a person row (feeds the ≥5-in-14-days promotion-candidate query).
 * Returns undefined when the actor carries no usable identity, or when it is
 * an automated sender (see isAutomatedActor).
 */
export function discoverActor(db: Db, actor: SourceEvent['actor']): Person | undefined {
  if (isAutomatedActor(actor)) return undefined;
  const name = actor.displayName ?? actor.handle?.replace(/^@/, '') ?? actor.email;
  if (!name) return undefined;
  return db.upsertDiscoveredPerson({
    name,
    slackHandle: actor.handle,
    email: actor.email,
  });
}

/** Diacritic-folded, lowercased, whitespace-collapsed name for fuzzy matching. */
function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Every token of `inner` appears in `outer` ("marian" ⊂ "marian gutierrez"). */
function isTokenSubset(inner: string[], outer: string[]): boolean {
  if (inner.length === 0 || inner.length > outer.length) return false;
  return inner.every((t) => outer.includes(t));
}

/** Prefer the most important match; refuse to guess between equals. */
function pickUnambiguous(matches: Person[]): Person | undefined {
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  const bestTier = Math.min(...matches.map((p) => p.tier));
  const best = matches.filter((p) => p.tier === bestTier);
  return best.length === 1 ? best[0] : undefined; // ambiguous — don't guess
}

/**
 * Resolve a name the extractor produced to a person already known to the
 * roster, tolerating the ways an LLM renames people (2026-08-21 report,
 * MEDIUM "Ingestion"): "Marian Gutiérrez" for the team's "Marian", "marian",
 * "Marian G." Matching order — exact `name_lower`, then diacritic/case-folded
 * equality, then whole-token subset in either direction. Ambiguous matches
 * ("Marian" with two Marians on the roster, neither tier-1) resolve to
 * undefined rather than picking one.
 *
 * Never mutates. Returns undefined when nothing on the roster plausibly
 * matches — the caller decides whether that warrants a discovered person.
 */
export function resolveKnownPerson(db: Db, rawName: string): Person | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) return undefined;
  const exact = db.getPersonByName(trimmed);
  if (exact) return exact;

  const target = normalizeName(trimmed);
  if (!target) return undefined;
  const people = db.listPeople();

  const folded = people.filter((p) => normalizeName(p.name) === target);
  const foldedPick = pickUnambiguous(folded);
  if (foldedPick) return foldedPick;

  const targetTokens = target.split(' ');
  const subset = people.filter((p) => {
    const tokens = normalizeName(p.name).split(' ');
    // Guard against one-letter initials matching everything.
    if (!tokens.some((t) => t.length >= 3) || !targetTokens.some((t) => t.length >= 3)) return false;
    return isTokenSubset(tokens, targetTokens) || isTokenSubset(targetTokens, tokens);
  });
  return pickUnambiguous(subset);
}

/** New evidence about a task that already exists (see mergeTaskEvidence). */
export interface TaskEvidence {
  requestedBy?: string | null;
  dueDate?: string | null;
  priority?: number | null;
  /** Raw text of the message carrying the evidence — recorded in task_history. */
  note?: string | null;
  /** True for a same-thread re-ask: a human asked again, so re-surface it. */
  followUp?: boolean;
  changedBy?: string;
}

export interface MergeResult {
  task: Task;
  /** The merge added or tightened requester / due date / priority. */
  strengthened: boolean;
  /** Surfacing history was reset, so the task can be nudged about again. */
  resurfaced: boolean;
}

/**
 * H4 — fold a duplicate ask's metadata INTO the task that survives, instead of
 * discarding it. Before this, whichever event won the race defined the task
 * forever: when the GitHub `review requested #482` upsert landed first, the
 * Slack ask behind it ("Marian: review PR #482 before EOD") was stamped
 * DEDUPED and its requester, due date and P1 went in the bin.
 *
 * Conservative, never destructive:
 * - requester: only fills an EMPTY requester (never re-attributes a task)
 * - due date: only sets an empty one, or pulls an existing one EARLIER
 * - priority: only upgrades (lower number = more urgent), never downgrades
 * - description/owner/source: untouched — the surviving task keeps its identity
 *
 * The message text is appended to `task_history` as evidence (there is no
 * writable `raw_text` on the update path), so the Inspector and the task
 * drawer can show why a task's due date moved.
 *
 * Re-surfacing: a same-thread follow-up (a human re-asking) resets surfacing
 * history so the task is a NEVER_SURFACED candidate again — the cooldown and
 * hard-cap gates exist to damp botty's own repetition, not to silence a
 * teammate who asked twice. A cross-source merge only re-surfaces when the new
 * evidence actually strengthened the task.
 */
export function mergeTaskEvidence(db: Db, task: Task, evidence: TaskEvidence): MergeResult {
  const changedBy = evidence.changedBy ?? 'funnel';
  const patch: TaskPatch = {};

  if (!task.requestedBy && evidence.requestedBy) patch.requestedBy = evidence.requestedBy;
  if (evidence.dueDate && isEarlierDue(evidence.dueDate, task.dueDate)) {
    patch.dueDate = evidence.dueDate;
  }
  if (typeof evidence.priority === 'number' && evidence.priority < task.priority) {
    patch.priority = evidence.priority;
  }
  const strengthened = Object.keys(patch).length > 0;

  const resurface = (evidence.followUp === true || strengthened) && task.surfaceCount > 0;
  if (resurface) {
    patch.surfaceCount = 0;
    patch.lastSurfacedAt = null;
  }

  const note = evidence.note?.replace(/\s+/g, ' ').trim();
  if (note) db.appendTaskHistory(task.id, 'evidence', null, clip(note, 200), changedBy);

  const updated = Object.keys(patch).length > 0 ? db.updateTask(task.id, patch, changedBy) : task;
  return { task: updated, strengthened, resurfaced: resurface };
}

/** Date-only (`YYYY-MM-DD`) sorts lexicographically against itself and ISO instants alike. */
function isEarlierDue(incoming: string, current: string | null): boolean {
  if (!current) return true;
  const a = Date.parse(normalizeDueForCompare(incoming));
  const b = Date.parse(normalizeDueForCompare(current));
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return a < b;
}

/** Compare a date-only due at end of day so it never looks earlier than a same-day instant. */
function normalizeDueForCompare(due: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(due) ? `${due}T23:59:59.999Z` : due;
}

/** WS `tasks.updated` after any funnel/structured task write. */
export function broadcastTasksUpdated(ctx: Pick<FunnelCtx, 'db' | 'bus'>): void {
  ctx.bus.broadcast({ type: 'tasks.updated', payload: { tasks: ctx.db.listTasks('open') } });
}
