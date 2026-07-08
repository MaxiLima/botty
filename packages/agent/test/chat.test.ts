import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { Db } from '../src/db/index.js';
import { createBus } from '../src/bus/index.js';
import { createLlm } from '../src/llm/index.js';
import { createMemory } from '../src/memory/index.js';
import { createChat } from '../src/chat/index.js';
import { parseHeartbeat } from '../src/config/parse.js';

async function setup() {
  const db = new Db(':memory:');
  const bus = createBus();
  const llm = await createLlm({ env: { mockLlm: true }, db, bus });
  const config = {
    persona: () => '# PERSONA\nYou are botty.',
    heartbeat: () => parseHeartbeat('', 'sim'),
  };
  const memory = createMemory({ db, config });
  const chat = createChat({ db, bus, llm, memory });
  const events: WsEvent[] = [];
  bus.onBroadcast((e) => events.push(e));
  return { db, bus, llm, memory, chat, events };
}

describe('chat service', () => {
  it('persists user + assistant turns, streams chunks, fts-indexes both', async () => {
    const { db, chat, events } = await setup();
    const { turnId, done } = await chat.handleUserMessage('what is on my plate?');
    const turn = await done;

    expect(turn).not.toBeNull();
    expect(turn!.id).toBe(turnId);
    expect(turn!.content).toBe('[mock] what is on my plate?');

    const session = db.activeSession()!;
    const turns = db.turnsForSession(session.id);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);

    // WS stream: chunks then done, all tagged with the assistant turn id
    const chunks = events.filter((e) => e.type === 'chat.chunk');
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.payload.turnId === turnId)).toBe(true);
    const doneEvents = events.filter((e) => e.type === 'chat.done');
    expect(doneEvents).toHaveLength(1);

    // both turns searchable
    const hits = db.ftsSearch('plate', 5);
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.kind === 'chat')).toBe(true);
  });

  it('reuses the active session within the idle window', async () => {
    const { db, chat } = await setup();
    await (await chat.handleUserMessage('first')).done;
    await (await chat.handleUserMessage('second')).done;
    const session = db.activeSession()!;
    expect(db.turnsForSession(session.id)).toHaveLength(4);
    expect(db.listSessions()).toHaveLength(1);
  });

  it('seals an idle session (summary via llm) and opens a fresh one', async () => {
    const { db, chat } = await setup();
    await (await chat.handleUserMessage('old topic')).done;
    const first = db.activeSession()!;
    // simulate >30 min idle
    db.touchSession(first.id, new Date(Date.now() - 31 * 60_000).toISOString());

    await (await chat.handleUserMessage('new topic')).done;
    const second = db.activeSession()!;
    expect(second.id).not.toBe(first.id);

    const sealed = db.getSessionMeta(first.id)!;
    expect(sealed.status).toBe('sealed');
    expect(sealed.summary).toContain('[mock]'); // mock briefing summary
    expect(db.recentSealedSummaries(3)).toHaveLength(1);
    // sealing recorded a briefing ai_decision tied to the session
    const briefings = db.listAiDecisions({ kind: 'briefing' });
    expect(briefings).toHaveLength(1);
    expect(briefings[0]!.relatedRef).toBe(first.id);
  });

  it('explicit seal() works and the sealed summary feeds the next system prompt', async () => {
    const { db, chat, memory } = await setup();
    await (await chat.handleUserMessage('remember the quarterly planning doc')).done;
    await chat.seal();
    expect(db.activeSession()).toBeUndefined();

    const prompt = memory.buildChatSystemPrompt('anything');
    expect(prompt).toContain('Recent conversation summaries');
    expect(prompt).toContain('You are botty');
  });

  it('recall does not surface the just-sent user message (indexed after prompt build)', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    const base = await createLlm({ env: { mockLlm: true }, db, bus });
    const systemPrompts: string[] = [];
    const llm: typeof base = {
      chatTurn: (req) => {
        systemPrompts.push(req.systemPrompt);
        return base.chatTurn(req);
      },
      structured: (req) => base.structured(req),
      interrupt: (key) => base.interrupt(key),
    };
    const config = {
      persona: () => '# PERSONA\nYou are botty.',
      heartbeat: () => parseHeartbeat('', 'sim'),
    };
    const memory = createMemory({ db, config });
    const chat = createChat({ db, bus, llm, memory });

    await (await chat.handleUserMessage('quixotic zeppelin marmalade')).done;
    expect(systemPrompts).toHaveLength(1);
    // Nothing else matches those tokens, so a hit could only be the message itself.
    expect(systemPrompts[0]).not.toContain('Possibly relevant memory');
    // ...but the turn is still indexed afterwards for future recall.
    expect(db.ftsSearch('zeppelin', 5).length).toBeGreaterThan(0);
  });

  it('serializes concurrent sends and never leaves duplicate active sessions', async () => {
    const { db, chat } = await setup();
    await (await chat.handleUserMessage('warm up')).done;
    const first = db.activeSession()!;
    // simulate >30 min idle, then two sends racing through the seal
    db.touchSession(first.id, new Date(Date.now() - 31 * 60_000).toISOString());
    const [a, b] = await Promise.all([chat.handleUserMessage('one'), chat.handleUserMessage('two')]);
    await Promise.all([a.done, b.done]);

    const active = db.raw
      .prepare("SELECT COUNT(*) AS c FROM sessions WHERE status='active'")
      .get() as { c: number };
    expect(active.c).toBe(1);
    expect(db.listSessions()).toHaveLength(2);
    // the idled session was sealed exactly once, with a summary
    const sealed = db.getSessionMeta(first.id)!;
    expect(sealed.status).toBe('sealed');
    expect(sealed.summary).toContain('[mock]');
    expect(db.listAiDecisions({ kind: 'briefing' })).toHaveLength(1);
    // both exchanges landed in the single new session
    const turns = db.turnsForSession(db.activeSession()!.id);
    expect(turns.filter((t) => t.role === 'user')).toHaveLength(2);
    expect(turns.filter((t) => t.role === 'assistant')).toHaveLength(2);
  });

  it('emits chat.userMessage on the internal bus', async () => {
    const { bus, chat } = await setup();
    const seen: { text: string; at: string }[] = [];
    bus.on('chat.userMessage', (p) => seen.push(p));
    await (await chat.handleUserMessage('ping')).done;
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toBe('ping');
  });
});
