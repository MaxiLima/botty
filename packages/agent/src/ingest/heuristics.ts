/**
 * Funnel step 3 — deterministic heuristic gate (see docs/specs/ingestion.md).
 * Conservative regexes: false positives are OK (the classifier catches them),
 * false negatives are not (nothing downstream can recover a dropped event).
 */

export type SignalKind = 'task' | 'decision' | 'commitment';

export interface HeuristicPattern {
  kind: SignalKind;
  name: string;
  regex: RegExp;
}

export const HEURISTIC_PATTERNS: HeuristicPattern[] = [
  // task signals
  { kind: 'task', name: 'can_you', regex: /\bcan you\b/i },
  { kind: 'task', name: 'please', regex: /\bplease\b/i },
  { kind: 'task', name: 'question', regex: /\?/ },
  {
    kind: 'task',
    name: 'by_weekday',
    regex: /\bby (mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  },
  { kind: 'task', name: 'blocked_on', regex: /\bblocked on\b/i },
  { kind: 'task', name: 'waiting_on', regex: /\bwaiting on\b/i },
  { kind: 'task', name: 'remind_me', regex: /\bremind me\b/i },
  { kind: 'task', name: 'follow_up', regex: /\bfollow up\b/i },
  { kind: 'task', name: 'asap', regex: /\basap\b/i },
  { kind: 'task', name: 'before_the_meeting', regex: /\bbefore the meeting\b/i },
  // decision signals
  { kind: 'decision', name: 'we_decided', regex: /\bwe decided\b/i },
  { kind: 'decision', name: 'going_with', regex: /\bgoing with\b/i },
  { kind: 'decision', name: 'agreed_to', regex: /\bagreed to\b/i },
  { kind: 'decision', name: 'approved', regex: /\bapproved\b/i },
  { kind: 'decision', name: 'signed_off', regex: /\bsigned off\b/i },
  // commitment signals
  { kind: 'commitment', name: 'ill', regex: /\bi'?ll\b/i },
  { kind: 'commitment', name: 'i_will', regex: /\bi will\b/i },
  { kind: 'commitment', name: 'on_my_list', regex: /\bon my list\b/i },
  { kind: 'commitment', name: 'i_own', regex: /\bi own\b/i },
];

/** Names of all patterns matching `text` (empty ⇒ NO_SIGNAL). */
export function matchSignals(text: string): string[] {
  return HEURISTIC_PATTERNS.filter((p) => p.regex.test(text)).map((p) => p.name);
}

export function hasSignal(text: string): boolean {
  return HEURISTIC_PATTERNS.some((p) => p.regex.test(text));
}
