import { EventEmitter } from 'node:events';
import type { WsEvent } from '@botty/shared';

/** Internal (non-WS) events flowing between agent subsystems. */
export interface InternalEvents {
  /** Emitted by the chat service whenever the user sends a message (feeds the response tracker + "user active" gate). */
  'chat.userMessage': { text: string; at: string };
  /** Ask the platform layer to fire a native macOS notification. */
  'notify.macos': { title: string; message: string };
}

export type BusEvents = InternalEvents & {
  /** Every WsEvent broadcast to connected web clients flows through here; the WS hub subscribes. */
  broadcast: WsEvent;
};

/** Typed event bus shared by all agent subsystems. */
export class Bus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  /** Subscribe. Returns an unsubscribe function. */
  on<K extends keyof BusEvents>(event: K, listener: (payload: BusEvents[K]) => void): () => void {
    this.emitter.on(event as string, listener);
    return () => this.emitter.off(event as string, listener);
  }

  once<K extends keyof BusEvents>(event: K, listener: (payload: BusEvents[K]) => void): void {
    this.emitter.once(event as string, listener);
  }

  emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
    this.emitter.emit(event as string, payload);
  }

  /** Send a typed WS event to all connected web clients (via the server's WS hub). */
  broadcast(event: WsEvent): void {
    this.emit('broadcast', event);
  }

  /** Convenience for the WS hub. Returns an unsubscribe function. */
  onBroadcast(listener: (event: WsEvent) => void): () => void {
    return this.on('broadcast', listener);
  }
}

export function createBus(): Bus {
  return new Bus();
}
