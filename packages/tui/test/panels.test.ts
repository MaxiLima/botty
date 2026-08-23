import { describe, expect, it } from 'vitest';
import { fit } from '../src/panels.js';

describe('fit', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(fit('hello   world', 20)).toBe('hello world'.padEnd(20));
    expect(fit('a very long description that overflows', 10)).toBe('a very lo…');
  });

  it('strips control/escape sequences before measuring width (untrusted task/person text)', () => {
    // Without stripping, the CSI bytes would count toward the padded width and
    // could move the cursor / repaint the terminal when printed.
    expect(fit('urgent\x1B[2J task', 20)).toBe('urgent task'.padEnd(20));
  });

  it('strips OSC sequences (e.g. an injected window-title/clipboard set)', () => {
    expect(fit('name\x1B]0;pwned\x07here', 20)).toBe('namehere'.padEnd(20));
  });
});
