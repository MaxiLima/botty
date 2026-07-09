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
      'mcp__botty__memory_search',
      'mcp__botty__session_search',
    ]);
    expect(Object.keys(wiring.mcpServers)).toEqual([CHAT_TOOL_SERVER]);
    const server = wiring.mcpServers[CHAT_TOOL_SERVER] as { type?: string; instance?: unknown };
    expect(server.type).toBe('sdk');
    expect(server.instance).toBeDefined();
  });
});
