import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { migrationsDir } from '@botty/shared/migrations-dir';
import type {
  AiDecision,
  CalendarEvent,
  ChatTurn,
  Commitment,
  Decision,
  Interaction,
  PendingAction,
  PendingActionStatus,
  Person,
  ProactiveLogRow,
  Project,
  RawLogRow,
  SessionMeta,
  SourceCheckRow,
  Task,
  TaskHistory,
  TaskStatus,
  TickLogRow,
} from '@botty/shared';
import { mapRow, mapRows, nowIso } from './mapper.js';

export { nowIso } from './mapper.js';

// ---------- input shapes ----------

export interface TeamPersonInput {
  name: string;
  weight: 'CRITICAL' | 'HIGH' | 'NORMAL';
  slackHandle?: string | null;
  email?: string | null;
  cadence?: string | null;
  notes?: string | null;
}

export interface NewTask {
  description: string;
  rawText?: string | null;
  source: string;
  sourceRef?: string | null;
  priority?: number;
  requestedBy?: string | null;
  projectId?: string | null;
  dueDate?: string | null;
}

export interface TaskPatch {
  description?: string;
  status?: TaskStatus;
  priority?: number;
  requestedBy?: string | null;
  projectId?: string | null;
  dueDate?: string | null;
  snoozeUntil?: string | null;
  doneAt?: string | null;
}

export interface NewInteraction {
  personId?: string | null;
  source: string;
  kind: string;
  direction?: 'inbound' | 'outbound';
  snippet?: string | null;
  threadRef?: string | null;
  rawLogId?: string | null;
  occurredAt: string;
}

export interface NewRawLog {
  source: string;
  externalId: string;
  kind: string;
  actor?: string | null;
  body: string;
  occurredAt: string;
}

export interface NewAiDecision {
  kind: string;
  input: unknown;
  output?: unknown;
  model: string;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  relatedRef?: string | null;
  error?: string | null;
}

export interface CostRollupRow {
  kind: string;
  model: string;
  /** UTC day, YYYY-MM-DD (prefix of created_at). */
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface NewCommitment {
  description: string;
  /** ISO datetime the commitment is due. */
  dueAt: string;
  sourceTurnId?: string | null;
}

export interface NewPendingAction {
  server: string;
  tool: string;
  /** JSON-encoded arguments exactly as the model proposed them. */
  argsJson: string;
  summary: string;
  sourceTurnId?: string | null;
}

export interface FtsHit {
  kind: string;
  refId: string;
  content: string;
  /** bm25 score — lower is better. */
  score: number;
  /** created/occurred timestamp of the underlying row, when resolvable. */
  occurredAt: string | null;
}

/**
 * All database access goes through this class. Prepared statements, camelCase
 * mapping, and the exact queries the loop/funnel/chat need. Supports ':memory:'.
 */
export class Db {
  readonly raw: Database.Database;
  readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath;
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.raw = new Database(dbPath);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.migrate();
  }

  close(): void {
    this.raw.close();
  }

  // ---------- migrations ----------

  private migrate(): void {
    this.raw.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT)',
    );
    const applied = new Set(
      (this.raw.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
        (r) => r.version,
      ),
    );
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const version = Number.parseInt(file, 10);
      if (applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const run = this.raw.transaction(() => {
        this.raw.exec(sql);
        this.raw
          .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(version, nowIso());
      });
      run();
    }
  }

  // ---------- people ----------

  /** Upsert a person from TEAM.md by name (case-insensitive). Weight CRITICAL/HIGH ⇒ tier 1. */
  upsertTeamPerson(input: TeamPersonInput): Person {
    const now = nowIso();
    const tier = input.weight === 'CRITICAL' || input.weight === 'HIGH' ? 1 : 2;
    // Name first; fall back to slack handle / email so a rename in TEAM.md updates
    // the existing row instead of minting a duplicate.
    const existing =
      this.getPersonByName(input.name) ??
      this.findPersonByActor({
        ...(input.slackHandle ? { handle: input.slackHandle } : {}),
        ...(input.email ? { email: input.email } : {}),
      });
    if (existing) {
      this.raw
        .prepare(
          `UPDATE people SET name=?, name_lower=?, slack_handle=?, email=?, weight=?, tier=?, cadence=?, notes=?, source='team_md', updated_at=? WHERE id=?`,
        )
        .run(
          input.name,
          input.name.toLowerCase(),
          input.slackHandle ?? null,
          input.email ?? null,
          input.weight,
          tier,
          input.cadence ?? null,
          input.notes ?? null,
          now,
          existing.id,
        );
      return this.getPerson(existing.id)!;
    }
    const id = nanoid();
    this.raw
      .prepare(
        `INSERT INTO people (id, name, name_lower, slack_handle, email, weight, tier, cadence, notes, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'team_md', ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.name.toLowerCase(),
        input.slackHandle ?? null,
        input.email ?? null,
        input.weight,
        tier,
        input.cadence ?? null,
        input.notes ?? null,
        now,
        now,
      );
    return this.getPerson(id)!;
  }

  /**
   * Demote source='team_md' rows not in `keepIds` (removed or renamed away in
   * TEAM.md) to tier 2 / NORMAL. Returns the number of rows demoted.
   */
  demoteTeamPeopleNotIn(keepIds: string[]): number {
    const not = keepIds.length > 0 ? ` AND id NOT IN (${keepIds.map(() => '?').join(',')})` : '';
    const res = this.raw
      .prepare(
        `UPDATE people SET tier=2, weight='NORMAL', source='departed', updated_at=? WHERE source='team_md'${not}`,
      )
      .run(nowIso(), ...keepIds);
    return res.changes;
  }

  /** Upsert a person discovered from an extracted message (never downgrades team_md people). */
  upsertDiscoveredPerson(input: { name: string; slackHandle?: string; email?: string }): Person {
    // Handle/email identify a person more reliably than an extracted display name
    // ("Sarah" vs the roster's "Sarah Chen") — try them first to avoid duplicates.
    const existing =
      this.findPersonByActor({
        ...(input.slackHandle ? { handle: input.slackHandle } : {}),
        ...(input.email ? { email: input.email } : {}),
      }) ?? this.getPersonByName(input.name);
    const now = nowIso();
    if (existing) {
      this.raw
        .prepare(
          'UPDATE people SET slack_handle=COALESCE(slack_handle, ?), email=COALESCE(email, ?), updated_at=? WHERE id=?',
        )
        .run(input.slackHandle ?? null, input.email ?? null, now, existing.id);
      return this.getPerson(existing.id)!;
    }
    const id = nanoid();
    this.raw
      .prepare(
        `INSERT INTO people (id, name, name_lower, slack_handle, email, weight, tier, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'NORMAL', 2, 'discovered', ?, ?)`,
      )
      .run(id, input.name, input.name.toLowerCase(), input.slackHandle ?? null, input.email ?? null, now, now);
    return this.getPerson(id)!;
  }

  getPerson(id: string): Person | undefined {
    const row = this.raw.prepare('SELECT * FROM people WHERE id=?').get(id);
    return row ? mapRow<Person>(row) : undefined;
  }

  getPersonByName(name: string): Person | undefined {
    const row = this.raw.prepare('SELECT * FROM people WHERE name_lower=?').get(name.toLowerCase());
    return row ? mapRow<Person>(row) : undefined;
  }

  /** Resolve an inbound actor to a person via slack handle, email, or display name. */
  findPersonByActor(actor: { handle?: string; email?: string; displayName?: string }): Person | undefined {
    if (actor.handle) {
      const h = actor.handle.replace(/^@/, '');
      const row = this.raw
        .prepare('SELECT * FROM people WHERE slack_handle=? OR slack_handle=?')
        .get(h, `@${h}`);
      if (row) return mapRow<Person>(row);
    }
    if (actor.email) {
      const row = this.raw.prepare('SELECT * FROM people WHERE lower(email)=?').get(actor.email.toLowerCase());
      if (row) return mapRow<Person>(row);
    }
    if (actor.displayName) return this.getPersonByName(actor.displayName);
    return undefined;
  }

  listPeople(): Person[] {
    return mapRows<Person>(this.raw.prepare('SELECT * FROM people ORDER BY tier, name').all());
  }

  setPersonMuted(id: string, until: string | null): Person | undefined {
    this.raw.prepare('UPDATE people SET muted_until=?, updated_at=? WHERE id=?').run(until, nowIso(), id);
    return this.getPerson(id);
  }

  touchPersonInteraction(id: string, at: string): void {
    this.raw
      .prepare(
        'UPDATE people SET last_interaction_at=CASE WHEN last_interaction_at IS NULL OR last_interaction_at < ? THEN ? ELSE last_interaction_at END WHERE id=?',
      )
      .run(at, at, id);
  }

  // ---------- projects ----------

  upsertProject(name: string, description?: string | null): Project {
    const now = nowIso();
    const existing = this.raw.prepare('SELECT * FROM projects WHERE name=?').get(name);
    if (existing) return mapRow<Project>(existing);
    const id = nanoid();
    this.raw
      .prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, description ?? null, now, now);
    return mapRow<Project>(this.raw.prepare('SELECT * FROM projects WHERE id=?').get(id));
  }

  listProjects(): Project[] {
    return mapRows<Project>(this.raw.prepare('SELECT * FROM projects ORDER BY name').all());
  }

  // ---------- tasks ----------

  /**
   * Insert a task. Returns null when a task with the same (source, sourceRef)
   * already exists (dedup). Also appends a `created` task_history row.
   */
  insertTask(input: NewTask, changedBy = 'funnel'): Task | null {
    const now = nowIso();
    const id = nanoid();
    const res = this.raw
      .prepare(
        `INSERT INTO tasks (id, description, raw_text, source, source_ref, status, priority, requested_by, project_id, due_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, source_ref) DO NOTHING`,
      )
      .run(
        id,
        input.description,
        input.rawText ?? null,
        input.source,
        input.sourceRef ?? null,
        input.priority ?? 2,
        input.requestedBy ?? null,
        input.projectId ?? null,
        input.dueDate ?? null,
        now,
        now,
      );
    if (res.changes === 0) return null;
    this.appendTaskHistory(id, 'status', null, 'open', changedBy);
    return this.getTask(id)!;
  }

  getTask(id: string): Task | undefined {
    const row = this.raw.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    return row ? mapRow<Task>(row) : undefined;
  }

  getTaskBySourceRef(source: string, sourceRef: string): Task | undefined {
    const row = this.raw.prepare('SELECT * FROM tasks WHERE source=? AND source_ref=?').get(source, sourceRef);
    return row ? mapRow<Task>(row) : undefined;
  }

  /** List tasks, newest first, optionally filtered by status. Enriched with requester/project names. */
  listTasks(status?: TaskStatus): Task[] {
    const sql = `SELECT t.*, p.name AS requester_name, pr.name AS project_name
                 FROM tasks t
                 LEFT JOIN people p ON p.id = t.requested_by
                 LEFT JOIN projects pr ON pr.id = t.project_id
                 ${status ? 'WHERE t.status=?' : ''}
                 ORDER BY t.created_at DESC`;
    const rows = status ? this.raw.prepare(sql).all(status) : this.raw.prepare(sql).all();
    return mapRows<Task>(rows);
  }

  /** All open tasks (the loop's base candidate set). */
  openTasks(): Task[] {
    return this.listTasks('open');
  }

  /** Open tasks due within `withinDays` of `now` (default 2d). */
  dueSoon(now = nowIso(), withinDays = 2): Task[] {
    const horizon = new Date(Date.parse(now) + withinDays * 86_400_000).toISOString();
    return mapRows<Task>(
      this.raw
        .prepare(
          `SELECT * FROM tasks WHERE status='open' AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date`,
        )
        .all(horizon),
    );
  }

  /** Open tasks created more than `minAgeHours` ago that have never been surfaced. */
  neverSurfaced(now = nowIso(), minAgeHours = 4): Task[] {
    const cutoff = new Date(Date.parse(now) - minAgeHours * 3_600_000).toISOString();
    return mapRows<Task>(
      this.raw
        .prepare(
          `SELECT * FROM tasks WHERE status='open' AND surface_count=0 AND created_at <= ? ORDER BY created_at`,
        )
        .all(cutoff),
    );
  }

  /** Open tasks not updated in `staleDays` or more. */
  staleTasks(now = nowIso(), staleDays = 5): Task[] {
    const cutoff = new Date(Date.parse(now) - staleDays * 86_400_000).toISOString();
    return mapRows<Task>(
      this.raw
        .prepare(`SELECT * FROM tasks WHERE status='open' AND updated_at <= ? ORDER BY updated_at`)
        .all(cutoff),
    );
  }

  /** Flip snoozed tasks whose snooze expired back to open. Returns the reopened tasks. */
  unsnoozeDue(now = nowIso(), changedBy = 'loop'): Task[] {
    const due = mapRows<Task>(
      this.raw.prepare(`SELECT * FROM tasks WHERE status='snoozed' AND snooze_until <= ?`).all(now),
    );
    for (const t of due) {
      this.updateTask(t.id, { status: 'open', snoozeUntil: null }, changedBy);
    }
    return due.map((t) => this.getTask(t.id)!);
  }

  /** Patch a task; every changed field gets a task_history row. */
  updateTask(id: string, patch: TaskPatch, changedBy: string): Task {
    const before = this.getTask(id);
    if (!before) throw new Error(`task not found: ${id}`);
    const columns: Record<keyof TaskPatch, string> = {
      description: 'description',
      status: 'status',
      priority: 'priority',
      requestedBy: 'requested_by',
      projectId: 'project_id',
      dueDate: 'due_date',
      snoozeUntil: 'snooze_until',
      doneAt: 'done_at',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    const tx = this.raw.transaction(() => {
      for (const [key, col] of Object.entries(columns) as [keyof TaskPatch, string][]) {
        if (!(key in patch)) continue;
        const newValue = patch[key] ?? null;
        const oldValue = (before as unknown as Record<string, unknown>)[key] ?? null;
        if (newValue === oldValue) continue;
        sets.push(`${col}=?`);
        values.push(newValue);
        this.appendTaskHistory(
          id,
          key,
          oldValue === null ? null : String(oldValue),
          newValue === null ? null : String(newValue),
          changedBy,
        );
      }
      if (sets.length > 0) {
        sets.push('updated_at=?');
        values.push(nowIso(), id);
        this.raw.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id=?`).run(...values);
      }
    });
    tx();
    return this.getTask(id)!;
  }

  /** surface_count++ and last_surfaced_at=at (does NOT bump updated_at — surfacing is not progress). */
  recordSurface(taskId: string, at = nowIso()): void {
    this.raw
      .prepare('UPDATE tasks SET surface_count=surface_count+1, last_surfaced_at=? WHERE id=?')
      .run(at, taskId);
  }

  appendTaskHistory(
    taskId: string,
    field: string,
    oldValue: string | null,
    newValue: string | null,
    changedBy: string,
  ): void {
    this.raw
      .prepare(
        'INSERT INTO task_history (id, task_id, field, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(nanoid(), taskId, field, oldValue, newValue, changedBy, nowIso());
  }

  taskHistory(taskId: string): TaskHistory[] {
    return mapRows<TaskHistory>(
      this.raw.prepare('SELECT * FROM task_history WHERE task_id=? ORDER BY changed_at').all(taskId),
    );
  }

  // ---------- decisions (work decisions) ----------

  insertDecision(input: {
    description: string;
    rationale?: string | null;
    source: string;
    sourceRef?: string | null;
    projectId?: string | null;
    decidedAt?: string | null;
  }): Decision | null {
    const id = nanoid();
    const res = this.raw
      .prepare(
        `INSERT INTO decisions (id, description, rationale, source, source_ref, project_id, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, source_ref) DO NOTHING`,
      )
      .run(
        id,
        input.description,
        input.rationale ?? null,
        input.source,
        input.sourceRef ?? null,
        input.projectId ?? null,
        input.decidedAt ?? null,
        nowIso(),
      );
    if (res.changes === 0) return null;
    return mapRow<Decision>(this.raw.prepare('SELECT * FROM decisions WHERE id=?').get(id));
  }

  listDecisionRows(limit = 50): Decision[] {
    return mapRows<Decision>(
      this.raw.prepare('SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?').all(limit),
    );
  }

  // ---------- interactions ----------

  insertInteraction(input: NewInteraction): Interaction {
    const id = nanoid();
    this.raw
      .prepare(
        `INSERT INTO interactions (id, person_id, source, kind, direction, snippet, thread_ref, raw_log_id, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.personId ?? null,
        input.source,
        input.kind,
        input.direction ?? 'inbound',
        input.snippet ?? null,
        input.threadRef ?? null,
        input.rawLogId ?? null,
        input.occurredAt,
      );
    if (input.personId) this.touchPersonInteraction(input.personId, input.occurredAt);
    return mapRow<Interaction>(this.raw.prepare('SELECT * FROM interactions WHERE id=?').get(id));
  }

  interactionsForPerson(personId: string, limit = 50): Interaction[] {
    return mapRows<Interaction>(
      this.raw
        .prepare('SELECT * FROM interactions WHERE person_id=? ORDER BY occurred_at DESC LIMIT ?')
        .all(personId, limit),
    );
  }

  /** Interaction counts by unknown actors — promotion candidates (spec: ≥5 in 14 days). */
  countInteractionsForPersonSince(personId: string, sinceIso: string): number {
    const row = this.raw
      .prepare('SELECT COUNT(*) AS n FROM interactions WHERE person_id=? AND occurred_at >= ?')
      .get(personId, sinceIso) as { n: number };
    return row.n;
  }

  // ---------- raw_log ----------

  /** Append a raw event. Returns null when (source, externalId) already logged (DUPLICATE). */
  insertRawLog(input: NewRawLog): RawLogRow | null {
    const id = nanoid();
    const res = this.raw
      .prepare(
        `INSERT INTO raw_log (id, source, external_id, kind, actor, body, occurred_at, captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, external_id) DO NOTHING`,
      )
      .run(id, input.source, input.externalId, input.kind, input.actor ?? null, input.body, input.occurredAt, nowIso());
    if (res.changes === 0) return null;
    return this.getRawLog(id);
  }

  getRawLog(id: string): RawLogRow | null {
    const row = this.raw.prepare('SELECT * FROM raw_log WHERE id=?').get(id);
    return row ? mapRow<RawLogRow>(row) : null;
  }

  /** Replace the stored body JSON (used to stamp meta.funnelOutcome post-processing). */
  updateRawLogBody(id: string, body: string): void {
    this.raw.prepare('UPDATE raw_log SET body=? WHERE id=?').run(body, id);
  }

  listRawLog(opts: { source?: string; limit?: number } = {}): RawLogRow[] {
    const limit = opts.limit ?? 100;
    // Surface the funnel verdict (stamped into body.meta by stampOutcome) as a
    // first-class `outcome` column so consumers don't have to parse the body JSON.
    const cols = `*, CASE WHEN json_valid(body) THEN json_extract(body, '$.meta.funnelOutcome') END AS outcome`;
    const rows = opts.source
      ? this.raw
          .prepare(`SELECT ${cols} FROM raw_log WHERE source=? ORDER BY captured_at DESC LIMIT ?`)
          .all(opts.source, limit)
      : this.raw.prepare(`SELECT ${cols} FROM raw_log ORDER BY captured_at DESC LIMIT ?`).all(limit);
    // SQL yields null for unstamped rows; the schema models absence as optional.
    return mapRows<RawLogRow>(rows).map((r) => ({ ...r, outcome: r.outcome ?? undefined }));
  }

  /**
   * Raw-logged events in one source thread, oldest first: rows whose external_id
   * is `ref` (the thread starter) or whose body JSON carries `threadRef == ref`
   * (replies). Long threads keep the NEWEST `limit` rows (with the thread starter
   * swapped in) so fresh evidence — and the resolution sweep's watermark — never
   * falls out of the window.
   */
  threadEvents(source: string, ref: string, limit = 50): RawLogRow[] {
    const rows = mapRows<RawLogRow>(
      this.raw
        .prepare(
          `SELECT * FROM raw_log
           WHERE source=? AND (external_id=? OR json_extract(body, '$.threadRef')=?)
           ORDER BY occurred_at DESC, captured_at DESC LIMIT ?`,
        )
        .all(source, ref, ref, limit),
    ).reverse();
    // Window truncated and the origin fell out — swap it in for the oldest row.
    if (rows.length >= limit && !rows.some((r) => r.externalId === ref)) {
      const origin = this.raw.prepare('SELECT * FROM raw_log WHERE source=? AND external_id=?').get(source, ref);
      if (origin) rows.splice(0, 1, mapRow<RawLogRow>(origin));
    }
    return rows;
  }

  // ---------- calendar ----------

  upsertCalendarEvent(input: {
    externalId: string;
    title: string;
    startAt: string;
    endAt?: string | null;
    location?: string | null;
    attendees?: string | null;
    description?: string | null;
  }): CalendarEvent {
    const now = nowIso();
    this.raw
      .prepare(
        `INSERT INTO calendar_events (id, external_id, title, start_at, end_at, location, attendees, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(external_id) DO UPDATE SET
           title=excluded.title, start_at=excluded.start_at, end_at=excluded.end_at,
           location=excluded.location, attendees=excluded.attendees, description=excluded.description,
           updated_at=excluded.updated_at`,
      )
      .run(
        nanoid(),
        input.externalId,
        input.title,
        input.startAt,
        input.endAt ?? null,
        input.location ?? null,
        input.attendees ?? null,
        input.description ?? null,
        now,
        now,
      );
    return mapRow<CalendarEvent>(
      this.raw.prepare('SELECT * FROM calendar_events WHERE external_id=?').get(input.externalId),
    );
  }

  /** Events starting in [fromIso, toIso) — meeting-prep + briefing queries. */
  eventsStartingBetween(fromIso: string, toIso: string): CalendarEvent[] {
    return mapRows<CalendarEvent>(
      this.raw
        .prepare('SELECT * FROM calendar_events WHERE start_at >= ? AND start_at < ? ORDER BY start_at')
        .all(fromIso, toIso),
    );
  }

  // ---------- commitments (inferred, feature #2) ----------

  insertCommitment(input: NewCommitment): Commitment {
    const id = nanoid();
    const now = nowIso();
    this.raw
      .prepare(
        `INSERT INTO commitments (id, description, due_at, source_turn_id, created_at, status)
         VALUES (?, ?, ?, ?, ?, 'open')`,
      )
      .run(id, input.description, input.dueAt, input.sourceTurnId ?? null, now);
    return this.getCommitment(id)!;
  }

  getCommitment(id: string): Commitment | undefined {
    const row = this.raw.prepare('SELECT * FROM commitments WHERE id=?').get(id);
    return row ? mapRow<Commitment>(row) : undefined;
  }

  /** Open commitments due at or before `now`, earliest first (tick delivery). */
  dueCommitments(now = nowIso()): Commitment[] {
    return mapRows<Commitment>(
      this.raw
        .prepare(`SELECT * FROM commitments WHERE status='open' AND due_at <= ? ORDER BY due_at`)
        .all(now),
    );
  }

  /** All open commitments (dedup lookups on the extraction pass). */
  openCommitments(): Commitment[] {
    return mapRows<Commitment>(
      this.raw.prepare(`SELECT * FROM commitments WHERE status='open' ORDER BY due_at`).all(),
    );
  }

  markCommitmentDelivered(id: string, at = nowIso()): void {
    this.raw
      .prepare(`UPDATE commitments SET status='delivered', delivered_at=? WHERE id=?`)
      .run(at, id);
  }

  /**
   * Expire open commitments whose due date is more than `graceHours` in the past
   * and were never delivered. Called at the start of tick delivery gathering.
   * Returns the number of rows expired.
   */
  expireStaleCommitments(now = nowIso(), graceHours: number): number {
    const cutoff = new Date(Date.parse(now) - graceHours * 3_600_000).toISOString();
    const res = this.raw
      .prepare(`UPDATE commitments SET status='expired' WHERE status='open' AND due_at < ?`)
      .run(cutoff);
    return res.changes;
  }

  /** Deliveries (status='delivered') since `sinceIso` — the maxPerDay cap. */
  countCommitmentDeliveriesSince(sinceIso: string): number {
    const row = this.raw
      .prepare(`SELECT COUNT(*) AS n FROM commitments WHERE status='delivered' AND delivered_at >= ?`)
      .get(sinceIso) as { n: number };
    return row.n;
  }

  /** Newest-first page of commitments (Inspector-ish reads). */
  listCommitments(limit = 50): Commitment[] {
    return mapRows<Commitment>(
      this.raw.prepare('SELECT * FROM commitments ORDER BY created_at DESC LIMIT ?').all(limit),
    );
  }

  // ---------- chat turns & sessions ----------

  insertChatTurn(input: {
    id?: string;
    sessionId: string;
    role: 'user' | 'assistant';
    content: string;
    meta?: Record<string, unknown> | null;
  }): ChatTurn {
    const id = input.id ?? nanoid();
    this.raw
      .prepare('INSERT INTO chat_turns (id, session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.sessionId, input.role, input.content, input.meta ? JSON.stringify(input.meta) : null, nowIso());
    return this.getChatTurn(id)!;
  }

  getChatTurn(id: string): ChatTurn | undefined {
    const row = this.raw.prepare('SELECT * FROM chat_turns WHERE id=?').get(id);
    if (!row) return undefined;
    const turn = mapRow<ChatTurn & { meta: string | null }>(row);
    return { ...turn, meta: turn.meta ? (JSON.parse(turn.meta) as Record<string, unknown>) : null };
  }

  turnsForSession(sessionId: string): ChatTurn[] {
    const rows = this.raw
      .prepare('SELECT id FROM chat_turns WHERE session_id=? ORDER BY created_at, id')
      .all(sessionId) as { id: string }[];
    return rows.map((r) => this.getChatTurn(r.id)!);
  }

  countTurnsForSession(sessionId: string): number {
    const row = this.raw
      .prepare('SELECT COUNT(*) AS n FROM chat_turns WHERE session_id=?')
      .get(sessionId) as { n: number };
    return row.n;
  }

  /** Oldest-first page of one session's turns (session_search browse-mode scrolling). */
  turnsForSessionPage(sessionId: string, offset = 0, limit = 20): ChatTurn[] {
    const rows = this.raw
      .prepare('SELECT id FROM chat_turns WHERE session_id=? ORDER BY created_at, id LIMIT ? OFFSET ?')
      .all(sessionId, limit, offset) as { id: string }[];
    return rows.map((r) => this.getChatTurn(r.id)!);
  }

  /** Newest-last window over the single continuous chat thread. */
  chatHistory(opts: { limit?: number; before?: string } = {}): ChatTurn[] {
    const limit = opts.limit ?? 50;
    const rows = (
      opts.before
        ? this.raw
            .prepare('SELECT id FROM chat_turns WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT ?')
            .all(opts.before, limit)
        : this.raw.prepare('SELECT id FROM chat_turns ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)
    ) as { id: string }[];
    return rows.reverse().map((r) => this.getChatTurn(r.id)!);
  }

  createSession(kind = 'chat'): SessionMeta {
    const id = nanoid();
    const now = nowIso();
    this.raw
      .prepare(
        "INSERT INTO sessions (id, kind, status, created_at, last_active_at) VALUES (?, ?, 'active', ?, ?)",
      )
      .run(id, kind, now, now);
    return this.getSessionMeta(id)!;
  }

  getSessionMeta(id: string): SessionMeta | undefined {
    const row = this.raw.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    if (!row) return undefined;
    const full = mapRow<SessionMeta & { providerSessionId: string | null }>(row);
    const { providerSessionId: _drop, ...meta } = full;
    return meta;
  }

  getProviderSessionId(sessionId: string): string | null {
    const row = this.raw.prepare('SELECT provider_session_id FROM sessions WHERE id=?').get(sessionId) as
      | { provider_session_id: string | null }
      | undefined;
    return row?.provider_session_id ?? null;
  }

  setProviderSessionId(sessionId: string, providerSessionId: string): void {
    this.raw.prepare('UPDATE sessions SET provider_session_id=? WHERE id=?').run(providerSessionId, sessionId);
  }

  /** The single currently-active chat session, if any. */
  activeSession(kind = 'chat'): SessionMeta | undefined {
    const row = this.raw
      .prepare("SELECT id FROM sessions WHERE kind=? AND status='active' ORDER BY last_active_at DESC LIMIT 1")
      .get(kind) as { id: string } | undefined;
    return row ? this.getSessionMeta(row.id) : undefined;
  }

  touchSession(id: string, at = nowIso()): void {
    this.raw.prepare('UPDATE sessions SET last_active_at=? WHERE id=?').run(at, id);
  }

  sealSession(id: string, summary: string | null): void {
    this.raw.prepare("UPDATE sessions SET status='sealed', summary=? WHERE id=?").run(summary, id);
  }

  recentSealedSummaries(limit = 3): { id: string; summary: string; lastActiveAt: string }[] {
    return mapRows<{ id: string; summary: string; lastActiveAt: string }>(
      this.raw
        .prepare(
          "SELECT id, summary, last_active_at FROM sessions WHERE status='sealed' AND summary IS NOT NULL ORDER BY last_active_at DESC, rowid DESC LIMIT ?",
        )
        .all(limit),
    );
  }

  listSessions(limit = 20): SessionMeta[] {
    const rows = this.raw
      .prepare('SELECT id FROM sessions ORDER BY last_active_at DESC LIMIT ?')
      .all(limit) as { id: string }[];
    return rows.map((r) => this.getSessionMeta(r.id)!);
  }

  // ---------- proactive log ----------

  insertProactiveLog(input: {
    taskId?: string | null;
    surfaceKind: string;
    message: string;
    score?: number | null;
    trigger?: string | null;
    surfacedAt?: string;
  }): ProactiveLogRow {
    const id = nanoid();
    this.raw
      .prepare(
        'INSERT INTO proactive_log (id, task_id, surface_kind, message, score, trigger, surfaced_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.taskId ?? null,
        input.surfaceKind,
        input.message,
        input.score ?? null,
        input.trigger ?? null,
        input.surfacedAt ?? nowIso(),
      );
    return mapRow<ProactiveLogRow>(this.raw.prepare('SELECT * FROM proactive_log WHERE id=?').get(id));
  }

  setProactiveResponse(id: string, responseType: string, reason?: string | null): void {
    this.raw
      .prepare('UPDATE proactive_log SET response_type=?, response_reason=?, response_at=? WHERE id=?')
      .run(responseType, reason ?? null, nowIso(), id);
  }

  /** Surfaces since `sinceIso` (hourly cap + response tracker window). */
  surfacesSince(sinceIso: string): ProactiveLogRow[] {
    return mapRows<ProactiveLogRow>(
      this.raw.prepare('SELECT * FROM proactive_log WHERE surfaced_at >= ? ORDER BY surfaced_at DESC').all(sinceIso),
    );
  }

  /** Un-responded surfaces since `sinceIso` (response-tracker candidates). */
  openSurfacesSince(sinceIso: string): ProactiveLogRow[] {
    return mapRows<ProactiveLogRow>(
      this.raw
        .prepare(
          'SELECT * FROM proactive_log WHERE response_type IS NULL AND surfaced_at >= ? ORDER BY surfaced_at DESC',
        )
        .all(sinceIso),
    );
  }

  /** Timestamp of the most recent surface of any task (global min-gap gate). */
  lastSurfaceAt(): string | null {
    const row = this.raw.prepare('SELECT MAX(surfaced_at) AS at FROM proactive_log').get() as { at: string | null };
    return row.at;
  }

  surfacesForTask(taskId: string, limit = 5): ProactiveLogRow[] {
    return mapRows<ProactiveLogRow>(
      this.raw
        .prepare('SELECT * FROM proactive_log WHERE task_id=? ORDER BY surfaced_at DESC LIMIT ?')
        .all(taskId, limit),
    );
  }

  /** Mark unanswered surfaces older than `beforeIso` as expired. Returns affected count. */
  expireSurfacesBefore(beforeIso: string): number {
    const res = this.raw
      .prepare(
        "UPDATE proactive_log SET response_type='expired', response_at=? WHERE response_type IS NULL AND surfaced_at < ?",
      )
      .run(nowIso(), beforeIso);
    return res.changes;
  }

  // ---------- tick log ----------

  insertTickLog(trigger: string): TickLogRow {
    const id = nanoid();
    this.raw.prepare('INSERT INTO tick_log (id, trigger, started_at) VALUES (?, ?, ?)').run(id, trigger, nowIso());
    return this.getTick(id)!;
  }

  finishTickLog(
    id: string,
    patch: {
      finishedAt?: string;
      candidatesIn?: number | null;
      candidatesAfterRules?: number | null;
      actionsJson?: string | null;
      skippedJson?: string | null;
      judgmentDecisionId?: string | null;
      error?: string | null;
    },
  ): TickLogRow {
    this.raw
      .prepare(
        `UPDATE tick_log SET finished_at=?, candidates_in=COALESCE(?, candidates_in),
           candidates_after_rules=COALESCE(?, candidates_after_rules), actions_json=COALESCE(?, actions_json),
           skipped_json=COALESCE(?, skipped_json), judgment_decision_id=COALESCE(?, judgment_decision_id),
           error=COALESCE(?, error)
         WHERE id=?`,
      )
      .run(
        patch.finishedAt ?? nowIso(),
        patch.candidatesIn ?? null,
        patch.candidatesAfterRules ?? null,
        patch.actionsJson ?? null,
        patch.skippedJson ?? null,
        patch.judgmentDecisionId ?? null,
        patch.error ?? null,
        id,
      );
    return this.getTick(id)!;
  }

  getTick(id: string): TickLogRow | undefined {
    const row = this.raw.prepare('SELECT * FROM tick_log WHERE id=?').get(id);
    return row ? mapRow<TickLogRow>(row) : undefined;
  }

  listTicks(limit = 20): TickLogRow[] {
    return mapRows<TickLogRow>(
      this.raw.prepare('SELECT * FROM tick_log ORDER BY started_at DESC LIMIT ?').all(limit),
    );
  }

  // ---------- ai_decisions ----------

  insertAiDecision(input: NewAiDecision): AiDecision {
    const id = nanoid();
    this.raw
      .prepare(
        `INSERT INTO ai_decisions (id, kind, input_json, output_json, model, latency_ms, input_tokens, output_tokens, related_ref, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        JSON.stringify(input.input ?? null),
        input.output === undefined ? null : JSON.stringify(input.output),
        input.model,
        input.latencyMs ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.relatedRef ?? null,
        input.error ?? null,
        nowIso(),
      );
    return this.getAiDecision(id)!;
  }

  getAiDecision(id: string): AiDecision | undefined {
    const row = this.raw.prepare('SELECT * FROM ai_decisions WHERE id=?').get(id);
    return row ? mapRow<AiDecision>(row) : undefined;
  }

  listAiDecisions(opts: { kind?: string; limit?: number; before?: string } = {}): AiDecision[] {
    const limit = opts.limit ?? 50;
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.kind) {
      where.push('kind=?');
      params.push(opts.kind);
    }
    if (opts.before) {
      where.push('created_at < ?');
      params.push(opts.before);
    }
    const sql = `SELECT * FROM ai_decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
    return mapRows<AiDecision>(this.raw.prepare(sql).all(...params, limit));
  }

  /**
   * Per (kind, model, UTC day) usage rollup over all of ai_decisions — the raw
   * material for the costs report. Token sums treat NULL as 0.
   */
  costRollup(): CostRollupRow[] {
    return mapRows<CostRollupRow>(
      this.raw
        .prepare(
          `SELECT kind, model, substr(created_at, 1, 10) AS day, COUNT(*) AS calls,
                  COALESCE(SUM(input_tokens), 0) AS input_tokens,
                  COALESCE(SUM(output_tokens), 0) AS output_tokens
           FROM ai_decisions
           GROUP BY kind, model, day`,
        )
        .all(),
    );
  }

  // ---------- source_check_log ----------

  insertSourceCheck(input: {
    source: string;
    eventsFetched?: number;
    eventsNew?: number;
    error?: string | null;
  }): SourceCheckRow {
    const id = nanoid();
    this.raw
      .prepare(
        'INSERT INTO source_check_log (id, source, checked_at, events_fetched, events_new, error) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, input.source, nowIso(), input.eventsFetched ?? 0, input.eventsNew ?? 0, input.error ?? null);
    return mapRow<SourceCheckRow>(this.raw.prepare('SELECT * FROM source_check_log WHERE id=?').get(id));
  }

  listSourceChecks(limit = 50): SourceCheckRow[] {
    return mapRows<SourceCheckRow>(
      this.raw.prepare('SELECT * FROM source_check_log ORDER BY checked_at DESC LIMIT ?').all(limit),
    );
  }

  // ---------- settings ----------

  getSetting<T>(key: string): T | undefined {
    const row = this.raw.prepare('SELECT value FROM settings WHERE key=?').get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return undefined;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.raw
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }

  allSettings(): Record<string, unknown> {
    const rows = this.raw.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        out[r.key] = r.value;
      }
    }
    return out;
  }

  // ---------- pending_actions (consent-gated external MCP tools) ----------

  insertPendingAction(input: NewPendingAction): PendingAction {
    const id = nanoid();
    const now = nowIso();
    this.raw
      .prepare(
        `INSERT INTO pending_actions (id, server, tool, args_json, summary, status, created_at, resolved_at, result_json, source_turn_id)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?)`,
      )
      .run(id, input.server, input.tool, input.argsJson, input.summary, now, input.sourceTurnId ?? null);
    return this.getPendingAction(id)!;
  }

  getPendingAction(id: string): PendingAction | undefined {
    const row = this.raw.prepare('SELECT * FROM pending_actions WHERE id=?').get(id);
    return row ? mapRow<PendingAction>(row) : undefined;
  }

  listPendingActions(status?: PendingActionStatus): PendingAction[] {
    const sql = `SELECT * FROM pending_actions ${status ? 'WHERE status=?' : ''} ORDER BY created_at DESC`;
    return mapRows<PendingAction>(status ? this.raw.prepare(sql).all(status) : this.raw.prepare(sql).all());
  }

  /** Dedup lookup: an identical (server, tool, argsJson) call already awaiting approval. */
  findPendingActionByArgs(server: string, tool: string, argsJson: string): PendingAction | undefined {
    const row = this.raw
      .prepare(`SELECT * FROM pending_actions WHERE server=? AND tool=? AND args_json=? AND status='pending'`)
      .get(server, tool, argsJson);
    return row ? mapRow<PendingAction>(row) : undefined;
  }

  countPendingActionsByStatus(status: PendingActionStatus): number {
    const row = this.raw.prepare('SELECT COUNT(*) AS n FROM pending_actions WHERE status=?').get(status) as {
      n: number;
    };
    return row.n;
  }

  /** Pending rows older than `cutoffIso` — the queue layer's lazy-expiry read. */
  stalePendingActions(cutoffIso: string): PendingAction[] {
    return mapRows<PendingAction>(
      this.raw
        .prepare(`SELECT * FROM pending_actions WHERE status='pending' AND created_at < ? ORDER BY created_at`)
        .all(cutoffIso),
    );
  }

  /** Flip a pending action to a terminal status (executed / failed / dismissed / expired). */
  resolvePendingAction(
    id: string,
    patch: { status: PendingActionStatus; resolvedAt: string; resultJson: string | null },
  ): PendingAction {
    this.raw
      .prepare('UPDATE pending_actions SET status=?, resolved_at=?, result_json=? WHERE id=?')
      .run(patch.status, patch.resolvedAt, patch.resultJson, id);
    return this.getPendingAction(id)!;
  }

  // ---------- FTS ----------

  /** Index (or re-index) a memory row. Idempotent per (kind, refId). */
  ftsIndex(kind: 'task' | 'decision' | 'interaction' | 'chat', refId: string, content: string): void {
    const tx = this.raw.transaction(() => {
      this.raw.prepare('DELETE FROM memory_fts WHERE kind=? AND ref_id=?').run(kind, refId);
      this.raw.prepare('INSERT INTO memory_fts (kind, ref_id, content) VALUES (?, ?, ?)').run(kind, refId, content);
    });
    tx();
  }

  /** bm25-ranked full-text search with join-back for recency tiebreak. */
  ftsSearch(query: string, limit = 5): FtsHit[] {
    const match = sanitizeFtsQuery(query);
    if (!match) return [];
    const rows = this.raw
      .prepare(
        'SELECT kind, ref_id, content, bm25(memory_fts) AS score FROM memory_fts WHERE memory_fts MATCH ? ORDER BY score LIMIT ?',
      )
      .all(match, limit * 3) as { kind: string; ref_id: string; content: string; score: number }[];
    return this.rankFtsRows(rows, limit);
  }

  /** ftsSearch restricted to one kind (e.g. 'chat' for session_search over past turns). */
  ftsSearchKind(kind: 'task' | 'decision' | 'interaction' | 'chat', query: string, limit = 5): FtsHit[] {
    const match = sanitizeFtsQuery(query);
    if (!match) return [];
    const rows = this.raw
      .prepare(
        'SELECT kind, ref_id, content, bm25(memory_fts) AS score FROM memory_fts WHERE memory_fts MATCH ? AND kind=? ORDER BY score LIMIT ?',
      )
      .all(match, kind, limit * 3) as { kind: string; ref_id: string; content: string; score: number }[];
    return this.rankFtsRows(rows, limit);
  }

  /** Shared FTS post-processing: resolve timestamps, sort bm25-then-recency, cap. */
  private rankFtsRows(
    rows: { kind: string; ref_id: string; content: string; score: number }[],
    limit: number,
  ): FtsHit[] {
    const hits: FtsHit[] = rows.map((r) => ({
      kind: r.kind,
      refId: r.ref_id,
      content: r.content,
      score: r.score,
      occurredAt: this.resolveMemoryTimestamp(r.kind, r.ref_id),
    }));
    // Primary: bm25 (lower = better). Tiebreak: recency.
    hits.sort((a, b) => {
      if (Math.abs(a.score - b.score) > 1e-9) return a.score - b.score;
      return (b.occurredAt ?? '').localeCompare(a.occurredAt ?? '');
    });
    return hits.slice(0, limit);
  }

  private resolveMemoryTimestamp(kind: string, refId: string): string | null {
    const q: Record<string, string> = {
      task: 'SELECT created_at AS at FROM tasks WHERE id=?',
      decision: 'SELECT created_at AS at FROM decisions WHERE id=?',
      interaction: 'SELECT occurred_at AS at FROM interactions WHERE id=?',
      chat: 'SELECT created_at AS at FROM chat_turns WHERE id=?',
    };
    const sql = q[kind];
    if (!sql) return null;
    const row = this.raw.prepare(sql).get(refId) as { at: string } | undefined;
    return row?.at ?? null;
  }
}

/** Turn arbitrary user text into a safe FTS5 MATCH expression (quoted OR'd tokens). */
export function sanitizeFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' OR ');
}
