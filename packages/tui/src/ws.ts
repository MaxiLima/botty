// Port of packages/web/src/lib/ws.ts: same listener registry and
// reconnect/backoff, using Node's built-in WebSocket and an explicit URL
// (the web app derives it from window.location).
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { WsEventSchema, type WsEvent, type WsEventType } from '@botty/shared';

export type WsStatus = 'connecting' | 'open' | 'closed';

export type PayloadOf<T extends WsEventType> = Extract<WsEvent, { type: T }>['payload'];

type Listener<T extends WsEventType = WsEventType> = (payload: PayloadOf<T>) => void;

const listeners = new Map<WsEventType, Set<Listener>>();
const statusSubs = new Set<() => void>();
const reconnectSubs = new Set<(first: boolean) => void>();

let socket: WebSocket | null = null;
let status: WsStatus = 'connecting';
let attempts = 0;
let everConnected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let wsUrl = '';

function setStatus(next: WsStatus): void {
  if (status === next) return;
  status = next;
  for (const cb of statusSubs) cb();
}

function dispatch(ev: WsEvent): void {
  const set = listeners.get(ev.type);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(ev.payload);
    } catch {
      // Never let a listener error kill the socket handler. Can't console.error
      // here — Ink owns stdout/stderr.
    }
  }
}

function connect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  setStatus('connecting');
  const ws = new WebSocket(wsUrl);
  socket = ws;

  ws.onopen = () => {
    if (socket !== ws) return;
    attempts = 0;
    setStatus('open');
    // Fire on the first open too (unlike the web client, whose page always
    // boots after the server is up) — a TUI launched before the agent needs
    // a signal to retry its failed boot. `first` lets the app tell them apart.
    const first = !everConnected;
    everConnected = true;
    for (const cb of reconnectSubs) cb(first);
  };

  ws.onmessage = (msg: MessageEvent) => {
    if (socket !== ws) return;
    let json: unknown;
    try {
      json = JSON.parse(typeof msg.data === 'string' ? msg.data : '');
    } catch {
      return;
    }
    const parsed = WsEventSchema.safeParse(json);
    if (parsed.success) dispatch(parsed.data);
  };

  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    setStatus('closed');
    scheduleReconnect();
  };

  ws.onerror = () => {
    // onclose follows; nothing to do here.
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  const delay = Math.min(15_000, 500 * 2 ** Math.min(attempts, 5));
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/** Idempotent — call once from app bootstrap. */
export function startWs(url: string): void {
  if (started) return;
  started = true;
  wsUrl = url;
  connect();
}

export function stopWs(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const ws = socket;
  socket = null;
  ws?.close();
}

export function onWsEvent<T extends WsEventType>(type: T, cb: (payload: PayloadOf<T>) => void): () => void {
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(cb as Listener);
  return () => {
    set.delete(cb as Listener);
  };
}

/** Subscribe to a WS event type for the lifetime of the component. `cb` may be unstable. */
export function useWsEvent<T extends WsEventType>(type: T, cb: (payload: PayloadOf<T>) => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => onWsEvent(type, (payload) => ref.current(payload)), [type]);
}

export function useWsStatus(): WsStatus {
  return useSyncExternalStore(
    (cb) => {
      statusSubs.add(cb);
      return () => statusSubs.delete(cb);
    },
    () => status,
  );
}

/**
 * Fires whenever the socket opens; `first` is true on the first-ever open
 * (retry a failed boot) and false after a drop (refetch REST state).
 */
export function useOnReconnect(cb: (first: boolean) => void): void {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const fn = (first: boolean) => ref.current(first);
    reconnectSubs.add(fn);
    return () => {
      reconnectSubs.delete(fn);
    };
  }, []);
}
