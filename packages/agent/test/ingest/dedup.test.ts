import { describe, expect, it } from 'vitest';
import { Db } from '../../src/db/index.js';
import { findNearDuplicateTask } from '../../src/ingest/dedup.js';

describe('findNearDuplicateTask (ISSUE 2 — cross-source near-duplicate consolidation)', () => {
  it('matches the exact PR #482 pair from the live repro (github upsert vs slack ask)', () => {
    const db = new Db(':memory:');
    const github = db.insertTask({
      description: 'Review requested: acme-example/fraud-rules#482',
      rawText: 'Review requested: acme-example/fraud-rules#482',
      source: 'github',
      sourceRef: 'acme-example/fraud-rules#482',
    })!;

    const match = findNearDuplicateTask(db, {
      description: 'can you review the fraud-rules PR #482',
      rawText: 'can you review the fraud-rules PR #482',
      source: 'slack',
    });
    expect(match?.id).toBe(github.id);
  });

  it('does NOT merge a different PR number even with near-identical wording', () => {
    const db = new Db(':memory:');
    db.insertTask({
      description: 'Review requested: acme-example/fraud-rules#483',
      rawText: 'Review requested: acme-example/fraud-rules#483',
      source: 'github',
      sourceRef: 'acme-example/fraud-rules#483',
    });

    const match = findNearDuplicateTask(db, {
      description: 'can you review the fraud-rules PR #482',
      rawText: 'can you review the fraud-rules PR #482',
      source: 'slack',
    });
    expect(match).toBeUndefined();
  });

  it('does NOT merge two distinct asks that merely share a couple of words (no explicit id on either side)', () => {
    const db = new Db(':memory:');
    db.insertTask({
      description: 'Send latency doc',
      rawText: "I'll send you the latency doc tomorrow",
      source: 'slack',
      sourceRef: 'T-1',
    });

    const match = findNearDuplicateTask(db, {
      description: 'Provide feedback on latency doc before Wednesday refinement',
      rawText: 'quiero tu feedback antes del refinement del miércoles',
      source: 'slack', // same event, would-be second task — also must not merge
    });
    expect(match).toBeUndefined();
  });

  it('falls back to a high word-overlap bar when neither text carries an explicit id (cross-source paraphrase)', () => {
    const db = new Db(':memory:');
    const original = db.insertTask({
      description: 'Rotate the API keys before Friday',
      source: 'slack',
      sourceRef: 'T-2',
    })!;

    // near-identical restatement arriving via a different source, no numbers/ids anywhere
    const match = findNearDuplicateTask(db, {
      description: 'Please rotate the API keys before Friday',
      source: 'gmail',
    });
    expect(match?.id).toBe(original.id);
  });

  it('never matches a task from the SAME source — that is the ref-suffix mechanism\'s job, not this one', () => {
    const db = new Db(':memory:');
    const original = db.insertTask({
      description: 'Rotate the API keys before Friday',
      source: 'slack',
      sourceRef: 'T-3',
    })!;

    const match = findNearDuplicateTask(db, {
      description: 'Please rotate the API keys before Friday',
      source: 'slack', // same source as `original` — must be skipped here
    });
    expect(match).toBeUndefined();
    void original;
  });

  it('ignores closed/done tasks — only open tasks are checked', () => {
    const db = new Db(':memory:');
    const closed = db.insertTask({
      description: 'Review requested: acme-example/fraud-rules#482',
      source: 'github',
      sourceRef: 'acme-example/fraud-rules#482',
    })!;
    db.updateTask(closed.id, { status: 'done' }, 'funnel');

    const match = findNearDuplicateTask(db, {
      description: 'can you review the fraud-rules PR #482',
      source: 'slack',
    });
    expect(match).toBeUndefined();
  });
});
