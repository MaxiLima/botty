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
  ];

  it.each(cases)('"$text" → $expected', ({ text, expected, signal }) => {
    expect(hasSignal(text)).toBe(expected);
    const matched = matchSignals(text);
    if (expected && signal) expect(matched).toContain(signal);
    if (!expected) expect(matched).toEqual([]);
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
