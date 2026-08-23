import { describe, expect, it } from 'vitest';
import type { WsEvent } from '@botty/shared';
import { Db } from '../src/db/index.js';
import { createBus } from '../src/bus/index.js';
import { createLlm, makeDecisionRecorder, makeModelResolver } from '../src/llm/index.js';
import {
  CHAT_TOOL_SERVER,
  EMPTY_RESPONSE_NUDGE,
  SdkLlmClient,
  loadSdkToolServerFactory,
  type QueryFn,
  type SdkMessageLike,
  type ToolServerFactory,
} from '../src/llm/sdk.js';
import type { ChatStreamEvent, ChatToolSpec } from '../src/llm/types.js';
import { createMemory } from '../src/memory/index.js';
import { createChatTools } from '../src/chat/tools.js';
import { createChat } from '../src/chat/index.js';
import { parseHeartbeat } from '../src/config/parse.js';

function makeTools(db: Db, bus = createBus()): ChatToolSpec[] {
  const config = {
    persona: () => '# PERSONA\nYou are botty.',
    heartbeat: () => parseHeartbeat('', 'sim'),
  };
  const memory = createMemory({ db, config });
  return createChatTools({ db, memory, bus });
}

describe('MockLlmClient !tool trigger', () => {
  async function setup() {
    const db = new Db(':memory:');
    const bus = createBus();
    const llm = await createLlm({ env: { mockLlm: true }, db, bus });
    const tools = makeTools(db, bus);
    const events: ChatStreamEvent[] = [];
    const session = db.createSession();
    const turn = (prompt: string) =>
      llm.chatTurn({ sessionKey: session.id, prompt, systemPrompt: 'sys', tools, onEvent: (e) => events.push(e) });
    return { db, llm, tools, events, turn };
  }

  it('runs the real tool handler, emits tool_use with summary, and echoes the result', async () => {
    const { db, events, turn } = await setup();
    const res = await turn('!tool capture_task {"description":"buy milk"}');

    const toolUse = events.find((e) => e.type === 'tool_use');
    expect(toolUse).toEqual({ type: 'tool_use', name: 'capture_task', summary: 'buy milk' });

    // handler actually ran — a chat-sourced task exists and the echo carries its id
    const tasks = db.listTasks('open');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.source).toBe('chat');
    expect(res.text).toContain('"taskId"');
    expect(res.text).toContain(tasks[0]!.id);
  });

  it('set_reminder inserts an explicit commitment at the exact UTC instant', async () => {
    const { db, events, turn } = await setup();
    const res = await turn(
      '!tool set_reminder {"description":"write to Ana about the renewal","dueAt":"2030-01-01T16:45:00-03:00"}',
    );

    const toolUse = events.find((e) => e.type === 'tool_use');
    expect(toolUse).toEqual({ type: 'tool_use', name: 'set_reminder', summary: 'write to Ana about the renewal' });

    const open = db.openCommitments();
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe('explicit');
    expect(open[0]!.dueAt).toBe('2030-01-01T19:45:00.000Z'); // offset normalized to UTC
    expect(res.text).toContain('"reminderId"');
  });

  it('set_reminder rejects a past dueAt without inserting anything', async () => {
    const { db, turn } = await setup();
    const res = await turn(
      '!tool set_reminder {"description":"too late","dueAt":"2020-01-01T00:00:00Z"}',
    );
    expect(res.text).toContain('must be in the future');
    expect(db.openCommitments()).toHaveLength(0);
  });

  it('unknown tool name yields a readable text reply, no tool_use event', async () => {
    const { events, turn } = await setup();
    const res = await turn('!tool frobnicate {"x":1}');
    expect(res.text).toContain('unknown tool: frobnicate');
    expect(events.some((e) => e.type === 'tool_use')).toBe(false);
  });

  it('malformed JSON args yield a readable text reply', async () => {
    const { turn } = await setup();
    const res = await turn('!tool capture_task {not json}');
    expect(res.text).toContain('bad tool args');
  });

  it('tool errors are echoed as the error result JSON, not thrown', async () => {
    const { turn } = await setup();
    const res = await turn('!tool task_action {"taskId":"nope","action":"done"}');
    expect(res.text).toContain('task not found');
  });

  it('flows end-to-end through the chat service (chat.toolUse + tasks.updated broadcasts)', async () => {
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

    const { done } = await chat.handleUserMessage('!tool capture_task {"description":"ship the report"}');
    await done;

    const toolUse = events.find((e) => e.type === 'chat.toolUse');
    expect(toolUse?.payload).toMatchObject({ name: 'capture_task', summary: 'ship the report' });
    expect(events.some((e) => e.type === 'tasks.updated')).toBe(true);
    expect(db.listTasks('open').some((t) => t.description === 'ship the report')).toBe(true);
  });

  // H8 (chat path): task_action used to be a hand-mirrored copy of the REST route's
  // switch that recorded nothing on the answered surface, so the 24h sweep marked an
  // acted-on nudge 'expired' even though the user just acted on it via chat. Mirrors
  // the server/routes.ts POST /api/tasks/:id/action fix and its test coverage.
  describe('task_action records a response on the answered proactive surface (H8, chat path)', () => {
    it('done → completed', async () => {
      const { db, turn } = await setup();
      const t = db.insertTask({ description: 'ship the report', source: 'slack' })!;
      const surface = db.insertProactiveLog({ taskId: t.id, surfaceKind: 'nudge', message: 'nudge' });
      await turn(`!tool task_action {"taskId":"${t.id}","action":"done"}`);
      const row = db.surfacesForTask(t.id, 1)[0]!;
      expect(row.id).toBe(surface.id);
      expect(row.responseType).toBe('completed');
      expect(row.responseReason).toBe('chat: task_action done');
    });

    it('snooze → snoozed', async () => {
      const { db, turn } = await setup();
      const t = db.insertTask({ description: 'follow up with vendor', source: 'slack' })!;
      const surface = db.insertProactiveLog({ taskId: t.id, surfaceKind: 'nudge', message: 'nudge' });
      await turn(`!tool task_action {"taskId":"${t.id}","action":"snooze","snoozeDays":1}`);
      const row = db.surfacesForTask(t.id, 1)[0]!;
      expect(row.id).toBe(surface.id);
      expect(row.responseType).toBe('snoozed');
      expect(row.responseReason).toBe('chat: task_action snooze');
    });

    it('dismiss → dismissed', async () => {
      const { db, turn } = await setup();
      const t = db.insertTask({ description: 'stale ask', source: 'slack' })!;
      const surface = db.insertProactiveLog({ taskId: t.id, surfaceKind: 'nudge', message: 'nudge' });
      await turn(`!tool task_action {"taskId":"${t.id}","action":"dismiss"}`);
      const row = db.surfacesForTask(t.id, 1)[0]!;
      expect(row.id).toBe(surface.id);
      expect(row.responseType).toBe('dismissed');
    });

    it('reopen and priority are not answers to a nudge → record nothing', async () => {
      const { db, turn } = await setup();
      const t = db.insertTask({ description: 'reopen me', source: 'slack' })!;
      db.updateTask(t.id, { status: 'done', doneAt: new Date().toISOString() }, 'test');
      const surface = db.insertProactiveLog({ taskId: t.id, surfaceKind: 'nudge', message: 'nudge' });
      await turn(`!tool task_action {"taskId":"${t.id}","action":"reopen"}`);
      await turn(`!tool task_action {"taskId":"${t.id}","action":"priority","priority":1}`);
      const row = db.surfacesForTask(t.id, 1)[0]!;
      expect(row.id).toBe(surface.id);
      expect(row.responseType).toBeNull();
    });

    it('no recent surface for the task → records nothing (no fabricated response)', async () => {
      const { db, turn } = await setup();
      const t = db.insertTask({ description: 'no surface for this one', source: 'slack' })!;
      await turn(`!tool task_action {"taskId":"${t.id}","action":"done"}`);
      expect(db.surfacesForTask(t.id, 1)).toEqual([]);
    });

    it('a surface that already has a response is not overwritten', async () => {
      const { db, turn } = await setup();
      const t = db.insertTask({ description: 'already answered', source: 'slack' })!;
      const surface = db.insertProactiveLog({ taskId: t.id, surfaceKind: 'nudge', message: 'nudge' });
      db.setProactiveResponse(surface.id, 'completed', 'chat: already answered');
      await turn(`!tool task_action {"taskId":"${t.id}","action":"dismiss"}`);
      const row = db.surfacesForTask(t.id, 1)[0]!;
      expect(row.responseType).toBe('completed');
      expect(row.responseReason).toBe('chat: already answered');
    });
  });
});

describe('SdkLlmClient chat tool wiring', () => {
  function makeClient(queryFn: QueryFn, factory?: ToolServerFactory) {
    const db = new Db(':memory:');
    const bus = createBus();
    const client = new SdkLlmClient({
      queryFn,
      db,
      modelFor: makeModelResolver(db),
      record: makeDecisionRecorder(db, bus),
      toolServerFactory: factory,
    });
    return { db, client };
  }

  const okStream = (extra: SdkMessageLike[] = [], resultText = 'ok'): SdkMessageLike[] => [
    { type: 'system', subtype: 'init', session_id: 'prov-1' },
    ...extra,
    { type: 'result', subtype: 'success', is_error: false, result: resultText, usage: { input_tokens: 1, output_tokens: 1 } },
  ];

  it('passes mcpServers + allowedTools from the factory and keeps built-ins disabled', async () => {
    const calls: { options: Record<string, unknown> }[] = [];
    const queryFn: QueryFn = ({ options }) => {
      calls.push({ options: options ?? {} });
      const messages = okStream();
      return { async *[Symbol.asyncIterator]() { yield* messages; } };
    };
    const factoryArgs: ChatToolSpec[][] = [];
    const factory: ToolServerFactory = (tools) => {
      factoryArgs.push(tools);
      return { mcpServers: { [CHAT_TOOL_SERVER]: { type: 'sdk' } }, allowedTools: ['mcp__botty__capture_task'] };
    };
    const { db, client } = makeClient(queryFn, factory);
    const tools = makeTools(db);
    const session = db.createSession();
    await client.chatTurn({ sessionKey: session.id, prompt: 'hi', systemPrompt: 'sys', tools, onEvent: () => {} });

    expect(factoryArgs[0]).toBe(tools);
    expect(calls[0]!.options.tools).toEqual([]);
    expect(calls[0]!.options.allowedTools).toEqual(['mcp__botty__capture_task']);
    expect(Object.keys(calls[0]!.options.mcpServers as Record<string, unknown>)).toEqual([CHAT_TOOL_SERVER]);
  });

  it('de-dupes colliding tool names before the factory runs, so a name collision never throws (finding 3)', async () => {
    const calls: { options: Record<string, unknown> }[] = [];
    const queryFn: QueryFn = ({ options }) => {
      calls.push({ options: options ?? {} });
      const messages = okStream();
      return { async *[Symbol.asyncIterator]() { yield* messages; } };
    };
    // Mirrors the real SDK's McpServer.tool(), which throws `Tool X is already
    // registered` on a duplicate name — the exact crash this fix guards against.
    const factoryArgs: ChatToolSpec[][] = [];
    const factory: ToolServerFactory = (tools) => {
      factoryArgs.push(tools);
      const seen = new Set<string>();
      for (const t of tools) {
        if (seen.has(t.name)) throw new Error(`Tool ${t.name} is already registered`);
        seen.add(t.name);
      }
      return {
        mcpServers: { [CHAT_TOOL_SERVER]: { type: 'sdk' } },
        allowedTools: tools.map((t) => `mcp__${CHAT_TOOL_SERVER}__${t.name}`),
      };
    };
    const { db, client } = makeClient(queryFn, factory);
    const spec = (name: string): ChatToolSpec => ({
      name,
      description: name,
      inputSchema: {},
      summarize: () => name,
      execute: async () => ({}),
    });
    // Two different external MCP servers independently producing the same
    // `${server}_${tool}` composed name (mcp/tools.ts) — this must not throw.
    const colliding = [spec('gcal_list_events'), spec('gcal_list_events')];
    const session = db.createSession();
    const res = await client.chatTurn({
      sessionKey: session.id,
      prompt: 'hi',
      systemPrompt: 'sys',
      tools: colliding,
      onEvent: () => {},
    });

    expect(res.text).toBe('ok');
    expect(factoryArgs[0]!.map((t) => t.name)).toEqual(['gcal_list_events', 'gcal_list_events_2']);
    expect(calls[0]!.options.allowedTools).toEqual([
      'mcp__botty__gcal_list_events',
      'mcp__botty__gcal_list_events_2',
    ]);
  });

  it('omits tool wiring when no factory is injected (tool-less chat still works)', async () => {
    const calls: { options: Record<string, unknown> }[] = [];
    const queryFn: QueryFn = ({ options }) => {
      calls.push({ options: options ?? {} });
      const messages = okStream();
      return { async *[Symbol.asyncIterator]() { yield* messages; } };
    };
    const { db, client } = makeClient(queryFn);
    const tools = makeTools(db);
    const session = db.createSession();
    const res = await client.chatTurn({ sessionKey: session.id, prompt: 'hi', systemPrompt: 'sys', tools, onEvent: () => {} });
    expect(res.text).toBe('ok');
    expect(calls[0]!.options.mcpServers).toBeUndefined();
    expect(calls[0]!.options.allowedTools).toBeUndefined();
  });

  it('emits tool_use with the friendly name and an input-derived summary', async () => {
    const queryFn: QueryFn = () => {
      const messages = okStream([
        {
          type: 'assistant',
          session_id: 'prov-1',
          message: {
            content: [
              { type: 'tool_use', name: 'mcp__botty__capture_task', input: { description: 'buy milk' } },
              { type: 'tool_use', name: 'SomeOtherTool', input: {} },
            ],
          },
        },
      ]);
      return { async *[Symbol.asyncIterator]() { yield* messages; } };
    };
    const { db, client } = makeClient(queryFn, () => ({ mcpServers: {}, allowedTools: [] }));
    const tools = makeTools(db);
    const session = db.createSession();
    const events: ChatStreamEvent[] = [];
    await client.chatTurn({ sessionKey: session.id, prompt: 'hi', systemPrompt: 'sys', tools, onEvent: (e) => events.push(e) });

    const toolEvents = events.filter((e) => e.type === 'tool_use');
    expect(toolEvents[0]).toEqual({ type: 'tool_use', name: 'capture_task', summary: 'buy milk' });
    // Unknown names pass through untouched, no summary.
    expect(toolEvents[1]).toEqual({ type: 'tool_use', name: 'SomeOtherTool' });
  });

  // Appendix C ("likely, needs repro"): a text → tool_use → text reply spans
  // TWO assistant messages within one turn (num_turns > 1). The SDK's own
  // 'result' message historically carries only the FINAL assistant message's
  // text, which would silently drop the first segment from what gets saved —
  // even though the client already saw both segments stream via chat.chunk.
  it('a multi-segment reply (text → tool → text) keeps the FIRST segment, not just the last', async () => {
    const queryFn: QueryFn = () => {
      const messages: SdkMessageLike[] = [
        { type: 'system', subtype: 'init', session_id: 'prov-multi' },
        {
          type: 'stream_event',
          session_id: 'prov-multi',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me check that — ' } },
        },
        {
          type: 'assistant',
          session_id: 'prov-multi',
          message: { content: [{ type: 'tool_use', name: 'mcp__botty__capture_task', input: { description: 'x' } }] },
        },
        {
          type: 'stream_event',
          session_id: 'prov-multi',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done, tracked it.' } },
        },
        // Mirrors the real SDK: `result` on a multi-turn (num_turns > 1) call
        // carries only the LAST assistant message's text.
        {
          type: 'result',
          subtype: 'success',
          session_id: 'prov-multi',
          is_error: false,
          result: 'done, tracked it.',
          usage: { input_tokens: 4, output_tokens: 6 },
        },
      ];
      return { async *[Symbol.asyncIterator]() { yield* messages; } };
    };
    const { db, client } = makeClient(queryFn, () => ({ mcpServers: {}, allowedTools: [] }));
    const tools = makeTools(db);
    const session = db.createSession();
    const chunks: string[] = [];
    const res = await client.chatTurn({
      sessionKey: session.id,
      prompt: 'track something for me',
      systemPrompt: 'sys',
      tools,
      onEvent: (e) => e.type === 'text' && chunks.push(e.text),
    });

    // What the client saw stream, live, in order.
    expect(chunks.join('')).toBe('Let me check that — done, tracked it.');
    // What gets saved/returned must match — not just the trailing segment.
    expect(res.text).toBe('Let me check that — done, tracked it.');
    expect(res.text).toContain('Let me check that');
  });
});

describe('SdkLlmClient empty-response recovery', () => {
  function makeClient(queryFn: QueryFn) {
    const db = new Db(':memory:');
    const bus = createBus();
    const client = new SdkLlmClient({
      queryFn,
      db,
      modelFor: makeModelResolver(db),
      record: makeDecisionRecorder(db, bus),
    });
    return { db, client };
  }

  it('retries once with the continuation nudge when the turn produced no text and no tool use', async () => {
    const calls: { prompt: unknown }[] = [];
    let n = 0;
    const queryFn: QueryFn = ({ prompt }) => {
      calls.push({ prompt });
      n += 1;
      const messages: SdkMessageLike[] =
        n === 1
          ? [
              { type: 'system', subtype: 'init', session_id: 'prov-1' },
              { type: 'result', subtype: 'success', is_error: false, result: '', usage: { input_tokens: 1, output_tokens: 0 } },
            ]
          : [
              { type: 'system', subtype: 'init', session_id: 'prov-1' },
              { type: 'result', subtype: 'success', is_error: false, result: 'recovered', usage: { input_tokens: 1, output_tokens: 1 } },
            ];
      return { async *[Symbol.asyncIterator]() { yield* messages; } };
    };
    const { db, client } = makeClient(queryFn);
    const session = db.createSession();
    const res = await client.chatTurn({ sessionKey: session.id, prompt: 'hello?', systemPrompt: 'sys', onEvent: () => {} });

    expect(res.text).toBe('recovered');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toBe(`hello?${EMPTY_RESPONSE_NUDGE}`);
    // both attempts recorded in ai_decisions
    expect(db.listAiDecisions({ kind: 'chat_turn' })).toHaveLength(2);
  });

  it('does not retry again if the nudged attempt is also empty (exactly two calls)', async () => {
    let n = 0;
    const queryFn: QueryFn = () => {
      n += 1;
      const messages: SdkMessageLike[] = [
        { type: 'system', subtype: 'init', session_id: 'prov-1' },
        { type: 'result', subtype: 'success', is_error: false, result: '', usage: { input_tokens: 1, output_tokens: 0 } },
      ];
      return { async *[Symbol.asyncIterator]() { yield* messages; } };
    };
    const { db, client } = makeClient(queryFn);
    const session = db.createSession();
    const res = await client.chatTurn({ sessionKey: session.id, prompt: 'hello?', systemPrompt: 'sys', onEvent: () => {} });
    expect(res.text).toBe('');
    expect(n).toBe(2);
  });

  it('does not retry when the turn used a tool even if the final text is empty', async () => {
    let n = 0;
    const queryFn: QueryFn = () => {
      n += 1;
      const messages: SdkMessageLike[] = [
        { type: 'system', subtype: 'init', session_id: 'prov-1' },
        {
          type: 'assistant',
          session_id: 'prov-1',
          message: { content: [{ type: 'tool_use', name: 'mcp__botty__capture_task', input: {} }] },
        },
        { type: 'result', subtype: 'success', is_error: false, result: '', usage: { input_tokens: 1, output_tokens: 0 } },
      ];
      return { async *[Symbol.asyncIterator]() { yield* messages; } };
    };
    const { db, client } = makeClient(queryFn);
    const session = db.createSession();
    await client.chatTurn({ sessionKey: session.id, prompt: 'track it', systemPrompt: 'sys', onEvent: () => {} });
    expect(n).toBe(1);
  });

  it('does not retry when text streamed', async () => {
    let n = 0;
    const queryFn: QueryFn = () => {
      n += 1;
      const messages: SdkMessageLike[] = [
        { type: 'system', subtype: 'init', session_id: 'prov-1' },
        {
          type: 'stream_event',
          session_id: 'prov-1',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi there' } },
        },
        { type: 'result', subtype: 'success', is_error: false, result: 'hi there', usage: { input_tokens: 1, output_tokens: 1 } },
      ];
      return { async *[Symbol.asyncIterator]() { yield* messages; } };
    };
    const { db, client } = makeClient(queryFn);
    const session = db.createSession();
    const res = await client.chatTurn({ sessionKey: session.id, prompt: 'hi', systemPrompt: 'sys', onEvent: () => {} });
    expect(res.text).toBe('hi there');
    expect(n).toBe(1);
  });
});

describe('loadSdkToolServerFactory (real Agent SDK)', () => {
  it('wraps the specs via tool() + createSdkMcpServer() with mcp__botty__ allowed names', async () => {
    const factory = await loadSdkToolServerFactory();
    const db = new Db(':memory:');
    const tools = makeTools(db);
    const wiring = factory(tools);

    expect(wiring.allowedTools).toEqual([
      'mcp__botty__capture_task',
      'mcp__botty__task_action',
      'mcp__botty__set_reminder',
      'mcp__botty__memory_search',
      'mcp__botty__session_search',
    ]);
    expect(Object.keys(wiring.mcpServers)).toEqual([CHAT_TOOL_SERVER]);
    const server = wiring.mcpServers[CHAT_TOOL_SERVER] as { type?: string; instance?: unknown };
    expect(server.type).toBe('sdk');
    expect(server.instance).toBeDefined();
  });
});
