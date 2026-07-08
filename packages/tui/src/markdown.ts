import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';

// Single-entry cache: transcript items render once at the then-current width,
// so older widths are never reused — no point keeping an instance per width.
let cached: { width: number; m: Marked } | null = null;

/** Markdown → ANSI-styled plain text sized to the terminal. */
export function renderMarkdown(source: string, columns: number): string {
  const width = Math.max(20, Math.min(columns, 100));
  if (cached?.width !== width) {
    cached = { width, m: new Marked(markedTerminal({ width, reflowText: true, tab: 2 })) };
  }
  const m = cached.m;
  try {
    const out = m.parse(source, { async: false }) as string;
    return out.replace(/\s+$/, '');
  } catch {
    return source; // never let a rendering edge case eat the message
  }
}
