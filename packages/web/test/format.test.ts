import { describe, expect, it } from 'vitest';
import { priorityLabel } from '../src/lib/format.js';

describe('priorityLabel (1 = HIGH, 2 = NORMAL, 3 = LOW — must match tui/src/format.ts)', () => {
  it('maps the unified 1..3 scale', () => {
    expect(priorityLabel(1)).toBe('P1');
    expect(priorityLabel(2)).toBe('P2');
    expect(priorityLabel(3)).toBe('P3');
  });

  it('clamps out-of-range values and falls back to NORMAL for garbage', () => {
    expect(priorityLabel(0)).toBe('P1');
    expect(priorityLabel(-5)).toBe('P1');
    expect(priorityLabel(9)).toBe('P3');
    expect(priorityLabel(NaN)).toBe('P2');
  });
});
