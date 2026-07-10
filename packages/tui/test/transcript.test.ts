import { describe, expect, it } from 'vitest';
import type { ChatTurn, PendingActionStatus } from '@botty/shared';
import {
  applyChunk,
  applyThinking,
  applyToolUse,
  formatApprovalPendingLine,
  formatApprovalResolvedLine,
  newPending,
  normalizePastedInput,
  takeUnseen,
} from '../src/transcript.js';

const turn = (id: string): ChatTurn => ({
  id,
  sessionId: 's1',
  role: 'user',
  content: id,
  meta: null,
  createdAt: '2026-07-06T00:00:00.000Z',
});

describe('pending reducers', () => {
  it('accumulates chunks for the same turn and clears thinking', () => {
    let p = applyThinking(null, 't1', true);
    expect(p?.thinking).toBe(true);
    p = applyChunk(p, 't1', 'Hel');
    p = applyChunk(p, 't1', 'lo');
    expect(p.text).toBe('Hello');
    expect(p.thinking).toBe(false);
  });

  it('adopts a stream for an unknown turnId instead of dropping it', () => {
    const mine = newPending('t1', true);
    const p = applyChunk(mine, 't2', 'other client reply');
    expect(p.turnId).toBe('t2');
    expect(p.text).toBe('other client reply');
  });

  it('does not materialize a ghost block from a trailing thinking-off', () => {
    expect(applyThinking(null, 't9', false)).toBeNull();
    const mine = newPending('t1');
    expect(applyThinking(mine, 't9', false)).toBe(mine);
    // A positive thinking-on still adopts.
    expect(applyThinking(null, 't9', true)?.turnId).toBe('t9');
  });

  it('collects one line per tool-use event', () => {
    let p = newPending('t1');
    p = applyToolUse(p, 't1', 'read_file', 'package.json');
    p = applyToolUse(p, 't1', 'grep');
    expect(p.tools).toEqual(['read_file — package.json', 'grep']);
  });
});

describe('formatApprovalPendingLine', () => {
  it('renders the inline approval-needed notice', () => {
    expect(formatApprovalPendingLine('send a slack message to #general')).toBe(
      'botty ⧗ approval needed: send a slack message to #general — approve in the web app',
    );
  });
});

describe('formatApprovalResolvedLine', () => {
  it('renders a distinct short line per terminal status', () => {
    const cases: [PendingActionStatus, string][] = [
      ['executed', '✓ executed — send a slack message'],
      ['failed', '✗ failed — send a slack message'],
      ['dismissed', '· dismissed — send a slack message'],
      ['expired', '· expired — send a slack message'],
    ];
    for (const [status, expected] of cases) {
      expect(formatApprovalResolvedLine(status, 'send a slack message')).toBe(expected);
    }
  });
});

describe('normalizePastedInput', () => {
  it('leaves single-line text untouched', () => {
    expect(normalizePastedInput("what's on my plate today?")).toBe("what's on my plate today?");
  });

  it('replaces a pasted newline with a visible marker so the composer stays single-line', () => {
    expect(normalizePastedInput('line one\nline two')).toBe('line one⏎ line two');
  });

  it('handles CRLF and lone CR the same way as LF', () => {
    expect(normalizePastedInput('a\r\nb')).toBe('a⏎ b');
    expect(normalizePastedInput('a\rb')).toBe('a⏎ b');
  });

  it('collapses a multi-line paste to one visible line', () => {
    expect(normalizePastedInput('one\ntwo\nthree')).toBe('one⏎ two⏎ three');
  });
});

describe('takeUnseen', () => {
  it('returns only unseen turns and marks them seen', () => {
    const seen = new Set<string>();
    expect(takeUnseen(seen, [turn('a'), turn('b')]).map((t) => t.id)).toEqual(['a', 'b']);
    // A later, larger page (histories are ascending supersets) adds only the tail.
    expect(takeUnseen(seen, [turn('a'), turn('b'), turn('c')]).map((t) => t.id)).toEqual(['c']);
    expect(takeUnseen(seen, [turn('c')])).toEqual([]);
  });
});
