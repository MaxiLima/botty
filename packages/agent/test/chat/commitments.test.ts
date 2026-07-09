import { describe, expect, it } from 'vitest';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { createChat } from '../../src/chat/index.js';
import {
  COMMITMENT_SYSTEM_MARKER,
  extractCommitments,
  hasCommitmentSignal,
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

describe('extractCommitments', () => {
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
});
