import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrationsDir } from '@botty/shared/migrations-dir';
import { describe, expect, it, beforeEach } from 'vitest';
import { Db } from '../src/db/index.js';

let db: Db;
beforeEach(() => {
  db = new Db(':memory:');
});

describe('Db', () => {
  it('runs migrations on open (idempotent tracking)', () => {
    const versions = db.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('insertAiDecision without cache/cost fields stores NULL, not 0', () => {
    const decision = db.insertAiDecision({ kind: 'chat_turn', input: {}, model: 'claude-sonnet-5' });
    expect(decision.cacheReadInputTokens).toBeNull();
    expect(decision.cacheCreationInputTokens).toBeNull();
    expect(decision.totalCostUsd).toBeNull();
  });

  it('people round-trip: team upsert derives tier from weight and updates in place', () => {
    const p = db.upsertTeamPerson({ name: 'Marian', weight: 'CRITICAL', slackHandle: '@marian', email: 'marian@acme.example' });
    expect(p.tier).toBe(1);
    expect(p.slackHandle).toBe('@marian');

    const updated = db.upsertTeamPerson({ name: 'marian', weight: 'NORMAL' });
    expect(updated.id).toBe(p.id);
    expect(updated.tier).toBe(2);
    expect(db.listPeople()).toHaveLength(1);
  });

  it('resolves actors by handle, email, and name', () => {
    db.upsertTeamPerson({ name: 'Sofi', weight: 'CRITICAL', slackHandle: '@sofi', email: 'sofi@acme.example' });
    expect(db.findPersonByActor({ handle: 'sofi' })?.name).toBe('Sofi');
    expect(db.findPersonByActor({ handle: '@sofi' })?.name).toBe('Sofi');
    expect(db.findPersonByActor({ email: 'SOFI@acme.example' })?.name).toBe('Sofi');
    expect(db.findPersonByActor({ displayName: 'sofi' })?.name).toBe('Sofi');
    // Slack renders the same actor as @Diego or @diego depending on where the
    // mention came from — a case-sensitive compare demoted a Tier-1 teammate.
    expect(db.findPersonByActor({ handle: 'Sofi' })?.name).toBe('Sofi');
    expect(db.findPersonByActor({ handle: '@SOFI' })?.name).toBe('Sofi');
    expect(db.findPersonByActor({ handle: 'nobody' })).toBeUndefined();
  });

  it('upsertDiscoveredPerson matches existing people by email/handle before name', () => {
    const sarah = db.upsertTeamPerson({ name: 'Sarah Chen', weight: 'CRITICAL', email: 'sarah@co.com' });
    // extractor returns a short name but the same email → same row, tier preserved
    const byEmail = db.upsertDiscoveredPerson({ name: 'Sarah', email: 'sarah@co.com' });
    expect(byEmail.id).toBe(sarah.id);
    expect(byEmail.tier).toBe(1);
    expect(db.listPeople()).toHaveLength(1);

    const diego = db.upsertTeamPerson({ name: 'Diego Paz', weight: 'HIGH', slackHandle: '@diego' });
    expect(db.upsertDiscoveredPerson({ name: 'Diego', slackHandle: 'diego' }).id).toBe(diego.id);
    // no identifying handle/email and an unknown name → genuinely new person
    expect(db.upsertDiscoveredPerson({ name: 'Stranger' }).tier).toBe(2);
    expect(db.listPeople()).toHaveLength(3);
  });

  it('upsertTeamPerson follows renames via handle/email; demoteTeamPeopleNotIn drops departed to tier 2', () => {
    const alex = db.upsertTeamPerson({ name: 'Alex', weight: 'CRITICAL', email: 'alex@co.com' });
    const bo = db.upsertTeamPerson({ name: 'Bo', weight: 'HIGH', slackHandle: '@bo' });
    const discovered = db.upsertDiscoveredPerson({ name: 'Randomer' });

    // rename Alex → Alexandra (same email): updates in place, findable by new name
    const renamed = db.upsertTeamPerson({ name: 'Alexandra', weight: 'CRITICAL', email: 'alex@co.com' });
    expect(renamed.id).toBe(alex.id);
    expect(db.getPersonByName('Alexandra')?.id).toBe(alex.id);
    expect(db.getPersonByName('Alex')).toBeUndefined();

    // Bo left the team: demoted, discovered people untouched
    expect(db.demoteTeamPeopleNotIn([renamed.id])).toBe(1);
    const gone = db.getPerson(bo.id)!;
    expect(gone.tier).toBe(2);
    expect(gone.weight).toBe('NORMAL');
    expect(db.getPerson(renamed.id)?.tier).toBe(1);
    expect(db.getPerson(discovered.id)?.tier).toBe(2);
  });

  it('threadEvents keeps the newest window with the thread starter swapped in', () => {
    db.insertRawLog({ source: 'slack', externalId: 'T1', kind: 'dm', body: JSON.stringify({ text: 'origin ask' }), occurredAt: '2026-07-01T00:00:00Z' });
    for (let i = 1; i <= 6; i++) {
      db.insertRawLog({
        source: 'slack',
        externalId: `T1-r${i}`,
        kind: 'dm',
        body: JSON.stringify({ text: `reply ${i}`, threadRef: 'T1' }),
        occurredAt: `2026-07-01T00:0${i}:00Z`,
      });
    }
    const rows = db.threadEvents('slack', 'T1', 5);
    expect(rows).toHaveLength(5);
    // origin survives even though it is the oldest row...
    expect(rows[0]!.externalId).toBe('T1');
    // ...and the newest replies are kept (the watermark can still advance)
    expect(rows[rows.length - 1]!.externalId).toBe('T1-r6');
    expect(rows.map((r) => r.externalId)).not.toContain('T1-r2');
    // short threads: everything, oldest first
    expect(db.threadEvents('slack', 'T1').map((r) => r.externalId)).toEqual([
      'T1', 'T1-r1', 'T1-r2', 'T1-r3', 'T1-r4', 'T1-r5', 'T1-r6',
    ]);
  });

  it('tasks: insert, dedup by (source, sourceRef), update with history', () => {
    const t = db.insertTask({ description: 'Review PR', source: 'slack', sourceRef: 'thread-1' });
    expect(t).not.toBeNull();
    expect(db.insertTask({ description: 'dup', source: 'slack', sourceRef: 'thread-1' })).toBeNull();
    // NULL sourceRef never dedups
    expect(db.insertTask({ description: 'a', source: 'chat' })).not.toBeNull();
    expect(db.insertTask({ description: 'b', source: 'chat' })).not.toBeNull();

    const updated = db.updateTask(t!.id, { status: 'done', doneAt: '2026-07-04T12:00:00Z' }, 'user');
    expect(updated.status).toBe('done');
    const history = db.taskHistory(t!.id);
    const fields = history.map((h) => h.field);
    expect(fields).toContain('status');
    expect(fields).toContain('doneAt');
    expect(history.find((h) => h.field === 'doneAt' && h.oldValue === null)?.newValue).toBe(
      '2026-07-04T12:00:00Z',
    );
  });

  it('tasks: owner column defaults to "me" and accepts an explicit "them"', () => {
    const mine = db.insertTask({ description: 'Ship the report', source: 'chat' })!;
    expect(mine.owner).toBe('me');

    const theirs = db.insertTask({ description: 'Send latency doc', source: 'slack', sourceRef: 'T-1', owner: 'them' })!;
    expect(theirs.owner).toBe('them');

    // round-trips through listTasks/getTask too, not just the insert return value
    expect(db.getTask(theirs.id)!.owner).toBe('them');
    expect(db.listTasks().find((t) => t.id === mine.id)!.owner).toBe('me');
  });

  it('loop task queries: openTasks, dueSoon, neverSurfaced, stale', () => {
    const now = '2026-07-04T12:00:00.000Z';
    const due = db.insertTask({ description: 'due tomorrow', source: 'manual', dueDate: '2026-07-05T00:00:00Z' })!;
    const far = db.insertTask({ description: 'due next month', source: 'manual', dueDate: '2026-08-04T00:00:00Z' })!;
    const fresh = db.insertTask({ description: 'fresh no due', source: 'manual' })!;

    expect(db.openTasks().length).toBe(3);

    const dueSoon = db.dueSoon(now, 2).map((t) => t.id);
    expect(dueSoon).toContain(due.id);
    expect(dueSoon).not.toContain(far.id);

    // neverSurfaced: created > 4h ago and surface_count = 0
    db.raw.prepare('UPDATE tasks SET created_at=? WHERE id=?').run('2026-07-04T01:00:00.000Z', fresh.id);
    let never = db.neverSurfaced(now, 4).map((t) => t.id);
    expect(never).toContain(fresh.id);
    db.recordSurface(fresh.id, now);
    never = db.neverSurfaced(now, 4).map((t) => t.id);
    expect(never).not.toContain(fresh.id);

    // stale: no update in 5d+
    db.raw.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run('2026-06-20T00:00:00.000Z', far.id);
    const stale = db.staleTasks(now, 5).map((t) => t.id);
    expect(stale).toEqual([far.id]);
  });

  it('unsnoozeDue reopens snoozed tasks past snooze_until', () => {
    const t = db.insertTask({ description: 'snoozed one', source: 'manual' })!;
    db.updateTask(t.id, { status: 'snoozed', snoozeUntil: '2026-07-01T00:00:00Z' }, 'user');
    const reopened = db.unsnoozeDue('2026-07-04T00:00:00Z');
    expect(reopened.map((x) => x.id)).toEqual([t.id]);
    expect(db.getTask(t.id)?.status).toBe('open');
  });

  // H3: unsnoozeDue's reopen is a one-shot status flip — snoozeExpiredTasks
  // is the durable signal candidates.ts relies on, so it must survive across
  // ticks and clear itself only once the task is actually surfaced again.
  describe('snoozeExpiredTasks', () => {
    it('flags a task reopened by unsnoozeDue and not yet surfaced', () => {
      const t = db.insertTask({ description: 'snoozed one', source: 'manual' })!;
      db.updateTask(t.id, { status: 'snoozed', snoozeUntil: '2026-07-01T00:00:00Z' }, 'user');
      db.unsnoozeDue('2026-07-04T00:00:00Z');
      expect(db.snoozeExpiredTasks().map((x) => x.id)).toEqual([t.id]);
    });

    it('does not flag a task reopened directly by a user action (changed_by != loop)', () => {
      const t = db.insertTask({ description: 'snoozed one', source: 'manual' })!;
      db.updateTask(t.id, { status: 'snoozed', snoozeUntil: '2026-07-01T00:00:00Z' }, 'user');
      // user cancels the snooze manually rather than letting it expire
      db.updateTask(t.id, { status: 'open', snoozeUntil: null }, 'user');
      expect(db.snoozeExpiredTasks()).toEqual([]);
    });

    it('clears once the task is surfaced again (recordSurface past the reopen)', () => {
      const t = db.insertTask({ description: 'snoozed one', source: 'manual' })!;
      db.updateTask(t.id, { status: 'snoozed', snoozeUntil: '2026-07-01T00:00:00Z' }, 'user');
      db.unsnoozeDue('2026-07-04T00:00:00Z');
      expect(db.snoozeExpiredTasks().map((x) => x.id)).toEqual([t.id]);

      // task_history.changed_at (written by unsnoozeDue/updateTask) is always
      // real wall-clock time regardless of the logical `now` passed in above —
      // so surface at the (later) real "now" to clear the flag, same as a real
      // tick would.
      db.recordSurface(t.id);
      expect(db.snoozeExpiredTasks()).toEqual([]);
    });

    it('does not flag a task that was never snoozed', () => {
      db.insertTask({ description: 'plain task', source: 'manual' });
      expect(db.snoozeExpiredTasks()).toEqual([]);
    });
  });

  describe('elapsedMeetingPrepTasks', () => {
    it('finds an open meeting-prep task whose meeting started >= graceMin ago', () => {
      const t = db.insertTask({
        description: 'Prep for meeting "Sync"',
        source: 'gcal',
        sourceRef: 'meeting_prep:evt-1',
        dueDate: '2026-07-04T09:00:00.000Z',
      })!;
      // 20 min past start: inside a 30-min grace, not yet elapsed
      expect(db.elapsedMeetingPrepTasks('2026-07-04T09:20:00.000Z', 30)).toEqual([]);
      // 31 min past start: elapsed
      expect(db.elapsedMeetingPrepTasks('2026-07-04T09:31:00.000Z', 30).map((x) => x.id)).toEqual([t.id]);
    });

    it('ignores non-meeting-prep tasks and already-closed prep tasks', () => {
      db.insertTask({
        description: 'unrelated due task',
        source: 'manual',
        dueDate: '2026-07-04T09:00:00.000Z',
      });
      const closed = db.insertTask({
        description: 'Prep for meeting "Old"',
        source: 'gcal',
        sourceRef: 'meeting_prep:evt-2',
        dueDate: '2026-07-04T09:00:00.000Z',
      })!;
      db.updateTask(closed.id, { status: 'cancelled' }, 'loop');
      expect(db.elapsedMeetingPrepTasks('2026-07-04T10:00:00.000Z', 30)).toEqual([]);
    });
  });

  it('raw_log dedups on (source, external_id)', () => {
    expect(db.insertRawLog({ source: 'slack', externalId: 'e1', kind: 'dm', body: '{}', occurredAt: 'x' })).not.toBeNull();
    expect(db.insertRawLog({ source: 'slack', externalId: 'e1', kind: 'dm', body: '{}', occurredAt: 'x' })).toBeNull();
  });

  it('sessions: active/seal/summaries + provider session id', () => {
    const s1 = db.createSession();
    expect(db.activeSession()?.id).toBe(s1.id);
    db.setProviderSessionId(s1.id, 'prov-1');
    expect(db.getProviderSessionId(s1.id)).toBe('prov-1');
    db.sealSession(s1.id, 'talked about PRs');
    expect(db.activeSession()).toBeUndefined();
    const s2 = db.createSession();
    db.sealSession(s2.id, 'talked about deploys');
    expect(db.recentSealedSummaries(3).map((s) => s.summary)).toEqual([
      'talked about deploys',
      'talked about PRs',
    ]);
  });

  it('settings round-trip JSON', () => {
    db.setSetting('llm.models', { chat: 'claude-opus-4-8' });
    expect(db.getSetting<{ chat: string }>('llm.models')?.chat).toBe('claude-opus-4-8');
    db.setSetting('llm.models', { chat: 'claude-sonnet-5' });
    expect(db.getSetting<{ chat: string }>('llm.models')?.chat).toBe('claude-sonnet-5');
  });

  it('proactive log: caps, gaps, expiry', () => {
    const t = db.insertTask({ description: 'nudge me', source: 'manual' })!;
    const s = db.insertProactiveLog({ taskId: t.id, surfaceKind: 'nudge', message: 'do it', score: 8 });
    expect(db.lastSurfaceAt()).toBe(s.surfacedAt);
    expect(db.surfacesForTask(t.id)).toHaveLength(1);
    expect(db.openSurfacesSince('2000-01-01')).toHaveLength(1);
    const expired = db.expireSurfacesBefore('2999-01-01');
    expect(expired).toBe(1);
    expect(db.openSurfacesSince('2000-01-01')).toHaveLength(0);
  });

  it('expireSurfacesBefore only expires ANSWERABLE surfaces, never briefings/reminders', () => {
    const t = db.insertTask({ description: 'nudge me', source: 'manual' })!;
    db.insertProactiveLog({ taskId: t.id, surfaceKind: 'nudge', message: 'do it', score: 8 });
    db.insertProactiveLog({ taskId: t.id, surfaceKind: 'meeting_prep', message: 'prep', score: 7 });
    // no buttons, never classified by the tracker — an "expired" stamp here is
    // an invented ignore signal (2026-08-21 report, LOW)
    db.insertProactiveLog({ taskId: null, surfaceKind: 'reminder', message: 'Reminder: x' });
    db.insertProactiveLog({ taskId: null, surfaceKind: 'morning_brief', message: '**Brief**' });
    db.insertProactiveLog({ taskId: null, surfaceKind: 'commitment', message: 'interview' });

    expect(db.expireSurfacesBefore('2999-01-01')).toBe(2);
    const byKind = Object.fromEntries(
      db.surfacesSince('2000-01-01').map((s) => [s.surfaceKind, s.responseType]),
    );
    expect(byKind).toEqual({
      nudge: 'expired',
      meeting_prep: 'expired',
      reminder: null,
      morning_brief: null,
      commitment: null,
    });
  });

  it('a second `done` keeps the original doneAt (no rewrite, no bogus history row)', () => {
    const t = db.insertTask({ description: 'Close the loop', source: 'manual' })!;
    db.updateTask(t.id, { status: 'done', doneAt: '2026-07-04T12:00:00Z' }, 'user');
    const after = db.updateTask(t.id, { status: 'done', doneAt: '2026-07-05T09:00:00Z' }, 'user');
    expect(after.doneAt).toBe('2026-07-04T12:00:00Z');
    expect(db.taskHistory(t.id).filter((h) => h.field === 'doneAt')).toHaveLength(1);
    // reopening and re-closing still stamps a fresh completion time
    db.updateTask(t.id, { status: 'open', doneAt: null }, 'user');
    const redone = db.updateTask(t.id, { status: 'done', doneAt: '2026-07-06T10:00:00Z' }, 'user');
    expect(redone.doneAt).toBe('2026-07-06T10:00:00Z');
  });

  it('fts: index + bm25 search + join-back timestamps', () => {
    const t1 = db.insertTask({ description: 'Deploy the payments service to production', source: 'manual' })!;
    const t2 = db.insertTask({ description: 'Write onboarding doc', source: 'manual' })!;
    db.ftsIndex('task', t1.id, t1.description);
    db.ftsIndex('task', t2.id, t2.description);
    db.ftsIndex('chat', 'turn-1', 'we talked about deploying payments');

    const hits = db.ftsSearch('payments deploy', 5);
    expect(hits.length).toBe(2);
    expect(hits.map((h) => h.refId)).toContain(t1.id);
    expect(hits.map((h) => h.refId)).toContain('turn-1');
    expect(hits.map((h) => h.refId)).not.toContain(t2.id);
    const taskHit = hits.find((h) => h.refId === t1.id)!;
    expect(taskHit.occurredAt).toBe(t1.createdAt);

    // re-index replaces, not duplicates
    db.ftsIndex('task', t1.id, 'totally different content now');
    expect(db.ftsSearch('payments', 5).map((h) => h.refId)).not.toContain(t1.id);

    // hostile query input must not throw
    expect(db.ftsSearch('"unbalanced (NEAR OR', 5)).toBeDefined();
    expect(db.ftsSearch('', 5)).toEqual([]);
  });

  it('ai_decisions round-trip with kind filter', () => {
    db.insertAiDecision({ kind: 'classification', input: { prompt: 'x' }, output: { worthExtracting: true }, model: 'claude-haiku-4-5' });
    db.insertAiDecision({ kind: 'judgment', input: { prompt: 'y' }, model: 'claude-sonnet-5', error: 'boom' });
    expect(db.listAiDecisions({ kind: 'classification' })).toHaveLength(1);
    expect(db.listAiDecisions({})).toHaveLength(2);
    const failed = db.listAiDecisions({ kind: 'judgment' })[0]!;
    expect(failed.error).toBe('boom');
    expect(failed.outputJson).toBeNull();
  });

  it('chatHistory keyset pagination with beforeId does not skip rows tied on created_at', () => {
    const session = db.createSession();
    // Three turns sharing one created_at millisecond, inserted with ids in
    // descending sort order so the DESC ordering is deterministic and known.
    const tied = ['c', 'b', 'a'];
    const sameCreatedAt = '2026-07-10T10:00:00.000Z';
    for (const id of tied) {
      db.raw
        .prepare(
          'INSERT INTO chat_turns (id, session_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, NULL, ?)',
        )
        .run(id, session.id, 'user', `turn-${id}`, sameCreatedAt);
    }

    // Page 1: only 2 of the 3 tied rows fit in the limit.
    const page1 = db.chatHistory({ limit: 2 });
    expect(page1.map((t) => t.id)).toEqual(['b', 'c']); // oldest-last reversed to oldest-first

    const boundary = page1[0]!; // 'b' — the oldest row on this page, i.e. the next cursor
    // Old behavior: created_at < boundary.createdAt alone would exclude 'a'
    // too, since it ties on the same millisecond — permanently skipping it.
    const legacyPage = db.chatHistory({ limit: 2, before: boundary.createdAt });
    expect(legacyPage.map((t) => t.id)).toEqual([]); // demonstrates the bug

    // Fixed behavior: composite (created_at, id) cursor still finds 'a'.
    const page2 = db.chatHistory({ limit: 2, before: boundary.createdAt, beforeId: boundary.id });
    expect(page2.map((t) => t.id)).toEqual(['a']);
  });

  it('listAiDecisions keyset pagination with beforeId does not skip rows tied on created_at', () => {
    const sameCreatedAt = '2026-07-10T10:00:00.000Z';
    const tied = ['c', 'b', 'a'];
    for (const id of tied) {
      db.raw
        .prepare(
          `INSERT INTO ai_decisions (id, kind, input_json, output_json, model, latency_ms, input_tokens, output_tokens, related_ref, error, created_at)
           VALUES (?, 'judgment', '{}', NULL, 'claude-sonnet-5', NULL, NULL, NULL, NULL, NULL, ?)`,
        )
        .run(id, sameCreatedAt);
    }

    const page1 = db.listAiDecisions({ limit: 2 });
    expect(page1.map((d) => d.id)).toEqual(['c', 'b']);

    const boundary = page1[1]!; // 'b' — the last row on this page, i.e. the next cursor
    const legacyPage = db.listAiDecisions({ limit: 2, before: boundary.createdAt });
    expect(legacyPage.map((d) => d.id)).toEqual([]); // demonstrates the bug

    const page2 = db.listAiDecisions({ limit: 2, before: boundary.createdAt, beforeId: boundary.id });
    expect(page2.map((d) => d.id)).toEqual(['a']);
  });

  it('calendar events upsert by external id', () => {
    db.upsertCalendarEvent({ externalId: 'ev1', title: 'Standup', startAt: '2026-07-04T13:00:00Z' });
    db.upsertCalendarEvent({ externalId: 'ev1', title: 'Standup (moved)', startAt: '2026-07-04T14:00:00Z' });
    const events = db.eventsStartingBetween('2026-07-04T00:00:00Z', '2026-07-05T00:00:00Z');
    expect(events).toHaveLength(1);
    expect(events[0]!.title).toBe('Standup (moved)');
  });

  it('interactions bump last_interaction_at', () => {
    const p = db.upsertTeamPerson({ name: 'Diego', weight: 'HIGH' });
    db.insertInteraction({ personId: p.id, source: 'slack', kind: 'dm', occurredAt: '2026-07-04T10:00:00Z' });
    expect(db.getPerson(p.id)?.lastInteractionAt).toBe('2026-07-04T10:00:00Z');
    // older interaction does not regress it
    db.insertInteraction({ personId: p.id, source: 'slack', kind: 'dm', occurredAt: '2026-07-01T10:00:00Z' });
    expect(db.getPerson(p.id)?.lastInteractionAt).toBe('2026-07-04T10:00:00Z');
  });
});

describe('migration 008 (ai_decisions cache/cost columns)', () => {
  it('applies cleanly on top of a pre-existing 007 database, leaving the old row NULL', () => {
    // Same precedent as db-fts-unindexed.test.ts's migration-003 test: build a raw DB
    // frozen at the prior version, insert a row the old way, then apply just this
    // migration and check the old row survives with the new columns NULL.
    const raw = new Database(':memory:');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    const apply = (file: string) => raw.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));

    for (const file of files.filter((f) => Number.parseInt(f, 10) < 8)) apply(file);
    raw
      .prepare(
        `INSERT INTO ai_decisions (id, kind, input_json, model, input_tokens, output_tokens, created_at)
         VALUES ('dec-1', 'chat_turn', '{}', 'claude-sonnet-5', 100, 50, '2026-07-08T00:00:00.000Z')`,
      )
      .run();

    const migration8 = files.find((f) => Number.parseInt(f, 10) === 8);
    expect(migration8).toBeDefined();
    apply(migration8!);

    const row = raw.prepare('SELECT * FROM ai_decisions WHERE id = ?').get('dec-1') as Record<string, unknown>;
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(50);
    expect(row.cache_read_input_tokens).toBeNull();
    expect(row.cache_creation_input_tokens).toBeNull();
    expect(row.total_cost_usd).toBeNull();
    raw.close();
  });

  it('is idempotent — reopening an already-migrated on-disk DB does not re-run migration 008', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-migration-008-test-'));
    const dbPath = path.join(dir, 'botty.db');

    const first = new Db(dbPath);
    first.insertAiDecision({
      kind: 'chat_turn',
      input: {},
      model: 'claude-sonnet-5',
      inputTokens: 10,
      cacheReadInputTokens: 900,
      totalCostUsd: 0.0012,
    });
    first.close();

    // Reopening runs migrate() again; version 8 is already tracked in schema_migrations
    // so it must be skipped rather than re-applied (ALTER TABLE ADD COLUMN twice errors).
    let second!: Db;
    expect(() => {
      second = new Db(dbPath);
    }).not.toThrow();
    const versions = second.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const rows = second.listAiDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cacheReadInputTokens).toBe(900);
    expect(rows[0]!.totalCostUsd).toBeCloseTo(0.0012);
    second.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
