import { useSyncExternalStore } from 'react';
import { api } from './api.js';
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

// ---------- Open task count (sidebar badge) ----------

let openCount: number | null = null;
const countSubs = new Set<() => void>();

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
  try {
    const { tasks } = await api.tasks('open');
    setOpenCount(tasks.length);
  } catch {
    // agent unreachable — leave stale count
  }
}

/** Hook the badge stores refetch to WS reconnects (call once, from the shell). */
export function useStoreRefetchOnReconnect(): void {
  useOnReconnect(() => {
    void refetchOpenCount();
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
    setOpenCount(p.tasks.filter((t) => t.status === 'open').length);
  });

  void refetchOpenCount();
}
