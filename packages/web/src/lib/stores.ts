import { useSyncExternalStore } from 'react';
import type { PendingAction } from '@botty/shared';
import { api } from './api.js';
import { addPendingAction, hydratePendingActions, resolvePendingAction } from './pendingActions.js';
import { onWsEvent, useOnReconnect } from './ws.js';

// ---------- Notifications (chat cards + sidebar badge) ----------

export interface NotificationItem {
  id: string;
  taskId: string | null;
  kind: string;
  message: string;
  score: number | null;
  receivedAt: string;
  seen: boolean;
  /** Set locally after the user acts on the card. */
  resolved?: 'done' | 'snoozed' | 'dismissed' | 'reopened';
}

let notifications: NotificationItem[] = [];
const notifSubs = new Set<() => void>();

function emitNotif(): void {
  for (const cb of notifSubs) cb();
}

export function useNotifications(): NotificationItem[] {
  return useSyncExternalStore(
    (cb) => {
      notifSubs.add(cb);
      return () => notifSubs.delete(cb);
    },
    () => notifications,
  );
}

export function useUnseenNotificationCount(): number {
  return useSyncExternalStore(
    (cb) => {
      notifSubs.add(cb);
      return () => notifSubs.delete(cb);
    },
    () => notifications.reduce((acc, x) => acc + (x.seen ? 0 : 1), 0),
  );
}

export function markNotificationsSeen(): void {
  if (notifications.every((n) => n.seen)) return;
  notifications = notifications.map((n) => (n.seen ? n : { ...n, seen: true }));
  emitNotif();
}

export function resolveNotification(id: string, resolved: NotificationItem['resolved']): void {
  notifications = notifications.map((n) => (n.id === id ? { ...n, resolved } : n));
  emitNotif();
}

// ---------- Pending actions (consent-gated external tool approvals) ----------

let pendingActions: PendingAction[] = [];
const pendingActionsSubs = new Set<() => void>();

function emitPendingActions(): void {
  for (const cb of pendingActionsSubs) cb();
}

export function usePendingActions(): PendingAction[] {
  return useSyncExternalStore(
    (cb) => {
      pendingActionsSubs.add(cb);
      return () => pendingActionsSubs.delete(cb);
    },
    () => pendingActions,
  );
}

export function usePendingActionCount(): number {
  return useSyncExternalStore(
    (cb) => {
      pendingActionsSubs.add(cb);
      return () => pendingActionsSubs.delete(cb);
    },
    () => pendingActions.reduce((acc, a) => acc + (a.status === 'pending' ? 1 : 0), 0),
  );
}

/** Apply a resolved/executed/failed action straight from a POST response — idempotent with the WS event. */
export function applyResolvedAction(action: PendingAction): void {
  pendingActions = resolvePendingAction(pendingActions, action);
  emitPendingActions();
}

async function refetchPendingActions(): Promise<void> {
  try {
    const { actions } = await api.actions('pending');
    pendingActions = hydratePendingActions(pendingActions, actions);
    emitPendingActions();
  } catch {
    // agent unreachable — leave stale list
  }
}

// ---------- Open task count (sidebar badge) ----------

let openCount: number | null = null;
const countSubs = new Set<() => void>();
/** Bumped by any fresher open-count source (a `tasks.updated` snapshot, or a
 * newer refetch) so a slower in-flight `refetchOpenCount` can detect it was
 * superseded and skip applying its now-stale result. */
let openCountToken = 0;

function setOpenCount(n: number): void {
  if (openCount === n) return;
  openCount = n;
  for (const cb of countSubs) cb();
}

export function useOpenTaskCount(): number | null {
  return useSyncExternalStore(
    (cb) => {
      countSubs.add(cb);
      return () => countSubs.delete(cb);
    },
    () => openCount,
  );
}

async function refetchOpenCount(): Promise<void> {
  const token = ++openCountToken;
  try {
    const { tasks } = await api.tasks('open');
    // A newer tasks.updated snapshot (or a newer refetch) landed while this
    // request was in flight — its result is stale, don't clobber the newer one.
    if (token !== openCountToken) return;
    setOpenCount(tasks.length);
  } catch {
    // agent unreachable — leave stale count
  }
}

/** Hook the badge/action stores refetch to WS reconnects (call once, from the shell). */
export function useStoreRefetchOnReconnect(): void {
  useOnReconnect(() => {
    void refetchOpenCount();
    void refetchPendingActions();
  });
}

// ---------- module init ----------

let initialized = false;

/** Wire stores to the WS bus + initial fetches. Idempotent. */
export function initStores(): void {
  if (initialized) return;
  initialized = true;

  onWsEvent('notification', (p) => {
    notifications = [
      ...notifications,
      {
        id: p.id,
        taskId: p.taskId,
        kind: p.kind,
        message: p.message,
        score: p.score,
        receivedAt: new Date().toISOString(),
        seen: false,
      },
    ];
    emitNotif();
  });

  onWsEvent('tasks.updated', (p) => {
    // This snapshot is authoritative as of now — invalidate any in-flight
    // refetchOpenCount so its (potentially older) result can't overwrite it.
    openCountToken++;
    setOpenCount(p.tasks.filter((t) => t.status === 'open').length);
  });

  onWsEvent('action.pending', (p) => {
    pendingActions = addPendingAction(pendingActions, p.action);
    emitPendingActions();
  });

  onWsEvent('action.resolved', (p) => {
    pendingActions = resolvePendingAction(pendingActions, p.action);
    emitPendingActions();
  });

  void refetchOpenCount();
  void refetchPendingActions();
}
