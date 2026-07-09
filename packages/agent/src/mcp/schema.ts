import { z } from 'zod';

/**
 * Best-effort JSON-Schema → zod raw-shape conversion for MCP tools/list input
 * schemas. Supports the flat-object subset that covers the overwhelming
 * majority of real tool schemas: string/number/integer/boolean, string enums,
 * arrays of those primitives, required vs optional, and property
 * descriptions. Anything else (nested objects, oneOf/anyOf/allOf, unknown
 * types) degrades to `z.unknown()` for that property rather than dropping it
 * or throwing — the model can still pass a value, and mcp/tools.ts always
 * appends the raw JSON schema as text to the tool description so the model
 * isn't solely reliant on this shape. No schema at all → a single optional
 * passthrough property so the tool can still be called with a bag of args.
 */

/** Structural subset of JSON Schema as returned by an MCP server's tools/list. */
export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface JsonSchemaProperty {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaProperty;
  [key: string]: unknown;
}

/** Fallback shape when there is no usable input schema at all. */
export function fallbackShape(): z.ZodRawShape {
  return {
    args: z
      .unknown()
      .optional()
      .describe('No input schema is available from the server — pass arguments as a flat JSON object.'),
  };
}

function isJsonSchemaObject(schema: unknown): schema is JsonSchemaObject {
  return typeof schema === 'object' && schema !== null;
}

/** One JSON-Schema property → a best-effort zod type (never throws, never returns undefined). */
function propertyToZod(prop: JsonSchemaProperty): z.ZodTypeAny {
  const description = typeof prop.description === 'string' ? prop.description : undefined;
  const withDesc = (t: z.ZodTypeAny): z.ZodTypeAny => (description ? t.describe(description) : t);

  if (Array.isArray(prop.enum) && prop.enum.length > 0 && prop.enum.every((v) => typeof v === 'string')) {
    return withDesc(z.enum(prop.enum as [string, ...string[]]));
  }

  const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
  switch (type) {
    case 'string':
      return withDesc(z.string());
    case 'number':
      return withDesc(z.number());
    case 'integer':
      return withDesc(z.number().int());
    case 'boolean':
      return withDesc(z.boolean());
    case 'array': {
      const items = prop.items;
      const itemType = items && !Array.isArray(items) ? items.type : undefined;
      switch (itemType) {
        case 'string':
          return withDesc(z.array(z.string()));
        case 'number':
          return withDesc(z.array(z.number()));
        case 'integer':
          return withDesc(z.array(z.number().int()));
        case 'boolean':
          return withDesc(z.array(z.boolean()));
        default:
          // Array of objects / mixed / unknown item type — accept anything per-item.
          return withDesc(z.array(z.unknown()));
      }
    }
    default:
      // object / oneOf / anyOf / allOf / missing type — degrade, don't drop.
      return withDesc(z.unknown());
  }
}

/**
 * Convert an MCP tool's raw JSON-Schema `inputSchema` into a zod raw shape
 * suitable for ChatToolSpec.inputSchema. `schema` is untyped because it comes
 * straight off the wire (tools/list); anything that isn't a flat `{type:
 * 'object', properties: {...}}` shape falls back to a single passthrough field.
 */
export function jsonSchemaToZodShape(schema: unknown): z.ZodRawShape {
  if (!isJsonSchemaObject(schema)) return fallbackShape();
  if (!isJsonSchemaObject(schema.properties)) return fallbackShape();

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  // z.ZodRawShape's index signature is read-only, so build a plain mutable
  // record first and hand it back as the shape once it's fully assembled.
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, rawProp] of Object.entries(schema.properties)) {
    const prop = isJsonSchemaObject(rawProp) ? (rawProp as JsonSchemaProperty) : {};
    const zType = propertyToZod(prop);
    shape[key] = required.has(key) ? zType : zType.optional();
  }
  // An object schema with an empty properties bag still needs at least a
  // usable shape — treat it the same as "no schema".
  return Object.keys(shape).length > 0 ? (shape as z.ZodRawShape) : fallbackShape();
}
