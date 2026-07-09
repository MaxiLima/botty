import { beforeEach, describe, expect, it } from 'vitest';
import { Db } from '../../src/db/index.js';
import { gatherCandidates, type CandidateThresholds } from '../../src/loop/candidates.js';

/** gatherCandidates honors the configured thresholds (heartbeat.md '## Behavior')
 * instead of the hardcoded 2d / 4h / 5d it shipped with. */

const NOW = '2026-07-08T12:00:00.000Z';

const thresholds = (over: Partial<CandidateThresholds> = {}): CandidateThresholds => ({
  dueSoonDays: 2,
  neverSurfacedMinAgeHours: 4,
  staleAfterDays: 5,
  meetingPrepLeadMin: 60,
  ...over,
});

describe('gatherCandidates — configured thresholds', () => {
  let db: Db;
  beforeEach(() => {
    db = new Db(':memory:');
  });

  function insertTask(over: { dueDate?: string; createdHoursAgo?: number; updatedDaysAgo?: number; surfaced?: boolean }) {
    const task = db.insertTask({ description: 'A task', source: 'manual', dueDate: over.dueDate })!;
    const createdAt = over.createdHoursAgo
      ? new Date(Date.parse(NOW) - over.createdHoursAgo * 3_600_000).toISOString()
      : NOW;
    const updatedAt = over.updatedDaysAgo
      ? new Date(Date.parse(NOW) - over.updatedDaysAgo * 86_400_000).toISOString()
      : createdAt;
    db.raw
      .prepare('UPDATE tasks SET created_at=?, updated_at=?, surface_count=? WHERE id=?')
      .run(createdAt, updatedAt, over.surfaced ? 1 : 0, task.id);
    return task;
  }

  it('due_soon_days: a task due in 3 days is only a candidate when the window covers it', () => {
    const task = insertTask({
      dueDate: new Date(Date.parse(NOW) + 3 * 86_400_000).toISOString(),
      surfaced: true, // keep it out of NEVER_SURFACED
    });
    expect(gatherCandidates(db, NOW, thresholds({ dueSoonDays: 2 }))).toHaveLength(0);
    const found = gatherCandidates(db, NOW, thresholds({ dueSoonDays: 4 }));
    expect(found.map((c) => c.id)).toEqual([task.id]);
    expect(found[0]!.reminderReason).toBe('DUE_SOON');
  });

  it('never_surfaced_min_age_hours: a 2h-old unsurfaced task needs a lowered threshold', () => {
    const task = insertTask({ createdHoursAgo: 2 });
    expect(gatherCandidates(db, NOW, thresholds({ neverSurfacedMinAgeHours: 4 }))).toHaveLength(0);
    const found = gatherCandidates(db, NOW, thresholds({ neverSurfacedMinAgeHours: 1 }));
    expect(found.map((c) => c.id)).toEqual([task.id]);
    expect(found[0]!.reminderReason).toBe('NEVER_SURFACED');
  });

  it('stale_after_days: a task untouched for 3 days needs a lowered threshold', () => {
    const task = insertTask({ createdHoursAgo: 100, updatedDaysAgo: 3, surfaced: true });
    expect(gatherCandidates(db, NOW, thresholds({ staleAfterDays: 5 }))).toHaveLength(0);
    const found = gatherCandidates(db, NOW, thresholds({ staleAfterDays: 2 }));
    expect(found.map((c) => c.id)).toEqual([task.id]);
    expect(found[0]!.reminderReason).toBe('STALE');
  });

  it('defaults (no thresholds argument) match HEARTBEAT_DEFAULTS behavior', () => {
    insertTask({ createdHoursAgo: 5 }); // older than the default 4h ⇒ NEVER_SURFACED
    const found = gatherCandidates(db, NOW);
    expect(found).toHaveLength(1);
    expect(found[0]!.reminderReason).toBe('NEVER_SURFACED');
  });
});
