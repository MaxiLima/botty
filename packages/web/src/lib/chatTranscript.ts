// Pure transcript-reducing logic for ChatPage — kept separate from the React
// component so turn reconciliation and seam placement are unit-testable
// without a DOM harness. Mirrors packages/tui/src/transcript.ts, which is
// the reference implementation for the equivalent TUI behavior.
import type { ChatTurn } from '@botty/shared';

/** Prefix marking a turn as our own optimistic echo, not yet confirmed by the server. */
export const LOCAL_TURN_PREFIX = 'local-';

let localCounter = 0;

export function isLocalTurnId(id: string): boolean {
  return id.startsWith(LOCAL_TURN_PREFIX);
}

export function isLocalTurn(turn: ChatTurn): boolean {
  return isLocalTurnId(turn.id);
}

/**
 * Build the optimistic user turn `send()` appends immediately, before the
 * POST resolves. `sessionId` is the last *known* session, or null for a
 * brand-new session — either way it's provisional: the server is the only
 * authority on session id, and `withSeams` below never trusts it from a
 * local turn.
 */
export function createLocalUserTurn(params: {
  text: string;
  meta: Record<string, unknown> | null;
  sessionId: string | null;
  now?: string;
}): ChatTurn {
  return {
    id: `${LOCAL_TURN_PREFIX}${Date.now()}-${localCounter++}`,
    sessionId: params.sessionId ?? 'local',
    role: 'user',
    content: params.text,
    meta: params.meta,
    createdAt: params.now ?? new Date().toISOString(),
  };
}

/**
 * Merge freshly fetched turns that are newer than (or overlap the end of)
 * `prev` — used for the tail refetch that adopts foreign turns, and for the
 * turn `chat.done` carries. Two things beyond plain id-dedup:
 *
 *  1. A fetched **user** turn whose content matches an outstanding local
 *     echo (see `createLocalUserTurn`) *replaces* that echo in place, rather
 *     than appending a second copy — the server turn is authoritative (real
 *     id, real sessionId), the echo was only ever a stand-in.
 *  2. Each local echo is consumed at most once, in the order fetched turns
 *     arrive, so two genuinely distinct sends with identical text each
 *     reconcile against their own echo instead of collapsing into one.
 *
 * A fetched turn that doesn't match any outstanding echo (a foreign turn
 * from the TUI, quick-capture, Telegram, or our own assistant reply) is
 * simply appended.
 */
export function mergeNewerTurns(prev: ChatTurn[], incoming: ChatTurn[]): ChatTurn[] {
  const known = new Set(prev.map((t) => t.id));
  const fresh = incoming.filter((t) => !known.has(t.id));
  if (fresh.length === 0) return prev;

  const next = [...prev];
  const consumed = new Set<string>();
  for (const turn of fresh) {
    const matchIdx =
      turn.role === 'user'
        ? next.findIndex(
            (t) => isLocalTurn(t) && !consumed.has(t.id) && t.role === 'user' && t.content === turn.content,
          )
        : -1;
    if (matchIdx === -1) {
      next.push(turn);
      continue;
    }
    consumed.add(next[matchIdx]!.id);
    next[matchIdx] = turn;
  }
  return next;
}

/**
 * Merge an older page of history (`loadEarlier`) in front of `prev`. Local
 * echoes are always the newest thing in state, so there's nothing to
 * reconcile here — just id-dedup, same as the TUI's `takeUnseen`.
 */
export function mergeOlderTurns(prev: ChatTurn[], incoming: ChatTurn[]): ChatTurn[] {
  const known = new Set(prev.map((t) => t.id));
  const fresh = incoming.filter((t) => !known.has(t.id));
  return fresh.length > 0 ? [...fresh, ...prev] : prev;
}

/**
 * A context break is a *real* session change between two confirmed turns —
 * mirrors the TUI's `lastSessionRef.current !== null && turn.sessionId !==
 * lastSessionRef.current` in App.tsx. `null` means "no confirmed turn seen
 * yet", so the very first turn never draws a seam.
 */
export function shouldRenderSeam(prevSessionId: string | null, sessionId: string): boolean {
  return prevSessionId !== null && sessionId !== prevSessionId;
}

export interface SeamedTurn {
  turn: ChatTurn;
  /** True if a session-break seam belongs immediately before this turn. */
  seamBefore: boolean;
}

/**
 * Walk `turns` deciding where seams belong. Local echoes are skipped for
 * this purpose on both sides of the comparison: they carry a provisional
 * sessionId (see `createLocalUserTurn`) that isn't the real session id for
 * a brand-new session, so trusting it would draw a spurious seam the moment
 * the real, server-confirmed turn lands right after it — exactly the "seam
 * after the first message of every session" bug. An echo never itself gets
 * a seam either; once it's reconciled (`mergeNewerTurns`) into the real
 * turn, that real turn is what the seam decision sees.
 */
export function withSeams(turns: ChatTurn[]): SeamedTurn[] {
  const out: SeamedTurn[] = [];
  let prevSession: string | null = null;
  for (const turn of turns) {
    if (isLocalTurn(turn)) {
      out.push({ turn, seamBefore: false });
      continue;
    }
    out.push({ turn, seamBefore: shouldRenderSeam(prevSession, turn.sessionId) });
    prevSession = turn.sessionId;
  }
  return out;
}

/** Everything `shouldAdoptForeignTurn` needs to know to decide. */
export interface AdoptGuardState {
  /** Last turnId a tail refetch was already scheduled for. */
  lastAdoptedTurnId: string | null;
  /** True while our own POST /chat/message is in flight. */
  sending: boolean;
  /** turnId of the currently-streaming pending reply, if any. */
  pendingTurnId: string | null;
  /** turnIds whose stream already finished (done/error). */
  finishedTurnIds: ReadonlySet<string>;
}

/**
 * Decide whether a stream event for `turnId` means "a client we don't have
 * a local echo for started this turn" and therefore warrants a tail
 * refetch to adopt it. Mirrors ChatPage's `adopt()` guard sequence 1:1.
 */
export function shouldAdoptForeignTurn(turnId: string, state: AdoptGuardState): boolean {
  if (state.lastAdoptedTurnId === turnId) return false;
  if (state.sending) return false;
  if (state.pendingTurnId === turnId) return false;
  if (state.finishedTurnIds.has(turnId)) return false;
  return true;
}
