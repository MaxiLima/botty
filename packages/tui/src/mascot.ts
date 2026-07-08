import type { WsStatus } from './ws.js';

/**
 * botty's mascot is built from the brand mark ◍ (the web app's empty-state
 * glyph): a little bot whose smile is part of its chassis.
 */
export const MASCOT_LINES = ['   ●', ' ╭─┴───╮', ' │ ◍ ◍ │', ' ╰──‿──╯'];

/** Statusline face — the bot's mood tracks the connection. */
export function face(status: WsStatus): string {
  if (status === 'open') return '(◍‿◍)';
  if (status === 'connecting') return '(◍.◍)';
  return '(◍×◍)';
}

export const TAGLINE = 'your proactive chief of staff';
