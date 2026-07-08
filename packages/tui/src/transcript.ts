import type { ChatTurn } from '@botty/shared';

/** Live (streaming) assistant reply — mirrors the web app's PendingTurn. */
export interface PendingTurn {
  turnId: string;
  text: string;
  thinking: boolean;
  /** One line per chat.toolUse event, e.g. "read_file — package.json". */
  tools: string[];
}

export function newPending(turnId: string, thinking = false): PendingTurn {
  return { turnId, text: '', thinking, tools: [] };
}

/**
 * The server streams events for replies other clients triggered too; adopt a
 * stream for an unknown turnId instead of ignoring it (the TUI is a window
 * onto the same session as the browser). The adopt rule lives only here.
 */
function ensure(prev: PendingTurn | null, turnId: string): PendingTurn {
  return prev && prev.turnId === turnId ? prev : newPending(turnId);
}

export function applyChunk(prev: PendingTurn | null, turnId: string, delta: string): PendingTurn {
  const p = ensure(prev, turnId);
  return { ...p, text: p.text + delta, thinking: false };
}

export function applyThinking(prev: PendingTurn | null, turnId: string, on: boolean): PendingTurn | null {
  // A trailing "thinking off" for a turn we're not tracking would materialize
  // an empty ghost reply block — only adopt on positive signals.
  if (!on && (!prev || prev.turnId !== turnId)) return prev;
  const p = ensure(prev, turnId);
  return { ...p, thinking: on };
}

export function applyToolUse(prev: PendingTurn | null, turnId: string, name: string, summary?: string): PendingTurn {
  const p = ensure(prev, turnId);
  return { ...p, thinking: false, tools: [...p.tools, summary ? `${name} — ${summary}` : name] };
}

/**
 * History pages are ascending and consistent supersets of each other, so
 * filtering out already-printed ids keeps the append-only transcript ordered.
 * Marks returned ids as seen.
 */
export function takeUnseen(seen: Set<string>, turns: ChatTurn[]): ChatTurn[] {
  const fresh: ChatTurn[] = [];
  for (const t of turns) {
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    fresh.push(t);
  }
  return fresh;
}
