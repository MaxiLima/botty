import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClassifierOutputSchema, ExtractorOutputSchema, JudgmentOutputSchema } from '@botty/shared';
import { Db } from '../src/db/index.js';
import { createBus } from '../src/bus/index.js';
import { createLlm, LlmParseError, makeModelResolver } from '../src/llm/index.js';
import { SdkLlmClient, type QueryFn, type SdkMessageLike } from '../src/llm/sdk.js';
import { makeDecisionRecorder } from '../src/llm/index.js';
import { MockLlmClient } from '../src/llm/mock.js';

const OutSchema = z.object({ answer: z.string(), score: z.number() });

/** Build a QueryFn that replays canned response texts, one per call. */
function stubQueryFn(responses: string[], calls: { prompt: string; options: Record<string, unknown> }[] = []): QueryFn {
  let i = 0;
  return ({ prompt, options }) => {
    calls.push({ prompt, options: options ?? {} });
    const text = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    const messages: SdkMessageLike[] = [
      { type: 'system', subtype: 'init', session_id: 'prov-abc' },
      { type: 'assistant', session_id: 'prov-abc', message: { content: [{ type: 'text', text }] } },
      {
        type: 'result',
        subtype: 'success',
        session_id: 'prov-abc',
        is_error: false,
        result: text,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];
    return {
      async *[Symbol.asyncIterator]() {
        yield* messages;
      },
      interrupt: async () => {},
    };
  };
}

function makeClient(responses: string[], calls: { prompt: string; options: Record<string, unknown> }[] = []) {
  const db = new Db(':memory:');
  const bus = createBus();
  const client = new SdkLlmClient({
    queryFn: stubQueryFn(responses, calls),
    db,
    modelFor: makeModelResolver(db),
    record: makeDecisionRecorder(db, bus),
  });
  return { db, bus, client };
}

describe('SdkLlmClient.structured', () => {
  it('parses clean JSON and records an ai_decisions row + bus event', async () => {
    const { db, bus, client } = makeClient(['{"answer":"ok","score":9}']);
    const recorded: string[] = [];
    bus.onBroadcast((e) => e.type === 'decision.recorded' && recorded.push(e.payload.decision.kind));

    const out = await client.structured({ task: 'judgment', system: 'sys', prompt: 'prompt', schema: OutSchema, relatedRef: 'tick-1' });
    expect(out).toEqual({ answer: 'ok', score: 9 });

    const rows = db.listAiDecisions({ kind: 'judgment' });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.inputJson)).toEqual({ system: 'sys', prompt: 'prompt' });
    expect(JSON.parse(rows[0]!.outputJson!)).toEqual({ answer: 'ok', score: 9 });
    expect(rows[0]!.relatedRef).toBe('tick-1');
    expect(rows[0]!.model).toBe('claude-sonnet-5');
    expect(rows[0]!.inputTokens).toBe(10);
    expect(recorded).toEqual(['judgment']);
  });

  it('tolerates markdown fences and surrounding prose', async () => {
    const { client } = makeClient(['Here you go:\n```json\n{"answer":"fenced","score":1}\n```\nHope that helps!']);
    const out = await client.structured({ task: 'classification', system: 's', prompt: 'p', schema: OutSchema });
    expect(out.answer).toBe('fenced');
  });

  it('retries once with the validation error appended, then succeeds', async () => {
    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const { client } = makeClient(['{"answer":"missing score"}', '{"answer":"fixed","score":2}'], calls);
    const out = await client.structured({ task: 'extraction', system: 's', prompt: 'orig-prompt', schema: OutSchema });
    expect(out).toEqual({ answer: 'fixed', score: 2 });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('orig-prompt');
    expect(calls[1]!.prompt).toContain('could not be used');
    expect(calls[1]!.prompt).toContain('missing score');
  });

  it('throws LlmParseError after a failed retry and records the error', async () => {
    const { db, client } = makeClient(['not json at all', 'still not json']);
    await expect(
      client.structured({ task: 'classification', system: 's', prompt: 'p', schema: OutSchema }),
    ).rejects.toThrow(LlmParseError);
    const rows = db.listAiDecisions({ kind: 'classification' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toContain('parse failed after retry');
  });

  it('disallows tools and keeps maxTurns low on structured calls', async () => {
    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const { client } = makeClient(['{"answer":"x","score":0}'], calls);
    await client.structured({ task: 'judgment', system: 's', prompt: 'p', schema: OutSchema });
    expect(calls[0]!.options.tools).toEqual([]);
    expect(calls[0]!.options.maxTurns).toBeLessThanOrEqual(2);
    expect(String(calls[0]!.options.systemPrompt)).toContain('JSON');
  });

  it('routes models per task with settings override', async () => {
    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const { db, client } = makeClient(['{"answer":"x","score":0}'], calls);
    await client.structured({ task: 'classification', system: 's', prompt: 'p', schema: OutSchema });
    expect(calls[0]!.options.model).toBe('claude-haiku-4-5');
    db.setSetting('llm.models', { classification: 'claude-opus-4-8' });
    await client.structured({ task: 'classification', system: 's', prompt: 'p', schema: OutSchema });
    expect(calls[1]!.options.model).toBe('claude-opus-4-8');
  });
});

describe('SdkLlmClient.structured — error accounting', () => {
  it('records tokens consumed by completed attempts when a later attempt throws', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    let call = 0;
    const queryFn: QueryFn = () => {
      call += 1;
      if (call === 1) {
        // First attempt completes (with usage) but returns unparseable text.
        const messages: SdkMessageLike[] = [
          { type: 'assistant', session_id: 's', message: { content: [{ type: 'text', text: 'not json' }] } },
          { type: 'result', subtype: 'success', is_error: false, result: 'not json', usage: { input_tokens: 10, output_tokens: 5 } },
        ];
        return { async *[Symbol.asyncIterator]() { yield* messages; } };
      }
      // Retry attempt dies mid-stream.
      return {
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator](): AsyncGenerator<SdkMessageLike> {
          throw new Error('stream died');
        },
      };
    };
    const client = new SdkLlmClient({ queryFn, db, modelFor: makeModelResolver(db), record: makeDecisionRecorder(db, bus) });
    await expect(
      client.structured({ task: 'judgment', system: 's', prompt: 'p', schema: OutSchema }),
    ).rejects.toThrow('stream died');
    const rows = db.listAiDecisions({ kind: 'judgment' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toBe('stream died');
    expect(rows[0]!.inputTokens).toBe(10);
    expect(rows[0]!.outputTokens).toBe(5);
  });
});

describe('SdkLlmClient.chatTurn', () => {
  it('persists the provider session id and resumes with it', async () => {
    const calls: { prompt: string; options: Record<string, unknown> }[] = [];
    const { db, client } = makeClient(['hello there'], calls);
    const session = db.createSession();
    const res = await client.chatTurn({ sessionKey: session.id, prompt: 'hi', systemPrompt: 'sys', onEvent: () => {} });
    expect(res.text).toBe('hello there');
    expect(res.providerSessionId).toBe('prov-abc');
    expect(db.getProviderSessionId(session.id)).toBe('prov-abc');
    expect(calls[0]!.options.resume).toBeUndefined();

    await client.chatTurn({ sessionKey: session.id, prompt: 'again', systemPrompt: 'sys', onEvent: () => {} });
    expect(calls[1]!.options.resume).toBe('prov-abc');
    // chat turns are recorded as chat_turn decisions
    expect(db.listAiDecisions({ kind: 'chat_turn' })).toHaveLength(2);
  });

  it('records an ai_decisions error row when the stream throws mid-turn', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    const queryFn: QueryFn = () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkMessageLike> {
        yield { type: 'system', subtype: 'init', session_id: 'prov-x' };
        throw new Error('subprocess crashed');
      },
    });
    const client = new SdkLlmClient({ queryFn, db, modelFor: makeModelResolver(db), record: makeDecisionRecorder(db, bus) });
    const session = db.createSession();
    await expect(
      client.chatTurn({ sessionKey: session.id, prompt: 'hi', systemPrompt: 'sys', onEvent: () => {} }),
    ).rejects.toThrow('subprocess crashed');
    const rows = db.listAiDecisions({ kind: 'chat_turn' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.error).toBe('subprocess crashed');
    // A session id from a run that died mid-stream is never persisted.
    expect(db.getProviderSessionId(session.id)).toBeNull();
  });

  it('retries a failed resumed attempt only when it streamed no output', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    let calls = 0;
    const failThenSucceed: QueryFn = () => {
      calls += 1;
      if (calls === 1) {
        return {
          // Dies before producing any output — stale resume id.
          async *[Symbol.asyncIterator](): AsyncGenerator<SdkMessageLike> {
            throw new Error('stale session');
          },
        };
      }
      const messages: SdkMessageLike[] = [
        { type: 'system', subtype: 'init', session_id: 'prov-new' },
        { type: 'result', subtype: 'success', is_error: false, result: 'fresh answer', usage: { input_tokens: 1, output_tokens: 1 } },
      ];
      return { async *[Symbol.asyncIterator]() { yield* messages; } };
    };
    const client = new SdkLlmClient({ queryFn: failThenSucceed, db, modelFor: makeModelResolver(db), record: makeDecisionRecorder(db, bus) });
    const session = db.createSession();
    db.setProviderSessionId(session.id, 'prov-old');
    const res = await client.chatTurn({ sessionKey: session.id, prompt: 'hi', systemPrompt: 'sys', onEvent: () => {} });
    expect(res.text).toBe('fresh answer');
    expect(calls).toBe(2);
  });

  it('never retries after partial output has streamed (would duplicate text in the turn)', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    let calls = 0;
    const partialThenFail: QueryFn = () => {
      calls += 1;
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<SdkMessageLike> {
          yield {
            type: 'stream_event',
            session_id: 'prov-p',
            event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial…' } },
          };
          throw new Error('mid-stream death');
        },
      };
    };
    const client = new SdkLlmClient({ queryFn: partialThenFail, db, modelFor: makeModelResolver(db), record: makeDecisionRecorder(db, bus) });
    const session = db.createSession();
    db.setProviderSessionId(session.id, 'prov-old');
    await expect(
      client.chatTurn({ sessionKey: session.id, prompt: 'hi', systemPrompt: 'sys', onEvent: () => {} }),
    ).rejects.toThrow('mid-stream death');
    expect(calls).toBe(1);
  });
});

describe('MockLlmClient (BOTTY_MOCK_LLM=1)', () => {
  async function makeMock() {
    const db = new Db(':memory:');
    const bus = createBus();
    const llm = await createLlm({ env: { mockLlm: true }, db, bus });
    return { db, llm };
  }

  it('createLlm returns the mock when env.mockLlm is set', async () => {
    const { llm } = await makeMock();
    expect(llm).toBeInstanceOf(MockLlmClient);
  });

  it('classifier fires iff heuristic signals present', async () => {
    const { llm } = await makeMock();
    const yes = await llm.structured({
      task: 'classification',
      system: 's',
      prompt: 'TEXT: can you review the design doc by friday',
      schema: ClassifierOutputSchema,
    });
    expect(yes.worthExtracting).toBe(true);
    const no = await llm.structured({
      task: 'classification',
      system: 's',
      prompt: 'TEXT: nice weather today',
      schema: ClassifierOutputSchema,
    });
    expect(no.worthExtracting).toBe(false);
  });

  it('extractor pulls a naive task with requester from ACTOR', async () => {
    const { llm } = await makeMock();
    const out = await llm.structured({
      task: 'extraction',
      system: 's',
      prompt: 'ACTOR: Marian\nTEXT: please deploy the fix asap',
      schema: ExtractorOutputSchema,
    });
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0]!.description).toBe('please deploy the fix asap');
    expect(out.tasks[0]!.requesterName).toBe('Marian');
  });

  it('judgment skips everything; chat echoes deterministically', async () => {
    const { db, llm } = await makeMock();
    const j = await llm.structured({ task: 'judgment', system: 's', prompt: 'whatever', schema: JudgmentOutputSchema });
    expect(j.actions).toEqual([]);

    const session = db.createSession();
    const chunks: string[] = [];
    const res = await llm.chatTurn({
      sessionKey: session.id,
      prompt: 'hola botty',
      systemPrompt: 'sys',
      onEvent: (e) => e.type === 'text' && chunks.push(e.text),
    });
    expect(res.text).toBe('[mock] hola botty');
    expect(chunks.join('')).toBe('[mock] hola botty');
  });
});
