import { describe, expect, it } from 'vitest';
import { HttpError, MAX_QUERY_LIMIT, queryInt } from '../../src/server/errors.js';

describe('queryInt', () => {
  it('returns undefined for an absent/empty value', () => {
    expect(queryInt(undefined, 'limit')).toBeUndefined();
    expect(queryInt('', 'limit')).toBeUndefined();
  });

  it('accepts a plain positive integer, string or number', () => {
    expect(queryInt('50', 'limit')).toBe(50);
    expect(queryInt(50, 'limit')).toBe(50);
    expect(queryInt('1', 'limit')).toBe(1);
  });

  it('clamps a huge-but-finite value to MAX_QUERY_LIMIT instead of 500ing downstream', () => {
    // Number.isInteger(1e308) is true (doubles that large have no fractional
    // part left), so this used to sail past the old `Number.isInteger`-only
    // check and hit the DB/array-allocation layer unclamped.
    expect(queryInt('1e308', 'limit')).toBe(MAX_QUERY_LIMIT);
    expect(queryInt(1e308, 'limit')).toBe(MAX_QUERY_LIMIT);
    expect(queryInt(Number.MAX_SAFE_INTEGER, 'limit')).toBe(MAX_QUERY_LIMIT);
  });

  it('clamps a value just over the cap, and passes one just at or under it through unchanged', () => {
    expect(queryInt(String(MAX_QUERY_LIMIT + 1), 'limit')).toBe(MAX_QUERY_LIMIT);
    expect(queryInt(String(MAX_QUERY_LIMIT), 'limit')).toBe(MAX_QUERY_LIMIT);
    expect(queryInt(String(MAX_QUERY_LIMIT - 1), 'limit')).toBe(MAX_QUERY_LIMIT - 1);
  });

  it('rejects non-finite values (Infinity, -Infinity)', () => {
    expect(() => queryInt('Infinity', 'limit')).toThrow(HttpError);
    expect(() => queryInt(Infinity, 'limit')).toThrow(HttpError);
    expect(() => queryInt(-Infinity, 'limit')).toThrow(HttpError);
  });

  it('rejects NaN / garbage strings', () => {
    expect(() => queryInt('banana', 'limit')).toThrow(HttpError);
    expect(() => queryInt(NaN, 'limit')).toThrow(HttpError);
  });

  it('rejects zero, negative, and non-integer values', () => {
    expect(() => queryInt('0', 'limit')).toThrow(HttpError);
    expect(() => queryInt('-5', 'limit')).toThrow(HttpError);
    expect(() => queryInt('1.5', 'limit')).toThrow(HttpError);
  });

  it('error carries a 400 status naming the param', () => {
    try {
      queryInt('banana', 'limit');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(400);
      expect((err as HttpError).detail).toContain('limit');
    }
  });
});
