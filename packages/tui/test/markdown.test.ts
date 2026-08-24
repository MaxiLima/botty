import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown.js';

describe('renderMarkdown', () => {
  it('renders plain markdown', () => {
    expect(renderMarkdown('hello **world**', 80)).toContain('world');
  });

  it('strips control/escape sequences before parsing (untrusted chat/nudge content)', () => {
    // An ingested message quoted back in a nudge or a chat reply could carry
    // raw C0/OSC bytes; they must never reach Ink's stdout write.
    const out = renderMarkdown('careful\x1B[2J now\x07', 80);
    expect(out).not.toMatch(/\x1B|\x07/);
    expect(out).toContain('careful');
    expect(out).toContain('now');
  });

  it('strips an OSC 52 clipboard-set attempt', () => {
    const out = renderMarkdown('hi\x1B]52;c;ZXZpbA==\x1B\\bye', 80);
    expect(out).not.toMatch(/\x1B/);
    expect(out).toContain('hi');
    expect(out).toContain('bye');
  });
});
