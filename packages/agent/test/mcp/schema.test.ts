import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonSchemaToZodShape } from '../../src/mcp/schema.js';

describe('jsonSchemaToZodShape', () => {
  it('converts string/number/integer/boolean, required vs optional, and descriptions', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'who to greet' },
        count: { type: 'number' },
        age: { type: 'integer' },
        active: { type: 'boolean' },
      },
      required: ['name', 'age'],
    });
    const schema = z.object(shape);

    expect(schema.shape.name!.description).toBe('who to greet');
    expect(schema.safeParse({ name: 'a', age: 3 }).success).toBe(true); // count/active optional
    expect(schema.safeParse({ age: 3 }).success).toBe(false); // name required
    expect(schema.safeParse({ name: 'a', age: 3.5 }).success).toBe(false); // integer enforced
    expect(schema.safeParse({ name: 'a', age: 3, active: 'yes' }).success).toBe(false); // boolean enforced
  });

  it('converts a string enum property', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b'] } },
    });
    const schema = z.object(shape);
    expect(schema.safeParse({ mode: 'a' }).success).toBe(true);
    expect(schema.safeParse({ mode: 'z' }).success).toBe(false);
  });

  it('converts array-of-primitives (string/number/integer/boolean) and falls back for mixed arrays', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        scores: { type: 'array', items: { type: 'number' } },
        anything: { type: 'array', items: { type: 'object' } },
      },
    });
    const schema = z.object(shape);
    expect(schema.safeParse({ tags: ['a', 'b'] }).success).toBe(true);
    expect(schema.safeParse({ tags: [1] }).success).toBe(false);
    expect(schema.safeParse({ scores: [1, 2.5] }).success).toBe(true);
    expect(schema.safeParse({ anything: [{ x: 1 }, 'y', 2] }).success).toBe(true);
  });

  it('degrades unknown/nested constructs to z.unknown() per property instead of dropping them', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        nested: { type: 'object', properties: { a: { type: 'string' } } },
        anyOf: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['nested', 'anyOf'],
    });
    expect(Object.keys(shape).sort()).toEqual(['anyOf', 'nested']);
    const schema = z.object(shape);
    expect(schema.safeParse({ nested: { a: 'x' }, anyOf: 'y' }).success).toBe(true);
    expect(schema.safeParse({ nested: 42, anyOf: [1, 2] }).success).toBe(true); // z.unknown() accepts anything
  });

  it('falls back to a single optional passthrough field when there is no usable schema', () => {
    for (const bad of [undefined, null, 'not an object', { type: 'object' }, { type: 'object', properties: {} }]) {
      const shape = jsonSchemaToZodShape(bad);
      expect(Object.keys(shape)).toEqual(['args']);
      const schema = z.object(shape);
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ args: { anything: 'goes' } }).success).toBe(true);
    }
  });
});
