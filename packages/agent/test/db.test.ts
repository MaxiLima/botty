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
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3, 4, 5, 6]);
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
