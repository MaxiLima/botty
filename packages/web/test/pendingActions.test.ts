import { describe, expect, it } from 'vitest';
import type { PendingAction } from '@botty/shared';
import { addPendingAction, hydratePendingActions, resolvePendingAction } from '../src/lib/pendingActions.js';

const action = (id: string, overrides: Partial<PendingAction> = {}): PendingAction => ({
  id,
  server: 'slack',
  tool: 'send_message',
  argsJson: '{"channel":"#general","text":"hi"}',
  summary: `send a slack message (${id})`,
  status: 'pending',
  createdAt: `2026-07-09T00:00:0${id.length}.000Z`,
  resolvedAt: null,
  resultJson: null,
  sourceTurnId: null,
  ...overrides,
});

describe('hydratePendingActions', () => {
  it('adds unseen fetched entries to an empty list', () => {
    const a = action('a');
    const b = action('bb');
    expect(hydratePendingActions([], [a, b]).map((x) => x.id)).toEqual(['a', 'bb']);
  });

  it('merges fetched entries without dropping cards the client already resolved', () => {
    const resolved = action('a', { status: 'executed', resultJson: '{"ok":true}' });
    // Server's pending-only fetch no longer includes 'a' (it's terminal now) — keep it anyway.
    const fetched = [action('bb')];
    const next = hydratePendingActions([resolved], fetched);
    expect(next.map((x) => x.id)).toEqual(['a', 'bb']);
    expect(next.find((x) => x.id === 'a')?.status).toBe('executed');
  });

  it('lets a fresh fetch refresh an entry the client already has', () => {
    const stale = action('a', { summary: 'stale summary' });
    const fresh = action('a', { summary: 'fresh summary' });
    const next = hydratePendingActions([stale], [fresh]);
    expect(next).toHaveLength(1);
    expect(next[0]?.summary).toBe('fresh summary');
  });

  it('sorts the merged result by createdAt', () => {
    const later = action('bb', { createdAt: '2026-07-09T01:00:00.000Z' });
    const earlier = action('a', { createdAt: '2026-07-09T00:00:00.000Z' });
    expect(hydratePendingActions([], [later, earlier]).map((x) => x.id)).toEqual(['a', 'bb']);
  });
});

describe('addPendingAction', () => {
  it('appends a new card', () => {
    const next = addPendingAction([action('a')], action('bb'));
    expect(next.map((x) => x.id)).toEqual(['a', 'bb']);
  });

  it('dedupes by id — a duplicate action.pending delivery is a no-op', () => {
    const first = [action('a')];
    const next = addPendingAction(first, action('a', { summary: 'different summary' }));
    expect(next).toBe(first);
    expect(next[0]?.summary).not.toBe('different summary');
  });
});

describe('resolvePendingAction', () => {
  it('updates the matching card in place, keeping the rest untouched', () => {
    const list = [action('a'), action('bb')];
    const resolved = action('a', { status: 'executed', resolvedAt: '2026-07-09T00:05:00.000Z', resultJson: '{"ok":true}' });
    const next = resolvePendingAction(list, resolved);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(resolved);
    expect(next[1]).toEqual(list[1]);
  });

  it('inserts the card if action.resolved races ahead of action.pending', () => {
    const next = resolvePendingAction([], action('a', { status: 'dismissed' }));
    expect(next.map((x) => x.id)).toEqual(['a']);
    expect(next[0]?.status).toBe('dismissed');
  });

  it('keeps dismissed and expired terminal states distinguishable', () => {
    const list = [action('a')];
    const dismissed = resolvePendingAction(list, action('a', { status: 'dismissed' }));
    expect(dismissed[0]?.status).toBe('dismissed');
    const expired = resolvePendingAction(list, action('a', { status: 'expired' }));
    expect(expired[0]?.status).toBe('expired');
  });
});
