import type { PendingAction, PendingActionStatus } from '@botty/shared';
import type { Bus } from '../bus/index.js';
import { nowIso, type Db } from '../db/index.js';
import type { McpConnections } from './connections.js';

/**
 * The approval queue for consent-gated external MCP tool calls (mcp.json
 * `mode: action`). The chat model can only enqueue — approve()/dismiss() are
 * the sole paths that ever call connections.callTool() for an action tool
 * (see mcp/tools.ts execute()). Rules: max 10 pending at once, identical
 * (server, tool, args) calls dedup onto the existing row, and pending rows
 * older than 24h are lazily flipped to 'expired' whenever the queue is read.
 */

export const PENDING_ACTIONS_CAP = 10;
export const PENDING_ACTION_TTL_MS = 24 * 60 * 60 * 1000;

export interface EnqueueInput {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  sourceTurnId?: string | null;
}

export type EnqueueOutcome = { action: PendingAction } | { error: string };

/** Result of resolving a specific pending action id (approve/dismiss). */
export type ResolveOutcome =
  | { kind: 'ok'; action: PendingAction }
  | { kind: 'not_found' }
  | { kind: 'not_pending'; action: PendingAction }
  // In-process race guard: an approve() is already running for this id (its
  // callTool await hasn't settled yet). Distinct from 'not_pending' because
  // the DB row is still status='pending' — only the in-memory claim differs.
  | { kind: 'conflict'; detail: string };

export interface PendingActionQueue {
  /** Lazily expires stale rows first, then lists (default status: pending). */
  list(status?: PendingActionStatus): PendingAction[];
  get(id: string): PendingAction | undefined;
  /** Enqueue an action-tool call. Never throws — dedup/cap outcomes come back as data. */
  enqueue(input: EnqueueInput): EnqueueOutcome;
  /** Execute the tool via connections.callTool and resolve to executed/failed. */
  approve(id: string): Promise<ResolveOutcome>;
  dismiss(id: string): ResolveOutcome;
}

export function createPendingActionQueue(deps: { db: Db; bus: Bus; connections: McpConnections }): PendingActionQueue {
  const { db, bus, connections } = deps;

  // Ids with an approve() currently awaiting connections.callTool(). Claimed
  // synchronously (before any await) so two concurrent approves — or an
  // approve racing a dismiss — can never both act on the same id: the
  // external tool call executes at most once. Released in finally.
  const inFlight = new Set<string>();

  function expireStale(now = nowIso()): void {
    const cutoff = new Date(Date.parse(now) - PENDING_ACTION_TTL_MS).toISOString();
    for (const stale of db.stalePendingActions(cutoff)) {
      const resolved = db.resolvePendingAction(stale.id, { status: 'expired', resolvedAt: now, resultJson: null });
      bus.broadcast({ type: 'action.resolved', payload: { action: resolved } });
    }
  }

  return {
    list(status) {
      expireStale();
      return db.listPendingActions(status ?? 'pending');
    },

    get(id) {
      expireStale();
      return db.getPendingAction(id);
    },

    enqueue(input) {
      try {
        expireStale();
        const argsJson = JSON.stringify(input.args ?? {});
        const existing = db.findPendingActionByArgs(input.server, input.tool, argsJson);
        if (existing) return { action: existing };
        if (db.countPendingActionsByStatus('pending') >= PENDING_ACTIONS_CAP) {
          return { error: 'approval queue full — ask the user to review pending actions' };
        }
        const action = db.insertPendingAction({
          server: input.server,
          tool: input.tool,
          argsJson,
          summary: input.summary,
          sourceTurnId: input.sourceTurnId ?? null,
        });
        bus.broadcast({ type: 'action.pending', payload: { action } });
        return { action };
      } catch (err) {
        return { error: (err as Error).message };
      }
    },

    async approve(id) {
      expireStale();
      const action = db.getPendingAction(id);
      if (!action) return { kind: 'not_found' };
      if (action.status !== 'pending') return { kind: 'not_pending', action };
      // Claim synchronously — before the first await — so a second concurrent
      // approve() (or a dismiss()) sees the claim immediately, not after a
      // scheduler hop.
      if (inFlight.has(id)) return { kind: 'conflict', detail: `action ${id} is already being approved` };
      inFlight.add(id);

      try {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(action.argsJson) as Record<string, unknown>;
        } catch {
          /* malformed argsJson (shouldn't happen — we wrote it) → call with {} */
        }
        const result = await connections.callTool(action.server, action.tool, args, { timeoutMs: 30_000 });
        const now = nowIso();
        const resolved =
          'error' in result
            ? db.resolvePendingAction(id, {
                status: 'failed',
                resolvedAt: now,
                resultJson: JSON.stringify({ error: result.error }),
              })
            : db.resolvePendingAction(id, { status: 'executed', resolvedAt: now, resultJson: JSON.stringify(result) });
        bus.broadcast({ type: 'action.resolved', payload: { action: resolved } });
        return { kind: 'ok', action: resolved };
      } finally {
        inFlight.delete(id);
      }
    },

    dismiss(id) {
      expireStale();
      const action = db.getPendingAction(id);
      if (!action) return { kind: 'not_found' };
      if (action.status !== 'pending') return { kind: 'not_pending', action };
      // Refuse rather than resolve out from under an in-flight approve() —
      // otherwise the row would broadcast 'dismissed' while the external
      // tool call is still executing and later overwrites it to 'executed'.
      if (inFlight.has(id)) return { kind: 'conflict', detail: `action ${id} is being approved` };
      const resolved = db.resolvePendingAction(id, { status: 'dismissed', resolvedAt: nowIso(), resultJson: null });
      bus.broadcast({ type: 'action.resolved', payload: { action: resolved } });
      return { kind: 'ok', action: resolved };
    },
  };
}
