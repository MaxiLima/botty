import { describe, expect, it } from 'vitest';
import { HEURISTIC_PATTERNS, hasSignal, matchSignals } from '../../src/ingest/heuristics.js';

describe('heuristics', () => {
  const cases: { text: string; expected: boolean; signal?: string }[] = [
    // task signals
    { text: 'Can you review the fraud-rules PR before EOD', expected: true, signal: 'can_you' },
    { text: 'Please take a look at the dashboard', expected: true, signal: 'please' },
    { text: 'did the deploy finish?', expected: true, signal: 'question' },
    { text: 'need the numbers by friday', expected: true, signal: 'by_weekday' },
    { text: 'need the numbers by Wed', expected: true, signal: 'by_weekday' },
    { text: "we're blocked on the schema migration", expected: true, signal: 'blocked_on' },
    { text: 'still waiting on legal for the contract', expected: true, signal: 'waiting_on' },
    { text: 'remind me to rotate the keys', expected: true, signal: 'remind_me' },
    { text: 'we should follow up with the vendor', expected: true, signal: 'follow_up' },
    { text: 'need this ASAP', expected: true, signal: 'asap' },
    { text: 'send the deck before the meeting', expected: true, signal: 'before_the_meeting' },
    // decision signals
    { text: 'we decided to keep the monolith', expected: true, signal: 'we_decided' },
    { text: 'going with option B for the rollout', expected: true, signal: 'going_with' },
    { text: 'they agreed to the new SLA', expected: true, signal: 'agreed_to' },
    { text: 'budget approved for Q3', expected: true, signal: 'approved' },
    { text: 'security signed off on the design', expected: true, signal: 'signed_off' },
    // commitment signals
    { text: "I'll send the doc tomorrow", expected: true, signal: 'ill' },
    { text: 'Ill send the doc tomorrow', expected: true, signal: 'ill' },
    { text: 'i will own the migration', expected: true, signal: 'i_will' },
    { text: 'it is on my list for this sprint', expected: true, signal: 'on_my_list' },
    { text: 'that part I own end to end', expected: true, signal: 'i_own' },
    // typographic apostrophe (2026-08-21 report): every phone keyboard, Slack
    // and Gmail produce U+2019, which used to defeat \bi'?ll\b → NO_SIGNAL
    { text: 'I’ll send the doc tomorrow', expected: true, signal: 'ill' },
    { text: 'I’ll own the migration', expected: true, signal: 'ill' },
    // English signals the gate was missing
    { text: 'could you take a look at the dashboard', expected: true, signal: 'could_you' },
    { text: 'would you mind checking the numbers', expected: true, signal: 'could_you' },
    { text: 'need the deck by EOD', expected: true, signal: 'eod' },
    { text: 'pls ship the report', expected: true, signal: 'pls' },
    { text: 'the deadline moved to next week', expected: true, signal: 'deadline' },
    // Spanish — the owner's traffic is bilingual; these used to score NO_SIGNAL
    { text: 'necesito el reporte de chargebacks', expected: true, signal: 'necesito' },
    { text: 'podés pasarme el link del dashboard', expected: true, signal: 'podes' },
    { text: '¿podrías revisar el PR', expected: true, signal: 'podes' },
    { text: 'lo necesito antes del viernes', expected: true, signal: 'antes_del' },
    { text: 'mandame el deck antes de la reunión', expected: true, signal: 'antes_del' },
    { text: 'entregalo antes de las 15:00', expected: true, signal: 'antes_del' },
    { text: 'dejalo listo para mañana', expected: true, signal: 'para_manana' },
    { text: 'te lo mando esta tarde', expected: true, signal: 'te_lo_mando' },
    { text: 'me encargo del rollback', expected: true, signal: 'me_encargo' },
    { text: 'quedamos en usar la opción B', expected: true, signal: 'decidimos' },
    // an opening '¿' alone (no closing mark) still reads as a question
    { text: '¿ves el deploy', expected: true, signal: 'question' },
    // no signal — social noise / FYI
    { text: 'jaja buenísimo', expected: false },
    { text: 'thanks!', expected: false },
    { text: 'good morning team', expected: false },
    { text: 'nice work on the launch', expected: false },
    { text: 'fyi the office is closed monday', expected: false },
    { text: '', expected: false },
    // near-misses that must NOT fire
    { text: 'the bypass valve is fine', expected: false }, // "by" inside a word, no weekday
    { text: 'standby mondays are odd', expected: false }, // weekday without a "by " prefix pair
    { text: 'buen finde a todos', expected: false }, // Spanish social noise
    { text: 'el deploy salió perfecto', expected: false }, // Spanish FYI, no ask
    { text: 'seeds and podcasts', expected: false }, // "pod"/"pls" near-misses inside words
    // A bare "antes de <noun>" is NOT a deadline signal: it is one of the most
    // common phrases in Spanish, and it reads as an ask even inside a promise
    // ("te lo mando antes del refinement"), which inverts owner inference.
    // Like `by_weekday`, it only fires when an actual time follows.
    { text: 'antes de que te vayas, buen finde', expected: false },
    { text: 'lo vemos antes del refinement', expected: false },
  ];

  it.each(cases)('"$text" → $expected', ({ text, expected, signal }) => {
    expect(hasSignal(text)).toBe(expected);
    const matched = matchSignals(text);
    if (expected && signal) expect(matched).toContain(signal);
    if (!expected) expect(matched).toEqual([]);
  });


  // The e2e funnel step (scripts/e2e/run.ts) reads owner inference off this
  // SIGNALS line: under the mock, a message whose signals are ALL commitment
  // signals is the sender's own promise (owner 'them'). A deadline phrase that
  // fires on the promise half of a bilingual message flips that to 'me' — the
  // exact ISSUE-1 inversion. Pin the live scenario message.
  it("Diego's bilingual promise carries only its commitment signal", () => {
    const text =
      "I'll send you the latency doc tomorrow — quiero tu feedback antes del refinement del miércoles.";
    expect(matchSignals(text)).toEqual(['ill']);
  });

  it('pattern names are unique', () => {
    const names = HEURISTIC_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('matchSignals returns every matching pattern', () => {
    const matched = matchSignals("can you follow up ASAP? I'll ping legal too");
    expect(matched).toEqual(expect.arrayContaining(['can_you', 'follow_up', 'asap', 'question', 'ill']));
  });
});
