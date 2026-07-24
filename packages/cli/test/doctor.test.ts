import { describe, expect, it } from 'vitest';
import { nodeVersionOk } from '../src/commands/doctor.js';

describe('nodeVersionOk', () => {
  it('accepts the minimum and above', () => {
    expect(nodeVersionOk('22.12.0')).toBe(true);
    expect(nodeVersionOk('22.13.1')).toBe(true);
    expect(nodeVersionOk('23.0.0')).toBe(true);
  });

  it('rejects below the minimum', () => {
    expect(nodeVersionOk('22.11.9')).toBe(false);
    expect(nodeVersionOk('20.19.0')).toBe(false);
  });
});
