import { describe, expect, it } from 'vitest';
import type { ChatTurn } from '@botty/shared';
import {
  createLocalUserTurn,
  isLocalTurnId,
  mergeNewerTurns,
  mergeOlderTurns,
  shouldAdoptForeignTurn,
  shouldRenderSeam,
  withSeams,
} from '../src/lib/chatTranscript.js';

const turn = (id: string, overrides: Partial<ChatTurn> = {}): ChatTurn => ({
  id,
  sessionId: 's1',
  role: 'user',
  content: id,
  meta: null,
  createdAt: '2026-07-06T00:00:00.000Z',
  ...overrides,
});

describe('createLocalUserTurn / isLocalTurnId', () => {
  it('marks its own turns as local', () => {
    const t = createLocalUserTurn({ text: 'hi', meta: null, sessionId: 's1' });
    expect(isLocalTurnId(t.id)).toBe(true);
    expect(t.role).toBe('user');
    expect(t.content).toBe('hi');
    expect(t.sessionId).toBe('s1');
  });

  it('falls back to a provisional session marker when the session is unknown', () => {
    const t = createLocalUserTurn({ text: 'hi', meta: null, sessionId: null });
    expect(isLocalTurnId(t.id)).toBe(true);
    expect(t.sessionId).not.toBe('s1');
  });

  it('does not flag a real turn id as local', () => {
    expect(isLocalTurnId('abc123')).toBe(false);
  });
});

describe('mergeNewerTurns', () => {
  it('reconciles a local echo with the same turn arriving over WS into a single entry', () => {
    const local = createLocalUserTurn({ text: 'hello', meta: null, sessionId: null });
    const prev = [local];
    const real = turn('server-1', { content: 'hello', sessionId: 'sess-a' });

    const next = mergeNewerTurns(prev, [real]);

    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(real);
  });

  it('adopts a foreign turn with no local echo as a single entry', () => {
    const prev = [turn('a', { content: 'earlier' })];
    const foreign = turn('foreign-1', { content: 'sent from the TUI' });

    const next = mergeNewerTurns(prev, [foreign]);

    expect(next.map((t) => t.id)).toEqual(['a', 'foreign-1']);
  });

  it('keeps two genuinely distinct turns with identical text as two entries', () => {
    const local1 = createLocalUserTurn({ text: 'same text', meta: null, sessionId: 's1' });
    const local2 = createLocalUserTurn({ text: 'same text', meta: null, sessionId: 's1' });
    const prev = [local1, local2];
    const real1 = turn('server-1', { content: 'same text', sessionId: 's1' });
    const real2 = turn('server-2', { content: 'same text', sessionId: 's1' });

    const next = mergeNewerTurns(prev, [real1, real2]);

    expect(next).toHaveLength(2);
    expect(next.map((t) => t.id)).toEqual(['server-1', 'server-2']);
  });

  it('does not duplicate when streamed assistant chunks are followed by the final turn', () => {
    // The assistant's PendingRow is never added to `turns` — only chat.done's
    // turn is. A second chat.done for the same turnId (e.g. a replay) must
    // not double it.
    const prev: ChatTurn[] = [];
    const final = turn('assistant-1', { role: 'assistant', content: 'the reply' });

    let next = mergeNewerTurns(prev, [final]);
    expect(next).toHaveLength(1);

    next = mergeNewerTurns(next, [final]);
    expect(next).toHaveLength(1);
    expect(next[0]).toEqual(final);
  });

  it('an unmatched local echo is left in place until its real turn arrives', () => {
    const local = createLocalUserTurn({ text: 'still pending', meta: null, sessionId: 's1' });
    const prev = [local];

    const next = mergeNewerTurns(prev, [turn('other', { content: 'unrelated' })]);

    expect(next.map((t) => t.id)).toEqual([local.id, 'other']);
  });

  it('returns the same array reference when nothing new arrives', () => {
    const prev = [turn('a')];
    expect(mergeNewerTurns(prev, [turn('a')])).toBe(prev);
  });
});

describe('mergeOlderTurns', () => {
  it('prepends unseen turns and dedupes by id', () => {
    const prev = [turn('b'), turn('c')];
    const next = mergeOlderTurns(prev, [turn('a'), turn('b')]);
    expect(next.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns the same array reference when nothing new arrives', () => {
    const prev = [turn('a')];
    expect(mergeOlderTurns(prev, [turn('a')])).toBe(prev);
  });
});

describe('shouldRenderSeam', () => {
  it('never seams the first confirmed turn', () => {
    expect(shouldRenderSeam(null, 'sess-a')).toBe(false);
  });

  it('seams a real session change', () => {
    expect(shouldRenderSeam('sess-a', 'sess-b')).toBe(true);
  });

  it('does not seam within the same session', () => {
    expect(shouldRenderSeam('sess-a', 'sess-a')).toBe(false);
  });
});

describe('withSeams', () => {
  it('does not render a seam after the first message of a fresh session', () => {
    // The optimistic echo carries a provisional sessionId (unknown session,
    // brand-new chat) that doesn't match the real session id the confirmed
    // assistant turn lands with.
    const local = createLocalUserTurn({ text: 'hi', meta: null, sessionId: null });
    const reply = turn('assistant-1', { role: 'assistant', content: 'hello!', sessionId: 'sess-new' });

    const result = withSeams([local, reply]);

    expect(result.map((r) => r.seamBefore)).toEqual([false, false]);
  });

  it('renders a seam on a real context break', () => {
    const t1 = turn('a', { sessionId: 'sess-a' });
    const t2 = turn('b', { sessionId: 'sess-b' });

    const result = withSeams([t1, t2]);

    expect(result.map((r) => r.seamBefore)).toEqual([false, true]);
  });

  it('never puts a seam before a local echo, even mid-transcript', () => {
    const t1 = turn('a', { sessionId: 'sess-a' });
    const local = createLocalUserTurn({ text: 'new message', meta: null, sessionId: 'sess-a' });

    const result = withSeams([t1, local]);

    expect(result.map((r) => r.seamBefore)).toEqual([false, false]);
  });
});

describe('shouldAdoptForeignTurn', () => {
  const base = { lastAdoptedTurnId: null, sending: false, pendingTurnId: null, finishedTurnIds: new Set<string>() };

  it('adopts an unknown turn by default', () => {
    expect(shouldAdoptForeignTurn('t1', base)).toBe(true);
  });

  it('does not re-trigger for a turn already adopted', () => {
    expect(shouldAdoptForeignTurn('t1', { ...base, lastAdoptedTurnId: 't1' })).toBe(false);
  });

  it('skips while our own send is in flight', () => {
    expect(shouldAdoptForeignTurn('t1', { ...base, sending: true })).toBe(false);
  });

  it('skips a turn already tracked as pending', () => {
    expect(shouldAdoptForeignTurn('t1', { ...base, pendingTurnId: 't1' })).toBe(false);
  });

  it('skips a turn that already finished', () => {
    expect(shouldAdoptForeignTurn('t1', { ...base, finishedTurnIds: new Set(['t1']) })).toBe(false);
  });
});
