import { describe, expect, it } from 'vitest';
import { Db } from '../../src/db/index.js';
import { findNearDuplicateTask, findSameThreadFollowUp } from '../../src/ingest/dedup.js';

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

  it('does NOT treat a shared bare year as a distinctive identifier (two different Tier-1 asks, ~0.2 word overlap)', () => {
    const db = new Db(':memory:');
    db.insertTask({
      description: 'Renew the lease in 2026',
      rawText: 'Renew the lease in 2026',
      source: 'gmail',
      sourceRef: 'G-1',
    });

    // Shares only the bare number "2026" (a year, not an identifier) and
    // nothing else — word overlap is well below the strict word-only floor
    // (0.6). Before the fix, the shared "2026" was treated as a distinctive
    // token, which dropped the confirm bar to 0.15 and wrongly deduped two
    // completely unrelated asks.
    const match = findNearDuplicateTask(db, {
      description: 'Book the flights for 2026',
      rawText: 'Book the flights for 2026',
      source: 'slack',
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

  // The suite claimed a word-overlap floor guarded the shared-id path but never
  // exercised it (2026-08-21 report, §6 test gaps): every id-agreeing pair in
  // it also had heavy word overlap, so the floor could have been 0 and the
  // tests would still pass.
  it('enforces the word-overlap floor even when an explicit id AGREES (shared #482, unrelated asks)', () => {
    const db = new Db(':memory:');
    db.insertTask({
      description: 'Review requested: acme-example/fraud-rules#482',
      rawText: 'Review requested: acme-example/fraud-rules#482',
      source: 'github',
      sourceRef: 'acme-example/fraud-rules#482',
    });

    // Same number, nothing else in common (~0.08 overlap, floor is 0.15).
    expect(
      findNearDuplicateTask(db, {
        description: 'Order new laptops for the design team, budget code #482',
        rawText: 'Order new laptops for the design team, budget code #482',
        source: 'slack',
      }),
    ).toBeUndefined();

    // Control: the SAME shared id clears the bar once the wording agrees too,
    // proving the id path itself still works and the floor is what rejected above.
    expect(
      findNearDuplicateTask(db, {
        description: 'review the fraud-rules PR #482',
        rawText: 'review the fraud-rules PR #482',
        source: 'slack',
      }),
    ).toBeDefined();
  });

  it('does NOT treat a bare single-digit "#2" as an identifier (item #2 vs repo#2)', () => {
    const db = new Db(':memory:');
    db.insertTask({
      description: 'Review requested: acme-example/fraud-rules#2',
      rawText: 'Review requested: acme-example/fraud-rules#2',
      source: 'github',
      sourceRef: 'acme-example/fraud-rules#2',
    });

    // "item #2" is a list position, not an id. Before the fix it counted as
    // distinctive, dropping the bar to 0.15 and merging two unrelated asks.
    expect(
      findNearDuplicateTask(db, {
        description: 'Send me the onboarding checklist, item #2 is still blank',
        rawText: 'Send me the onboarding checklist, item #2 is still blank',
        source: 'slack',
      }),
    ).toBeUndefined();

    // A QUALIFIED single digit (`fraud-rules#2`) is still an identifier.
    expect(
      findNearDuplicateTask(db, {
        description: 'review fraud-rules#2 please',
        rawText: 'review fraud-rules#2 please',
        source: 'slack',
      }),
    ).toBeDefined();
  });
});

describe('findSameThreadFollowUp (H4a — a re-ask in the thread must not fork a sibling task)', () => {
  /** Seed the open task the thread already produced. */
  function seed(db: Db, description: string, sourceRef = 'T-1001') {
    return db.insertTask({ description, rawText: description, source: 'slack', sourceRef })!;
  }

  it('matches the live repro: a differently-worded nag about the same PR in the same thread', () => {
    const db = new Db(':memory:');
    const original = seed(db, 'Can you review the fraud-rules PR #482 before EOD');

    const match = findSameThreadFollowUp(db, {
      description: 'asap: el release está frenado por el PR #482 — ¿estado?',
      rawText: 'asap: el release está frenado por el PR #482 — ¿estado?',
      source: 'slack',
      threadBase: 'T-1001',
    });
    expect(match?.id).toBe(original.id);
  });

  it('matches an identical re-send (the repeated nag the ref-suffix loop used to absorb)', () => {
    const db = new Db(':memory:');
    const original = seed(db, 'can you check the deploy?');

    const match = findSameThreadFollowUp(db, {
      description: 'can you check the deploy?',
      rawText: 'can you check the deploy?',
      source: 'slack',
      threadBase: 'T-1001',
    });
    expect(match?.id).toBe(original.id);
  });

  it('does NOT merge two genuinely distinct asks in the same channel thread', () => {
    const db = new Db(':memory:');
    // In sim/slack, threadRef IS the channel id — a busy channel carries many
    // unrelated asks, so thread membership alone must never merge.
    seed(db, 'can you check the deploy?', 'C-fraud');

    const match = findSameThreadFollowUp(db, {
      description: 'can you rotate the API keys please?',
      rawText: 'can you rotate the API keys please?',
      source: 'slack',
      threadBase: 'C-fraud',
    });
    expect(match).toBeUndefined();
  });

  it('does NOT merge a same-message split pair ("Send latency doc" vs "Provide feedback on latency doc")', () => {
    const db = new Db(':memory:');
    const rawText = "I'll send you the latency doc tomorrow — quiero tu feedback antes del refinement";
    db.insertTask({
      description: 'Provide feedback on latency doc before Wednesday refinement',
      rawText,
      source: 'slack',
      sourceRef: 'T-DOC',
    });

    // Two tasks the extractor split out of ONE message share their rawText
    // verbatim — scoring on descriptions is what keeps them apart.
    const match = findSameThreadFollowUp(db, {
      description: 'Send latency doc',
      rawText,
      source: 'slack',
      threadBase: 'T-DOC',
    });
    expect(match).toBeUndefined();
  });

  it('does NOT reach outside the thread, and never merges a DIFFERENT PR number', () => {
    const db = new Db(':memory:');
    seed(db, 'Can you review the fraud-rules PR #482 before EOD', 'T-OTHER');
    seed(db, 'Can you review the fraud-rules PR #483 before EOD', 'T-1001');

    // same wording, other thread → not a follow-up here
    expect(
      findSameThreadFollowUp(db, {
        description: 'Can you review the fraud-rules PR #482 before EOD',
        source: 'slack',
        threadBase: 'T-1001',
      }),
    ).toBeUndefined();
  });

  it('matches suffixed slots in the thread (base#2), not just the base ref', () => {
    const db = new Db(':memory:');
    seed(db, 'can you check the deploy?', 'C-fraud');
    const second = seed(db, 'can you rotate the API keys please?', 'C-fraud#2');

    const match = findSameThreadFollowUp(db, {
      description: 'can you rotate the API keys?',
      rawText: 'can you rotate the API keys? still pending',
      source: 'slack',
      threadBase: 'C-fraud',
    });
    expect(match?.id).toBe(second.id);
  });

  it('never bumps across owners — "Send latency doc" (them) vs an ask of the user (me)', () => {
    const db = new Db(':memory:');
    const promise = db.insertTask({
      description: 'Send latency doc',
      rawText: "I'll send you the latency doc tomorrow",
      source: 'slack',
      sourceRef: 'T-DOC',
      owner: 'them',
    })!;

    // Same words, opposite meaning: this one is on the USER's plate.
    expect(
      findSameThreadFollowUp(db, {
        description: 'Send latency doc',
        rawText: 'can you send the latency doc?',
        source: 'slack',
        threadBase: 'T-DOC',
        owner: 'me',
      }),
    ).toBeUndefined();

    // ...and the same-owner follow-up still bumps.
    expect(
      findSameThreadFollowUp(db, {
        description: 'Send latency doc',
        rawText: 'still sending the latency doc, sorry for the delay',
        source: 'slack',
        threadBase: 'T-DOC',
        owner: 'them',
      })?.id,
    ).toBe(promise.id);
  });

  it('never bumps a sibling created by the SAME message, however similar the wording', () => {
    const db = new Db(':memory:');
    // Structural guard, independent of owner and of the similarity floors: a
    // bump is a LATER message re-asking; two items split out of one message
    // are siblings and must each keep their own slot.
    const sibling = db.insertTask({
      description: 'Review the fraud-rules PR #482',
      rawText: 'Review the fraud-rules PR #482 and then merge it',
      source: 'slack',
      sourceRef: 'T-1001',
    })!;

    expect(
      findSameThreadFollowUp(db, {
        description: 'Review the fraud-rules PR #482',
        rawText: 'Review the fraud-rules PR #482 and then merge it',
        source: 'slack',
        threadBase: 'T-1001',
        excludeTaskIds: new Set([sibling.id]),
      }),
    ).toBeUndefined();

    // ...the identical lookup WITHOUT the exclusion is a match, proving the
    // exclusion is what rejected it.
    expect(
      findSameThreadFollowUp(db, {
        description: 'Review the fraud-rules PR #482',
        rawText: 'Review the fraud-rules PR #482 and then merge it',
        source: 'slack',
        threadBase: 'T-1001',
      })?.id,
    ).toBe(sibling.id);
  });

  it('ignores tasks from another source in the same thread (that is findNearDuplicateTask\'s job)', () => {
    const db = new Db(':memory:');
    db.insertTask({
      description: 'can you check the deploy?',
      rawText: 'can you check the deploy?',
      source: 'gmail',
      sourceRef: 'T-1001',
    });

    const match = findSameThreadFollowUp(db, {
      description: 'can you check the deploy?',
      source: 'slack',
      threadBase: 'T-1001',
    });
    expect(match).toBeUndefined();
  });
});
