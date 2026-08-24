import { describe, expect, it } from 'vitest';
import {
  reducePendingOnDone,
  reducePendingOnError,
  reducePendingOnSend,
  reducePendingStream,
  type PendingTurn,
} from '../src/lib/chatStream.js';

const T1 = 'turn-1';
const T2 = 'turn-2';
const noneFinished = new Set<string>();

describe('reducePendingStream', () => {
  it('self-initializes on a chunk when nothing is pending yet', () => {
    const next = reducePendingStream(null, { kind: 'chunk', turnId: T1, delta: 'hi' }, noneFinished);
    expect(next).toEqual({ turnId: T1, text: 'hi', thinking: false, tool: null });
  });

  it('self-initializes on a thinking event', () => {
    const next = reducePendingStream(null, { kind: 'thinking', turnId: T1, on: true }, noneFinished);
    expect(next).toEqual({ turnId: T1, text: '', thinking: true, tool: null });
  });

  it('self-initializes on a toolUse event, formatting name + summary', () => {
    const next = reducePendingStream(
      null,
      { kind: 'toolUse', turnId: T1, name: 'search_tasks', summary: 'open tasks' },
      noneFinished,
    );
    expect(next).toEqual({ turnId: T1, text: '', thinking: false, tool: 'search_tasks — open tasks' });
  });

  it('toolUse with no summary uses the bare tool name', () => {
    const next = reducePendingStream(null, { kind: 'toolUse', turnId: T1, name: 'search_tasks' }, noneFinished);
    expect(next?.tool).toBe('search_tasks');
  });

  it('does not resurrect a turn whose chat.done/chat.error already landed', () => {
    const finished = new Set([T1]);
    const next = reducePendingStream(null, { kind: 'chunk', turnId: T1, delta: 'late' }, finished);
    expect(next).toBeNull();
  });

  it('appends chunks to the matching pending turn and clears `thinking`', () => {
    const prev: PendingTurn = { turnId: T1, text: 'Hel', thinking: true, tool: null };
    const next = reducePendingStream(prev, { kind: 'chunk', turnId: T1, delta: 'lo' }, noneFinished);
    expect(next).toEqual({ turnId: T1, text: 'Hello', thinking: false, tool: null });
  });

  it('updates thinking/tool in place for the matching turn', () => {
    const prev: PendingTurn = { turnId: T1, text: '', thinking: false, tool: null };
    expect(reducePendingStream(prev, { kind: 'thinking', turnId: T1, on: true }, noneFinished)?.thinking).toBe(true);
    const withTool = reducePendingStream(prev, { kind: 'toolUse', turnId: T1, name: 'x' }, noneFinished);
    expect(withTool?.tool).toBe('x');
  });

  it('leaves a DIFFERENT turn\'s pending state alone — the server runs turns strictly in order', () => {
    const prev: PendingTurn = { turnId: T1, text: 'streaming…', thinking: false, tool: null };
    const next = reducePendingStream(prev, { kind: 'chunk', turnId: T2, delta: 'ignored' }, noneFinished);
    expect(next).toBe(prev);
  });
});

describe('reducePendingOnDone / reducePendingOnError', () => {
  it('clears pending when it matches the finishing turn', () => {
    const prev: PendingTurn = { turnId: T1, text: 'x', thinking: false, tool: null };
    expect(reducePendingOnDone(prev, T1)).toBeNull();
    expect(reducePendingOnError(prev, T1)).toBeNull();
  });

  it('leaves a different (queued-next) turn\'s pending state untouched', () => {
    const prev: PendingTurn = { turnId: T2, text: 'next turn', thinking: true, tool: null };
    expect(reducePendingOnDone(prev, T1)).toBe(prev);
    expect(reducePendingOnError(prev, T1)).toBe(prev);
  });

  it('is a no-op when nothing is pending', () => {
    expect(reducePendingOnDone(null, T1)).toBeNull();
    expect(reducePendingOnError(null, T1)).toBeNull();
  });
});

describe('reducePendingOnSend', () => {
  it('initializes pending for a fresh send with nothing else in flight', () => {
    const next = reducePendingOnSend(null, T1, noneFinished);
    expect(next).toEqual({ turnId: T1, text: '', thinking: true, tool: null });
  });

  it('does not resurrect a turn that already finished before the POST resolved', () => {
    const finished = new Set([T1]);
    expect(reducePendingOnSend(null, T1, finished)).toBeNull();
  });

  it('does not clobber an already-pending turn when a second message is sent while streaming', () => {
    // This is the queuing fix: the server processes turns strictly in order
    // (chat/index.ts's queueTurn), so turn 2 hasn't started yet when its
    // POST resolves — initializing `pending` for it here would point the UI
    // at a turn with no events while turn 1's real chunks keep arriving.
    const prev: PendingTurn = { turnId: T1, text: 'still going', thinking: false, tool: null };
    expect(reducePendingOnSend(prev, T2, noneFinished)).toBe(prev);
  });
});
