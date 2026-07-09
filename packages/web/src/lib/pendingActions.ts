// Pure reducer logic for the pending-actions (consent-gated external tool
// calls) store — kept separate from the useSyncExternalStore wiring in
// stores.ts so the list transitions are unit-testable without a DOM harness.
import type { PendingAction } from '@botty/shared';

function byCreatedAt(a: PendingAction, b: PendingAction): number {
  return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
}

/**
 * Merge a freshly fetched `?status=pending` page into the current list.
 * Fetched entries add/refresh by id; anything the client already knows
 * about (including cards resolved locally via WS or a POST response) is
 * kept even if the fetch — pending-only — no longer includes it, so a
 * resolved card never vanishes from the session on reconnect.
 */
export function hydratePendingActions(current: PendingAction[], fetched: PendingAction[]): PendingAction[] {
  const byId = new Map(current.map((a) => [a.id, a]));
  for (const a of fetched) byId.set(a.id, a);
  return [...byId.values()].sort(byCreatedAt);
}

/** `action.pending` — add a new card, deduped by id (idempotent on replay/dupe delivery). */
export function addPendingAction(current: PendingAction[], action: PendingAction): PendingAction[] {
  if (current.some((a) => a.id === action.id)) return current;
  return [...current, action].sort(byCreatedAt);
}

/**
 * `action.resolved` (or a direct POST response) — update the matching card
 * in place with its terminal state. Falls back to inserting the card if it
 * arrives before the client ever saw `action.pending` for it.
 */
export function resolvePendingAction(current: PendingAction[], action: PendingAction): PendingAction[] {
  const idx = current.findIndex((a) => a.id === action.id);
  if (idx === -1) return [...current, action].sort(byCreatedAt);
  const next = current.slice();
  next[idx] = action;
  return next;
}
