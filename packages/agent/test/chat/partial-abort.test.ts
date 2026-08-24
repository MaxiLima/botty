import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { Db } from '../../src/db/index.js';
import { createBus } from '../../src/bus/index.js';
import { createChat } from '../../src/chat/index.js';
import { createMemory } from '../../src/memory/index.js';
import { PartialChatTurnError } from '../../src/llm/types.js';
import type { LlmClient, TokenUsage } from '../../src/llm/types.js';
import { parseHeartbeat } from '../../src/config/parse.js';

/**
 * Finding 1 (MEDIUM Chat/MCP): interrupt / max-turns / mid-turn error used to
 * discard the streamed partial reply from LOCAL history while the SDK's own
 * resumable session transcript kept it — the two histories silently diverged
 * and the next turn was built on a lie. llm/sdk.ts now throws
 * PartialChatTurnError (carrying the partial text) instead of a plain Error
 * whenever text had already streamed; chat/index.ts must catch that
 * specifically and persist the partial text, marked partial.
 *
 * Also covers the related LOW: interrupt() used to be a silent no-op once a
 * session was sealed mid-stream, even though the SDK handle for that turn was
 * still live.
 */

function makeConfig() {
  return {
    persona: () => '# PERSONA\nYou are botty.',
    heartbeat: () => parseHeartbeat('', 'sim'),
  };
}

const USAGE: TokenUsage = {
  inputTokens: 10,
  outputTokens: 3,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  totalCostUsd: null,
};

describe('chat service — partial-abort persistence (finding 1)', () => {
  it('persists the streamed partial text, marked partial, instead of discarding it', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    const events: WsEvent[] = [];
    bus.onBroadcast((e) => events.push(e));
    const llm: LlmClient = {
      async chatTurn(req) {
        req.onEvent({ type: 'text', text: 'Sure, I can help with ' });
        throw new PartialChatTurnError('error_max_turns', 'Sure, I can help with ', USAGE, 'prov-partial-1');
      },
      async structured() {
        throw new Error('not used in this test');
      },
      async interrupt() {},
    };
    const memory = createMemory({ db, config: makeConfig() });
    const chat = createChat({ db, bus, llm, memory });

    const { turnId, done } = await chat.handleUserMessage('draft a long reply');
    const turn = await done;

    // The turn is NOT dropped — it's persisted with exactly the text the
    // client already saw stream in via chat.chunk.
    expect(turn).not.toBeNull();
    expect(turn!.id).toBe(turnId);
    expect(turn!.role).toBe('assistant');
    expect(turn!.content).toBe('Sure, I can help with ');
    expect(turn!.meta).toMatchObject({ partial: true, error: 'error_max_turns' });

    // Local history now matches what the SDK's own transcript has — the next
    // resumed turn is no longer built on a system prompt describing a reply
    // that silently vanished.
    const dbTurn = db.getChatTurn(turnId);
    expect(dbTurn?.content).toBe('Sure, I can help with ');
    expect(db.getProviderSessionId(db.activeSession()!.id)).toBe('prov-partial-1');

    // The client still learns the turn ended in error (unchanged wire contract).
    const errorEvents = events.filter((e) => e.type === 'chat.error');
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]!.payload).toMatchObject({ turnId, error: 'error_max_turns' });
    // No chat.done for a partial/aborted turn.
    expect(events.some((e) => e.type === 'chat.done')).toBe(false);

    // Searchable like any other assistant turn.
    expect(db.ftsSearch('help with', 5).some((h) => h.refId === turnId)).toBe(true);
  });

  it('an abort with NO streamed text (plain Error) still returns null and persists nothing', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    const llm: LlmClient = {
      async chatTurn() {
        throw new Error('boom before anything streamed');
      },
      async structured() {
        throw new Error('not used in this test');
      },
      async interrupt() {},
    };
    const memory = createMemory({ db, config: makeConfig() });
    const chat = createChat({ db, bus, llm, memory });

    const { turnId, done } = await chat.handleUserMessage('hi');
    const turn = await done;

    expect(turn).toBeNull();
    expect(db.getChatTurn(turnId)).toBeUndefined();
  });

  it('interrupt() still reaches the in-flight turn after the session is sealed mid-stream (LOW)', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    let releaseChatTurn: (() => void) | undefined;
    const interruptedSessionKeys: string[] = [];
    const llm: LlmClient = {
      chatTurn(req) {
        return new Promise((resolve) => {
          releaseChatTurn = () => {
            req.onEvent({ type: 'done' });
            resolve({ text: 'late reply', providerSessionId: 'prov-late', usage: USAGE });
          };
        });
      },
      async structured() {
        throw new Error('not used in this test');
      },
      async interrupt(sessionKey) {
        interruptedSessionKeys.push(sessionKey);
      },
    };
    const memory = createMemory({ db, config: makeConfig() });
    const chat = createChat({ db, bus, llm, memory });

    const { done } = await chat.handleUserMessage('a very long request');
    // Let the queued runAssistant reach (and block on) llm.chatTurn.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const sessionBeforeSeal = db.activeSession()!.id;

    // Sealing mid-stream nulls the "active session" — before this fix,
    // interrupt() below would silently no-op because it only ever looked at
    // activeSessionId / db.activeSession().
    await chat.seal();
    expect(db.activeSession()).toBeUndefined();

    await chat.interrupt();
    expect(interruptedSessionKeys).toEqual([sessionBeforeSeal]);

    releaseChatTurn?.();
    await done;
  });
});
