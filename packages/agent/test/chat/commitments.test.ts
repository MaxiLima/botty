import { describe, expect, it } from 'vitest';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { createChat } from '../../src/chat/index.js';
import {
  buildCommitmentPrompt,
  COMMITMENT_SYSTEM_MARKER,
  extractCommitments,
  hasCommitmentSignal,
  resolveDueAt,
} from '../../src/chat/commitments.js';
import { parseHeartbeat } from '../../src/config/parse.js';
import { createLlm } from '../../src/llm/index.js';
import type { LlmClient } from '../../src/llm/types.js';
import { createMemory } from '../../src/memory/index.js';

/**
 * Inferred commitments (feature #2) — extraction pass. Deterministic mock
 * convention: `[[commitment: <description> | <ISO due date>]]` inline in the
 * user text (see llm/mock.ts) — the common case (no marker) yields nothing.
 */

async function mockLlm() {
  const db = new Db(':memory:');
  const bus = createBus();
  const llm = await createLlm({ env: { mockLlm: true }, db, bus });
  return { db, llm };
}

describe('hasCommitmentSignal — cheap heuristic gate', () => {
  it('matches obvious near-term date/time language', () => {
    for (const text of [
      'my interview is tomorrow at 3',
      "I'll hear back from the plumber on Friday",
      'call the vet Tuesday morning',
      'circle back by 5pm',
      'due 2026-07-15',
      'ping me in 2 hours',
    ]) {
      expect(hasCommitmentSignal(text)).toBe(true);
    }
  });

  it('does not match commitment-free chatter', () => {
    for (const text of ['thanks so much!', 'sounds good to me', 'what is on my plate?']) {
      expect(hasCommitmentSignal(text)).toBe(false);
    }
  });

  it('matches the test marker even without natural time language', () => {
    expect(hasCommitmentSignal('[[commitment: something | 2026-07-10T00:00:00.000Z]]')).toBe(true);
  });
});

describe('resolveDueAt — timezone-correct local resolution (bug-1a)', () => {
  it('a naive local wall-clock time is converted using the given IANA zone offset', () => {
    // 2026-07-10T15:00:00 local Buenos Aires (UTC-3) == 2026-07-10T18:00:00Z.
    expect(resolveDueAt('2026-07-10T15:00:00', 'America/Argentina/Buenos_Aires')).toBe(
      '2026-07-10T18:00:00.000Z',
    );
  });

  it('an already zone-aware ("Z") dueAt is passed through canonicalized, untouched by tz math', () => {
    expect(resolveDueAt('2026-07-10T15:00:00.000Z', 'America/Argentina/Buenos_Aires')).toBe(
      '2026-07-10T15:00:00.000Z',
    );
  });

  it('an already zone-aware (numeric offset) dueAt is canonicalized to the equivalent UTC instant', () => {
    expect(resolveDueAt('2026-07-10T15:00:00-03:00', 'America/Argentina/Buenos_Aires')).toBe(
      '2026-07-10T18:00:00.000Z',
    );
  });

  it('unparseable input returns null', () => {
    expect(resolveDueAt('not a date', 'America/Argentina/Buenos_Aires')).toBeNull();
  });
});

describe('buildCommitmentPrompt — local time shown to the model, not raw UTC', () => {
  it('CURRENT_TIME reflects the target timezone wall clock, labeled with its name', () => {
    // 2026-07-10T00:06:00Z == 2026-07-09T21:06:00 local Buenos Aires (UTC-3) — the
    // exact bug repro instant (user said "tomorrow at 3pm" at 21:06 local).
    const prompt = buildCommitmentPrompt('text', '2026-07-10T00:06:00.000Z', 'America/Argentina/Buenos_Aires');
    expect(prompt).toContain('CURRENT_TIME: 2026-07-09T21:06:00 (local time, America/Argentina/Buenos_Aires)');
  });
});

describe('extractCommitments', () => {
  it('bug repro: "tomorrow at 3pm" said at 21:06 local BA resolves to 2026-07-10T18:00:00Z (not 2026-07-11T15:00:00Z)', async () => {
    const { db, llm } = await mockLlm();
    await extractCommitments(
      { db, llm },
      {
        text:
          'I have a dentist appointment tomorrow at 3pm ' +
          '[[commitment: Dentist appointment | 2026-07-10T15:00:00]]',
        sourceTurnId: 'turn-1',
        now: '2026-07-10T00:06:00.000Z', // 2026-07-09 21:06 local Buenos Aires
        timeZone: 'America/Argentina/Buenos_Aires',
      },
    );
    const rows = db.listCommitments();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dueAt).toBe('2026-07-10T18:00:00.000Z');
  });

  it('same-turn dedup (bug-1b): skips a commitment overlapping a task captured earlier in this turn', async () => {
    const { db, llm } = await mockLlm();
    await extractCommitments(
      { db, llm },
      {
        text: 'appt [[commitment: Dentist appointment | 2026-07-10T18:00:00.000Z]]',
        sourceTurnId: 'turn-1',
        capturedTaskDescriptions: ['Dentist appointment tomorrow at 3pm'],
      },
    );
    expect(db.listCommitments()).toEqual([]);
  });

  it('same-turn dedup does not suppress an unrelated commitment', async () => {
    const { db, llm } = await mockLlm();
    await extractCommitments(
      { db, llm },
      {
        text: 'appt [[commitment: Plumber follow-up | 2026-07-10T18:00:00.000Z]]',
        sourceTurnId: 'turn-1',
        capturedTaskDescriptions: ['Dentist appointment tomorrow at 3pm'],
      },
    );
    expect(db.listCommitments()).toHaveLength(1);
  });


  it('mock marker → row inserted with the exact description/dueAt', async () => {
    const { db, llm } = await mockLlm();
    await extractCommitments(
      { db, llm },
      {
        text: 'my interview is tomorrow at 3 [[commitment: Interview follow-up | 2026-07-10T15:00:00.000Z]]',
        sourceTurnId: 'turn-1',
      },
    );
    const rows = db.listCommitments();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      description: 'Interview follow-up',
      dueAt: '2026-07-10T15:00:00.000Z',
      sourceTurnId: 'turn-1',
      status: 'open',
    });
  });

  it('no marker → nothing inserted, even when the heuristic gate lets the call through', async () => {
    const { db, llm } = await mockLlm();
    await extractCommitments({ db, llm }, { text: "let's meet tomorrow afternoon", sourceTurnId: 'turn-1' });
    expect(db.listCommitments()).toEqual([]);
  });

  it('commitment-free turns never reach the LLM (heuristic skip)', async () => {
    const { db } = await mockLlm();
    let called = false;
    const llm: LlmClient = {
      chatTurn: async () => {
        throw new Error('not used');
      },
      structured: async (req) => {
        called = true;
        return req.schema.parse({});
      },
      interrupt: async () => undefined,
    };
    await extractCommitments({ db, llm }, { text: 'thanks so much!', sourceTurnId: 'turn-1' });
    expect(called).toBe(false);
    expect(db.listCommitments()).toEqual([]);
  });

  it('empty (or whitespace-only) text never reaches the LLM', async () => {
    const { db } = await mockLlm();
    let called = false;
    const llm: LlmClient = {
      chatTurn: async () => {
        throw new Error('not used');
      },
      structured: async (req) => {
        called = true;
        return req.schema.parse({});
      },
      interrupt: async () => undefined,
    };
    await extractCommitments({ db, llm }, { text: '   ', sourceTurnId: 'turn-1' });
    expect(called).toBe(false);
  });

  it('dedup: identical description + same due day as an existing open commitment is skipped', async () => {
    const { db, llm } = await mockLlm();
    const marker = '[[commitment: Interview follow-up | 2026-07-10T15:00:00.000Z]]';
    await extractCommitments({ db, llm }, { text: `first mention ${marker}`, sourceTurnId: 'turn-1' });
    await extractCommitments({ db, llm }, { text: `second mention ${marker}`, sourceTurnId: 'turn-2' });
    expect(db.listCommitments()).toHaveLength(1);
  });

  it('a different due day is NOT deduped', async () => {
    const { db, llm } = await mockLlm();
    await extractCommitments(
      { db, llm },
      { text: 'a [[commitment: Interview follow-up | 2026-07-10T15:00:00.000Z]]', sourceTurnId: 't1' },
    );
    await extractCommitments(
      { db, llm },
      { text: 'b [[commitment: Interview follow-up | 2026-07-15T15:00:00.000Z]]', sourceTurnId: 't2' },
    );
    expect(db.listCommitments()).toHaveLength(2);
  });

  it('LLM failure never throws — degrades to a no-op', async () => {
    const { db } = await mockLlm();
    const llm: LlmClient = {
      chatTurn: async () => {
        throw new Error('not used');
      },
      structured: async () => {
        throw new Error('boom');
      },
      interrupt: async () => undefined,
    };
    await expect(
      extractCommitments({ db, llm }, { text: 'interview tomorrow at 3', sourceTurnId: 't1' }),
    ).resolves.toBeUndefined();
    expect(db.listCommitments()).toEqual([]);
  });
});

describe('chat/index.ts — commitment extraction hook', () => {
  async function setupChat(opts: { inferCommitments?: boolean } = {}) {
    const db = new Db(':memory:');
    const bus = createBus();
    const llm = await createLlm({ env: { mockLlm: true }, db, bus });
    const config = {
      persona: () => '# PERSONA\nYou are botty.',
      heartbeat: () => ({ ...parseHeartbeat('', 'sim'), inferCommitments: opts.inferCommitments ?? true }),
    };
    const memory = createMemory({ db, config });
    const chat = createChat({ db, bus, llm, memory, config });
    return { db, chat };
  }

  const MARKER_TEXT =
    'my interview is tomorrow at 3 [[commitment: Interview follow-up | 2026-07-10T15:00:00.000Z]]';

  it('a marker-bearing user message is picked up by the deferred extraction pass', async () => {
    const { db, chat } = await setupChat();
    await (await chat.handleUserMessage(MARKER_TEXT)).done;
    // Extraction is queued behind the assistant turn on the same turn queue
    // sealSession's summarizeSession uses — awaiting the NEXT turn's `.done`
    // guarantees it has landed (turnQueue runs strictly in order).
    await (await chat.handleUserMessage('anything else')).done;
    expect(db.listCommitments()).toHaveLength(1);
  });

  it('disabled via infer_commitments=false: the extraction pass never runs', async () => {
    const { db, chat } = await setupChat({ inferCommitments: false });
    await (await chat.handleUserMessage(MARKER_TEXT)).done;
    await (await chat.handleUserMessage('anything else')).done;
    expect(db.listCommitments()).toEqual([]);
  });

  it('the `!tool` mock trigger is never treated as a commitment-bearing message', async () => {
    const { db, chat } = await setupChat();
    await (await chat.handleUserMessage('!tool memory_search {"query":"tomorrow"}')).done;
    await (await chat.handleUserMessage('anything else')).done;
    expect(db.listCommitments()).toEqual([]);
  });

  it('extraction is deferred — a hanging commitment-pass call never blocks the response stream', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    const base = await createLlm({ env: { mockLlm: true }, db, bus });
    const llm: LlmClient = {
      chatTurn: (req) => base.chatTurn(req),
      structured: (req) =>
        req.system.includes(COMMITMENT_SYSTEM_MARKER)
          ? new Promise<never>(() => {}) // never resolves within the test
          : base.structured(req),
      interrupt: (key) => base.interrupt(key),
    };
    const config = {
      persona: () => '# PERSONA\nYou are botty.',
      heartbeat: () => parseHeartbeat('', 'sim'),
    };
    const memory = createMemory({ db, config });
    const chat = createChat({ db, bus, llm, memory, config });

    const { done } = await chat.handleUserMessage(MARKER_TEXT);
    const turn = await done;
    expect(turn).not.toBeNull();
  });

  it('same-turn dedup wiring: a commitment overlapping a task the turn itself captured via capture_task is suppressed', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    const base = await createLlm({ env: { mockLlm: true }, db, bus });
    // Simulate a real model turn: it calls capture_task (real tool_use event +
    // real handler execution, exactly as llm/sdk.ts would drive it) and then
    // answers normally — this exercises chat/index.ts's onEvent wiring for real,
    // not the `!tool` mock trigger (which disables commitment extraction entirely).
    const llm: LlmClient = {
      chatTurn: async (req) => {
        const captureTask = req.tools?.find((t) => t.name === 'capture_task');
        const result = await captureTask?.execute({
          description: 'Dentist appointment tomorrow at 3pm',
          dueDate: '2026-07-10',
        });
        req.onEvent({
          type: 'tool_use',
          name: 'capture_task',
          summary: captureTask?.summarize({ description: 'Dentist appointment tomorrow at 3pm' }),
        });
        req.onEvent({ type: 'text', text: 'Tracked it.' });
        req.onEvent({ type: 'done' });
        void result;
        return { text: 'Tracked it.', providerSessionId: 'x', usage: { inputTokens: 0, outputTokens: 0 } };
      },
      structured: (req) => base.structured(req),
      interrupt: (key) => base.interrupt(key),
    };
    const config = { persona: () => '# PERSONA\nYou are botty.', heartbeat: () => parseHeartbeat('', 'sim') };
    const memory = createMemory({ db, config });
    const chat = createChat({ db, bus, llm, memory, config });

    const marker = '[[commitment: Dentist appointment | 2026-07-10T18:00:00.000Z]]';
    await (await chat.handleUserMessage(`I have a dentist appointment tomorrow at 3pm ${marker}`)).done;
    await (await chat.handleUserMessage('anything else')).done; // flush the turn queue

    expect(db.listTasks('open').some((t) => t.description.includes('Dentist appointment'))).toBe(true);
    expect(db.listCommitments()).toEqual([]); // suppressed — same fact already tracked as a task
  });
});
