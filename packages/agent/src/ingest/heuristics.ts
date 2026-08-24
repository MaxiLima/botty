/**
 * Funnel step 3 — deterministic heuristic gate (see docs/specs/ingestion.md).
 * Conservative regexes: false positives are OK (the classifier catches them),
 * false negatives are not (nothing downstream can recover a dropped event).
 *
 * Bilingual by design (2026-08-21 report, MEDIUM "Ingestion"): the owner's
 * traffic is English + Spanish, and an English-only pattern set silently
 * dropped Tier-1 asks ("necesito el reporte antes del viernes") at the gate,
 * before any LLM could see them.
 */

export type SignalKind = 'task' | 'decision' | 'commitment';

export interface HeuristicPattern {
  kind: SignalKind;
  name: string;
  regex: RegExp;
}

/**
 * Normalize before matching: typographic apostrophes/quotes (what every phone
 * keyboard, Slack and Gmail actually produce) used to defeat `\bi'?ll\b`, so
 * "I’ll send it tomorrow" scored NO_SIGNAL and never reached the classifier.
 * NBSP is folded to a plain space for the same reason (`\bby friday\b`).
 */
export function normalizeForMatching(text: string): string {
  return text
    .replace(/[\u2018\u2019\u02bc\u02b9\u2032]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u00a0\u202f\u2007]/g, ' ');
}

export const HEURISTIC_PATTERNS: HeuristicPattern[] = [
  // task signals (English)
  { kind: 'task', name: 'can_you', regex: /\bcan you\b/i },
  { kind: 'task', name: 'could_you', regex: /\b(could|would) you\b/i },
  { kind: 'task', name: 'please', regex: /\bplease\b/i },
  { kind: 'task', name: 'pls', regex: /\bpl[sz]\b/i },
  // '¿' as well as '?': a Spanish question often opens with it and, in chat,
  // sometimes carries only the opening mark.
  { kind: 'task', name: 'question', regex: /[?¿]/ },
  {
    kind: 'task',
    name: 'by_weekday',
    regex: /\bby (mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  },
  { kind: 'task', name: 'eod', regex: /\b(eod|eow|cob)\b/i },
  { kind: 'task', name: 'deadline', regex: /\bdead-?line\b/i },
  { kind: 'task', name: 'blocked_on', regex: /\bblocked on\b/i },
  { kind: 'task', name: 'waiting_on', regex: /\bwaiting on\b/i },
  { kind: 'task', name: 'remind_me', regex: /\bremind me\b/i },
  { kind: 'task', name: 'follow_up', regex: /\bfollow up\b/i },
  { kind: 'task', name: 'asap', regex: /\basap\b/i },
  { kind: 'task', name: 'before_the_meeting', regex: /\bbefore the meeting\b/i },
  // task signals (Spanish)
  { kind: 'task', name: 'necesito', regex: /\bnecesit(o|amos|aria|aría)\b/i },
  { kind: 'task', name: 'podes', regex: /\bpod(es|és|r[ií]a(s|mos)?)\b/i },
  { kind: 'task', name: 'puedes', regex: /\bpued(es|e|en)\b/i },
  { kind: 'task', name: 'me_pasas', regex: /\b(me pas(as|arias|arías)|me mandas|me envias|me envías)\b/i },
  // Deadline marker, mirroring `by_weekday`: bare "by" is never a signal and
  // neither is bare "antes de" — it is one of the most common phrases in
  // Spanish ("antes de nada", "antes de que te vayas") and, worse, it reads as
  // an ASK when it is really part of a promise ("te lo mando antes del
  // viernes"), which inverts owner inference downstream. It only counts when
  // it names an actual time: a weekday, mañana/hoy, a clock time, a date, EOD,
  // or the meeting it is anchored to.
  {
    kind: 'task',
    name: 'antes_del',
    regex:
      /\bantes de(?:l)?\s+(?:la\s+|las\s+|el\s+|los\s+)?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|ma[ñn]ana|hoy|mediod[ií]a|almuerzo|fin de (?:semana|mes|d[ií]a)|eod|\d{1,2}([:.]\d{2})?\b|reuni[oó]n|meeting|standup|daily|demo|review|llamada|call)/i,
  },
  { kind: 'task', name: 'para_manana', regex: /\bpara (mañana|manana|hoy|el (lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo))\b/i },
  { kind: 'task', name: 'urgente', regex: /\burgent[e]?\b/i },
  { kind: 'task', name: 'recordame', regex: /\brecord(a|á)me\b/i },
  { kind: 'task', name: 'pendiente', regex: /\bpendiente\b/i },
  // decision signals
  { kind: 'decision', name: 'we_decided', regex: /\bwe decided\b/i },
  { kind: 'decision', name: 'going_with', regex: /\bgoing with\b/i },
  { kind: 'decision', name: 'agreed_to', regex: /\bagreed to\b/i },
  { kind: 'decision', name: 'approved', regex: /\bapproved\b/i },
  { kind: 'decision', name: 'signed_off', regex: /\bsigned off\b/i },
  { kind: 'decision', name: 'decidimos', regex: /\b(decidimos|acordamos|quedamos en)\b/i },
  { kind: 'decision', name: 'aprobado', regex: /\baprobad[oa]s?\b/i },
  // commitment signals
  { kind: 'commitment', name: 'ill', regex: /\bi'?ll\b/i },
  { kind: 'commitment', name: 'i_will', regex: /\bi will\b/i },
  { kind: 'commitment', name: 'on_my_list', regex: /\bon my list\b/i },
  { kind: 'commitment', name: 'i_own', regex: /\bi own\b/i },
  { kind: 'commitment', name: 'me_encargo', regex: /\b(me encargo|lo hago yo|me ocupo)\b/i },
  { kind: 'commitment', name: 'te_lo_mando', regex: /\bte (lo |la |los |las )?(mando|env[íi]o|paso|comparto)\b/i },
  { kind: 'commitment', name: 'voy_a', regex: /\bvoy a\b/i },
];

/** Names of all patterns matching `text` (empty ⇒ NO_SIGNAL). */
export function matchSignals(text: string): string[] {
  const normalized = normalizeForMatching(text);
  return HEURISTIC_PATTERNS.filter((p) => p.regex.test(normalized)).map((p) => p.name);
}

export function hasSignal(text: string): boolean {
  const normalized = normalizeForMatching(text);
  return HEURISTIC_PATTERNS.some((p) => p.regex.test(normalized));
}
