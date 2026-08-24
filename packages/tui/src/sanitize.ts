/**
 * Strip terminal control sequences from untrusted text before it reaches Ink.
 *
 * Ingested content (Slack messages, email bodies, calendar titles, MCP tool
 * summaries, …) flows unmodified into nudge messages, task titles/descriptions,
 * and chat turns. Ink's <Text> writes that string straight to stdout — an
 * embedded C0 control character or ANSI/OSC/CSI escape sequence in it can move
 * the cursor, clear/repaint the screen, or (via OSC, e.g. OSC 52) set the
 * terminal's window title or clipboard, all inside the user's own terminal.
 * This is the single choke point every such string should pass through.
 *
 * `\n` is kept (legitimate multi-line messages); everything else in the C0
 * range, DEL, and the C1 range (0x80–0x9F, which several terminals also treat
 * as escape introducers) is dropped. Tabs become a single space rather than
 * vanishing, so word boundaries survive.
 */
export function sanitizeTerminalText(text: string): string {
  if (!text) return text;
  return (
    text
      // OSC: ESC ] ... terminated by BEL or ST (ESC \) — window title, clipboard (OSC 52), etc.
      .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, '')
      // DCS / SOS / PM / APC: ESC P|X|^|_ ... ST
      .replace(/\x1B[PX^_][\s\S]*?\x1B\\/g, '')
      // CSI: ESC [ params intermediates final-byte — cursor movement, clear, color, etc.
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      // Any remaining ESC byte — a two-byte Fe/Fp/Fs sequence (e.g. ESC c reset,
      // ESC 7/8 save/restore cursor) or a malformed/truncated one. Only the ESC
      // itself is dropped, not the byte after it: once ESC is gone the terminal
      // can never reinterpret the remainder as a sequence, and any legitimate
      // character right after a stray ESC in real content survives.
      .replace(/\x1B/g, '')
      .replace(/\t/g, ' ')
      // Remaining C0 controls (but \n) + DEL + C1 range.
      .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '')
  );
}
