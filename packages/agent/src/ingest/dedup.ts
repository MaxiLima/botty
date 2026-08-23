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
 *
 * H4 (2026-08-21 full test run) added a second, narrower lookup for the gap
 * the same-source skip left open: `findSameThreadFollowUp` — a re-ask about
 * the SAME item in the SAME thread, worded differently, which the ref-suffix
 * mechanism happily forked into a sibling task (`T-1001#2`). See its doc
 * comment for why "same thread" alone is never enough to merge on.
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'on', 'in', 'and', 'or', 'is', 'are', 'be', 'been',
  'you', 'your', 'me', 'my', 'i', 'we', 'us', 'our', 'it', 'its',
  'can', 'could', 'would', 'should', 'will', 'shall', 'please', 'with',
  'before', 'after', 'this', 'that', 'at', 'by', 'from', 'about', 'as',
  'do', 'does', 'did', 'have', 'has', 'had', 'not', 'no', 'yes', 'so', 'up',
  // Spanish equivalents — the owner's traffic is bilingual, and a Spanish
  // follow-up scored against a Spanish original was inflating its overlap on
  // pure glue words.
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'que', 'por', 'para',
  'con', 'sin', 'se', 'su', 'sus', 'lo', 'al', 'es', 'en', 'me', 'te', 'y', 'o',
]);

/** Fold diacritics so "mañana"/"manana" and "está"/"esta" are one token. */
function foldDiacritics(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Lowercased, punctuation-stripped, stopword-filtered words — for overlap scoring. */
function significantWords(text: string): Set<string> {
  const words = foldDiacritics(text.toLowerCase())
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
 *
 * Also NOT included (2026-08-21 report, MEDIUM): a BARE single-digit `#1`…`#9`.
 * "item #2" in a checklist message is not an identifier, and treating it as
 * one false-merged it with the GitHub task `repo#2`. A single digit only
 * counts when it carries a repo/project qualifier glued to the `#`
 * (`fraud-rules#2`, `ACME/api#7`) — that is the shape structured sources
 * actually emit. Bare `#` numbers need two or more digits.
 */
function distinctiveTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  // qualified `repo#2` / `acme-example/fraud-rules#482` — any digit count.
  // The bare number is what carries across sources (a Slack "PR #482" has no
  // repo), so the qualifier is only used as proof this `#n` is an identifier.
  for (const m of text.matchAll(/[A-Za-z][\w./-]*#(\d{1,6})\b/g)) tokens.add(m[1]!);
  // bare `#482` — needs ≥2 digits to count as an identifier at all.
  for (const m of text.matchAll(/(?<![\w./-])#(\d{2,6})\b/g)) tokens.add(m[1]!);
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
/**
 * Word-overlap floor for a same-thread follow-up with no explicit id on
 * either side. Slightly below the cross-source bar (the shared thread is real
 * corroborating evidence) but still steep, because in the sim/slack channel
 * shape `threadRef` is the CHANNEL id — every ask in a busy channel shares a
 * "thread", so thread membership on its own must never merge anything.
 */
const SAME_THREAD_WORD_MIN_JACCARD = 0.5;

export interface DedupCandidate {
  description: string;
  rawText?: string | null;
  /**
   * Source of the event producing this candidate. Open tasks from the SAME
   * source are skipped — same-source dedup is the job of the `UNIQUE(source,
   * source_ref)` ref-suffix mechanism in funnel.ts plus `findSameThreadFollowUp`
   * below. This function exists for the gap those leave: the same real-world
   * ask arriving via a DIFFERENT source.
   */
  source: string;
}

/** How a candidate text scored against one open task's text. */
interface PairScore {
  overlap: number;
  /** Both sides carry at least one explicit identifier. */
  bothIdentified: boolean;
  /** ...and at least one identifier is shared. */
  idsAgree: boolean;
}

function scorePair(
  candidate: { words: Set<string>; tokens: Set<string> },
  task: { words: Set<string>; tokens: Set<string> },
): PairScore {
  const bothIdentified = candidate.tokens.size > 0 && task.tokens.size > 0;
  return {
    overlap: jaccard(candidate.words, task.words),
    bothIdentified,
    idsAgree: bothIdentified && hasSharedToken(candidate.tokens, task.tokens),
  };
}

/**
 * Shared verdict for both lookups. Two texts that each carry an identifier and
 * DISAGREE are never a match, no matter the wording — different items.
 */
function isMatch(score: PairScore, distinctiveFloor: number, wordFloor: number): boolean {
  if (score.bothIdentified) return score.idsAgree && score.overlap >= distinctiveFloor;
  return score.overlap >= wordFloor;
}

/**
 * Look for an already-open task that's really the same real-world ask as
 * `candidate`. Returns the matching task on a confident hit, `undefined`
 * otherwise. Read-only — never mutates anything; the caller decides what to
 * do with a match (funnel.ts: merge the new evidence into the existing task
 * instead of creating a second one — see util.ts mergeTaskEvidence).
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
    if (task.source === candidate.source) continue; // same-source: see findSameThreadFollowUp
    const taskText = `${task.description} ${task.rawText ?? ''}`;
    const score = scorePair(
      { words: candidateWords, tokens: candidateTokens },
      { words: significantWords(taskText), tokens: distinctiveTokens(taskText) },
    );
    if (isMatch(score, DISTINCTIVE_MATCH_MIN_JACCARD, WORD_ONLY_MIN_JACCARD)) return task;
  }
  return undefined;
}

export interface ThreadFollowUpCandidate extends DedupCandidate {
  /**
   * `threadRef ?? externalId` of the incoming event — the base every task
   * source_ref in this thread is built from (`base`, `base#2`, `base#3`…).
   */
  threadBase: string;
  /**
   * Owner of the incoming candidate. Only tasks with the SAME owner are
   * considered: "Send latency doc" (owner 'them' — Diego's promise, something
   * the user waits on) and "Send the latency doc" (owner 'me' — an ask of the
   * user) are near-identical in words and opposite in meaning; merging them is
   * the ISSUE-1 inversion bug wearing a different hat. Omit to skip the check.
   */
  owner?: string;
  /**
   * Tasks this same message already created. A bump is by definition a LATER
   * message re-asking about an item the thread already carries; two items the
   * extractor split out of ONE message are siblings, never a follow-up of each
   * other, however similar their wording or equal their owner. Structural
   * guard — it does not depend on the similarity floors holding.
   */
  excludeTaskIds?: ReadonlySet<string>;
}

/**
 * H4a — same-thread follow-up. A nag or status chase about an item the thread
 * already produced an open task for ("asap: el release está frenado por el PR
 * #482 — ¿estado?") is NOT a new ask; before this it forked a sibling task
 * (`T-1001#2`) because the ref-suffix mechanism only recognizes a byte-identical
 * re-send and cross-source dedup deliberately skips same-source tasks.
 *
 * Deliberately NOT "any open task in this thread": in the slack/sim channel
 * shape `threadRef` is the CHANNEL id, so a long-running channel legitimately
 * carries many distinct asks. Thread membership only narrows WHICH tasks are
 * considered; the same similarity signal cross-source dedup uses still has to
 * confirm it, at the SAME id-agreement bar and a barely lower word-only one
 * (SAME_THREAD_WORD_MIN_JACCARD).
 *
 * One difference from the cross-source scorer: word overlap is measured on the
 * DESCRIPTIONS alone, not description+rawText. Inside one thread the raw
 * messages are about one topic by construction — and two tasks extracted from
 * a SINGLE message share their rawText verbatim, which pins overlap near 1.0
 * for a pair the extractor deliberately split ("Send latency doc" vs "Provide
 * feedback on latency doc"). The description is the extractor's distillation of
 * the actual ask, so it's the honest thing to compare. Identifiers still come
 * from the full text, where a PR number survives even if the description drops
 * it.
 *
 * Read-only. Returns the open task to bump, or undefined for a genuinely new
 * ask that should get its own slot.
 */
export function findSameThreadFollowUp(
  db: Db,
  candidate: ThreadFollowUpCandidate,
): Task | undefined {
  const candidateTokens = distinctiveTokens(`${candidate.description} ${candidate.rawText ?? ''}`);
  const candidateWords = significantWords(candidate.description);
  if (candidateWords.size === 0) return undefined;

  for (const task of db.openTasks()) {
    if (task.source !== candidate.source) continue; // cross-source is findNearDuplicateTask's job
    if (candidate.excludeTaskIds?.has(task.id)) continue; // sibling from THIS message, not a follow-up
    if (!inThread(task.sourceRef, candidate.threadBase)) continue;
    if (candidate.owner !== undefined && task.owner !== candidate.owner) continue;
    const score = scorePair(
      { words: candidateWords, tokens: candidateTokens },
      {
        words: significantWords(task.description),
        tokens: distinctiveTokens(`${task.description} ${task.rawText ?? ''}`),
      },
    );
    if (isMatch(score, DISTINCTIVE_MATCH_MIN_JACCARD, SAME_THREAD_WORD_MIN_JACCARD)) {
      return task;
    }
  }
  return undefined;
}

/** `base`, `base#2`, `base#3`… all belong to the thread keyed by `base`. */
function inThread(sourceRef: string | null, threadBase: string): boolean {
  if (!sourceRef) return false;
  return sourceRef === threadBase || sourceRef.startsWith(`${threadBase}#`);
}
