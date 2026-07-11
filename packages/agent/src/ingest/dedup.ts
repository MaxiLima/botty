import type { Task } from '@botty/shared';
import type { Db } from '../db/index.js';

/**
 * Cross-source near-duplicate detection (BACKLOG "Near-duplicate task
 * consolidation", ISSUE 2 in the 2026-07-09 live-testing sweep): the same
 * real-world ask arriving via two sources — a Slack "can you review PR #482"
 * DM and a GitHub "review requested #482" webhook — must not become two open
 * tasks. Same-source dedup is already handled by the `UNIQUE(source,
 * source_ref)` constraint (see funnel.ts's ref-suffix loop); this is the
 * cross-source fallback, checked against OPEN tasks only, with no extra LLM
 * call — cheap token heuristics, deliberately tuned conservative: a missed
 * dedup (a dupe survives) is much cheaper than a false merge (a distinct ask
 * silently disappears into an unrelated task).
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'on', 'in', 'and', 'or', 'is', 'are', 'be', 'been',
  'you', 'your', 'me', 'my', 'i', 'we', 'us', 'our', 'it', 'its',
  'can', 'could', 'would', 'should', 'will', 'shall', 'please', 'with',
  'before', 'after', 'this', 'that', 'at', 'by', 'from', 'about', 'as',
  'do', 'does', 'did', 'have', 'has', 'had', 'not', 'no', 'yes', 'so', 'up',
]);

/** Lowercased, punctuation-stripped, stopword-filtered words — for overlap scoring. */
function significantWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return new Set(words);
}

/**
 * Explicit identifiers worth trusting: PR/issue numbers (`#482`), jira-style
 * keys (`ACME-123`), and URLs. Extracted from the ORIGINAL (unstripped) text
 * so `#`/hyphen punctuation survives.
 *
 * Deliberately NOT included: bare 3-6 digit numbers. A year ("2026") or a
 * time extracted from a date reads as a "distinctive" token just as readily
 * as a real PR number, which drops the confirm bar from the strict
 * WORD_ONLY_MIN_JACCARD floor to the much looser DISTINCTIVE_MATCH_MIN_JACCARD
 * one for two texts that otherwise share almost nothing — silently merging
 * two different Tier-1 asks. Only identifiers with enough structure to be
 * unambiguous (`#`, a letter-prefixed key, a URL) count as distinctive.
 */
function distinctiveTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.matchAll(/#(\d{1,6})\b/g)) tokens.add(m[1]!);
  for (const m of text.matchAll(/\b[A-Z]{2,10}-\d+\b/g)) tokens.add(m[0].toUpperCase());
  for (const m of text.matchAll(/https?:\/\/\S+/g)) tokens.add(m[0]);
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function hasSharedToken(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (b.has(t)) return true;
  return false;
}

/** Word-overlap floor when NEITHER text carries an explicit identifier. */
const WORD_ONLY_MIN_JACCARD = 0.6;
/** Word-overlap floor when both texts share an explicit identifier (already strong signal). */
const DISTINCTIVE_MATCH_MIN_JACCARD = 0.15;

export interface DedupCandidate {
  description: string;
  rawText?: string | null;
  /**
   * Source of the event producing this candidate. Open tasks from the SAME
   * source are skipped — same-source dedup is already the job of the
   * `UNIQUE(source, source_ref)` ref-suffix mechanism in funnel.ts (an
   * identical in-thread re-send resolves there, keeping the original task and
   * the `EXTRACTED` outcome). This function exists for the gap that leaves:
   * the same real-world ask arriving via a DIFFERENT source.
   */
  source: string;
}

/**
 * Look for an already-open task that's really the same real-world ask as
 * `candidate`. Returns the matching task on a confident hit, `undefined`
 * otherwise. Read-only — never mutates anything; the caller decides what to
 * do with a match (funnel.ts: skip creating a second task).
 *
 * Matching rule (conservative by design):
 * - If both texts carry an explicit identifier (PR/issue number, jira key,
 *   URL) that DISAGREES (e.g. #482 vs #483), it's never a match — no matter
 *   how similar the wording, those are different items.
 * - If both carry an identifier that agrees, a modest word-overlap floor
 *   confirms it's about the same thing (guards against two unrelated asks
 *   that happen to share an unrelated 3-digit number).
 * - If neither carries an identifier, fall back to a high word-overlap floor
 *   only — this is the "same words, different task" trap (e.g. "Send the
 *   latency doc" vs "Provide feedback on the latency doc"), so the bar is
 *   deliberately steep.
 */
export function findNearDuplicateTask(db: Db, candidate: DedupCandidate): Task | undefined {
  const candidateText = `${candidate.description} ${candidate.rawText ?? ''}`;
  const candidateTokens = distinctiveTokens(candidateText);
  const candidateWords = significantWords(candidateText);
  if (candidateWords.size === 0) return undefined;

  for (const task of db.openTasks()) {
    if (task.source === candidate.source) continue; // same-source dedup is the ref-suffix mechanism's job
    const taskText = `${task.description} ${task.rawText ?? ''}`;
    const taskTokens = distinctiveTokens(taskText);
    const overlap = jaccard(candidateWords, significantWords(taskText));

    if (candidateTokens.size > 0 && taskTokens.size > 0) {
      if (!hasSharedToken(candidateTokens, taskTokens)) continue; // ids disagree — never a match
      if (overlap >= DISTINCTIVE_MATCH_MIN_JACCARD) return task;
      continue;
    }
    if (overlap >= WORD_ONLY_MIN_JACCARD) return task;
  }
  return undefined;
}
