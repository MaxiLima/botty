import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Db } from '../src/db/index.js';
import { createBus } from '../src/bus/index.js';
import { makeModelResolver, makeDecisionRecorder } from '../src/llm/index.js';
import { SdkLlmClient, type QueryFn, type SdkMessageLike } from '../src/llm/sdk.js';

/**
 * Regression for the "abandoned SDK stream on mid-stream error" bug: when the
 * consumption loop exits abnormally (e.g. `runOnce` throwing on `m.is_error`
 * mid-loop), the underlying SDK handle must be told to `interrupt()` so its
 * subprocess doesn't keep running for the rest of the turn. Verified via
 * `structured()` (which uses the private `runOnce` path that throws inline on
 * `is_error`) since that's the only call site that throws *inside* the
 * consumption loop body rather than via a rejected `it.next()`.
 */

const OutSchema = z.object({ answer: z.string() });

describe('SdkLlmClient — interrupts the handle on abnormal stream exit', () => {
  it('calls handle.interrupt() when runOnce throws on m.is_error mid-stream', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    const interrupt = vi.fn(async () => undefined);
    let consumedAfterError = false;
    const queryFn: QueryFn = () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkMessageLike> {
        yield { type: 'system', subtype: 'init', session_id: 'prov-x' };
        yield {
          type: 'result',
          subtype: 'error',
          session_id: 'prov-x',
          is_error: true,
          errors: ['boom mid-stream'],
          usage: { input_tokens: 3, output_tokens: 1 },
        };
        // Should never be reached: runOnce throws as soon as it sees is_error,
        // and the generator should be torn down (interrupted) rather than
        // left running to drain the rest of the stream.
        consumedAfterError = true;
        yield { type: 'result', subtype: 'success', is_error: false, result: 'late', session_id: 'prov-x' };
      },
      interrupt,
    });
    const client = new SdkLlmClient({ queryFn, db, modelFor: makeModelResolver(db), record: makeDecisionRecorder(db, bus) });

    await expect(
      client.structured({ task: 'judgment', system: 's', prompt: 'p', schema: OutSchema }),
    ).rejects.toThrow(/boom mid-stream/);

    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(consumedAfterError).toBe(false);
  });

  it('does not call interrupt() on a normal, fully-drained completion', async () => {
    const db = new Db(':memory:');
    const bus = createBus();
    const interrupt = vi.fn(async () => undefined);
    const queryFn: QueryFn = () => ({
      async *[Symbol.asyncIterator](): AsyncGenerator<SdkMessageLike> {
        yield { type: 'system', subtype: 'init', session_id: 'prov-y' };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'prov-y',
          is_error: false,
          result: '{"answer":"ok"}',
          usage: { input_tokens: 3, output_tokens: 1 },
        };
      },
      interrupt,
    });
    const client = new SdkLlmClient({ queryFn, db, modelFor: makeModelResolver(db), record: makeDecisionRecorder(db, bus) });

    const out = await client.structured({ task: 'judgment', system: 's', prompt: 'p', schema: OutSchema });
    expect(out).toEqual({ answer: 'ok' });
    expect(interrupt).not.toHaveBeenCalled();
  });
});
