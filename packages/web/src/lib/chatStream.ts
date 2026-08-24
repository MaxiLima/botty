// Pure reducer for ChatPage's "pending" (currently-streaming assistant turn)
// state, kept separate from the React component so it's unit-testable
// without a DOM harness — mirrors chatTranscript.ts (turn history) and
// packages/tui/src/transcript.ts (the equivalent TUI logic).
//
// The server queues chat turns strictly in order (packages/agent/src/chat/
// index.ts's queueTurn): `POST /chat/message` inserts the user turn and
// returns a turnId synchronously, but the assistant's run for that turn may
// sit behind an earlier one still streaming. That's what makes `reducer`
// safe to call from a second/third in-flight send: a stream event for a turn
// OTHER than the one currently pending is left alone rather than dropped or
// used to clobber the active turn's state, because the server can't
// legitimately be running two turns at once — the "other" turn's own events
// self-initialize `pending` once it actually starts, right after the current
// one's chat.done/chat.error clears it to null.

export interface PendingTurn {
  turnId: string;
  text: string;
  thinking: boolean;
  tool: string | null;
}

export type ChatStreamEvent =
  | { kind: 'chunk'; turnId: string; delta: string }
  | { kind: 'thinking'; turnId: string; on: boolean }
  | { kind: 'toolUse'; turnId: string; name: string; summary?: string };

function toolLabel(name: string, summary?: string): string {
  return summary ? `${name} — ${summary}` : name;
}

/**
 * chat.chunk / chat.thinking / chat.toolUse: update the matching pending
 * turn in place, ignore events for a different turn while one is active, and
 * self-initialize `pending` for an event that arrived with none yet —
 * unless that turn already finished (its chat.done/chat.error beat this
 * event, e.g. reordered delivery), in which case do nothing.
 */
export function reducePendingStream(
  prev: PendingTurn | null,
  event: ChatStreamEvent,
  finishedTurnIds: ReadonlySet<string>,
): PendingTurn | null {
  if (prev) {
    if (prev.turnId !== event.turnId) return prev;
    switch (event.kind) {
      case 'chunk':
        return { ...prev, text: prev.text + event.delta, thinking: false };
      case 'thinking':
        return { ...prev, thinking: event.on };
      case 'toolUse':
        return { ...prev, tool: toolLabel(event.name, event.summary) };
    }
  }
  if (finishedTurnIds.has(event.turnId)) return prev;
  switch (event.kind) {
    case 'chunk':
      return { turnId: event.turnId, text: event.delta, thinking: false, tool: null };
    case 'thinking':
      return { turnId: event.turnId, text: '', thinking: event.on, tool: null };
    case 'toolUse':
      return { turnId: event.turnId, text: '', thinking: false, tool: toolLabel(event.name, event.summary) };
  }
}

/** chat.done: clears pending only if it's this turn's — a different turn may
 * already be the active `pending` (queued send). The turn's text lands via
 * the caller's own turns-merge regardless of which turn was pending. */
export function reducePendingOnDone(prev: PendingTurn | null, turnId: string): PendingTurn | null {
  return prev && prev.turnId !== turnId ? prev : null;
}

/** chat.error: same clearing rule as chat.done — the agent never sends a
 * chat.done after a chat.error for the same turn. */
export function reducePendingOnError(prev: PendingTurn | null, turnId: string): PendingTurn | null {
  return prev && prev.turnId !== turnId ? prev : null;
}

/**
 * Called right after `send()`'s POST resolves with a turnId. If some OTHER
 * turn is already pending (still streaming, or just queued ahead of this
 * one), leave it alone — this turnId hasn't started server-side yet, so
 * initializing `pending` for it here would point the "thinking…" indicator
 * at a turn with no events, while the real in-flight turn's chunks keep
 * arriving with a turnId `reducePendingStream` would then ignore. Once the
 * server actually starts this turn (right after the current one's
 * chat.done/chat.error clears `pending` to null), its own first stream event
 * self-initializes it via the `finishedTurnIds` branch above.
 */
export function reducePendingOnSend(
  prev: PendingTurn | null,
  turnId: string,
  finishedTurnIds: ReadonlySet<string>,
): PendingTurn | null {
  if (prev) return prev;
  if (finishedTurnIds.has(turnId)) return prev;
  return { turnId, text: '', thinking: true, tool: null };
}
