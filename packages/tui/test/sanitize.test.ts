import { describe, expect, it } from 'vitest';
import { sanitizeTerminalText } from '../src/sanitize.js';

describe('sanitizeTerminalText', () => {
  it('passes plain text through untouched', () => {
    expect(sanitizeTerminalText('hello world')).toBe('hello world');
  });

  it('keeps newlines', () => {
    expect(sanitizeTerminalText('line one\nline two')).toBe('line one\nline two');
  });

  it('strips CSI cursor-movement / clear-screen sequences', () => {
    // Move cursor up 5, clear screen, home.
    expect(sanitizeTerminalText('a\x1B[5Ab\x1B[2Jc\x1B[Hd')).toBe('abcd');
  });

  it('strips OSC sequences (window title / clipboard, BEL-terminated)', () => {
    expect(sanitizeTerminalText('before\x1B]0;pwned\x07after')).toBe('beforeafter');
  });

  it('strips OSC sequences terminated by ST (ESC \\\\)', () => {
    expect(sanitizeTerminalText('before\x1B]52;c;ZXZpbA==\x1B\\after')).toBe('beforeafter');
  });

  it('strips DCS/APC-style sequences', () => {
    expect(sanitizeTerminalText('a\x1BPq#0;2;0;0;0#1;2;100;100;100\x1B\\b')).toBe('ab');
  });

  it('strips a lone/malformed escape without eating the rest of the message', () => {
    expect(sanitizeTerminalText('a\x1Bb\x1B')).toBe('ab');
  });

  it('strips C0 control characters other than newline', () => {
    expect(sanitizeTerminalText('a\x00b\x07c\x0Dd')).toBe('abcd');
  });

  it('strips DEL and C1 control range', () => {
    expect(sanitizeTerminalText('a\x7Fb\x9Bc')).toBe('abc');
  });

  it('collapses a tab to a single space', () => {
    expect(sanitizeTerminalText('a\tb')).toBe('a b');
  });

  it('passes empty string through', () => {
    expect(sanitizeTerminalText('')).toBe('');
  });
});
