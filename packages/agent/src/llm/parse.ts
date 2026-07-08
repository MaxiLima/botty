import { z } from 'zod';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Fence-tolerant JSON extraction + zod validation.
 * Accepts: bare JSON, ```json fenced blocks, JSON embedded in prose.
 */
export function parseStructuredText<T>(text: string, schema: z.ZodType<T>): ParseResult<T> {
  let candidate = text.trim();
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidate = fenced[1]!.trim();
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) {
    return { ok: false, error: 'no JSON object found in response' };
  }
  candidate = candidate.slice(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: `schema validation failed: ${result.error.message.slice(0, 500)}` };
  }
  return { ok: true, value: result.data };
}

export const JSON_ONLY_INSTRUCTION =
  '\n\nOutput format: respond with a SINGLE valid JSON object and nothing else — no prose, no explanations, no markdown code fences.';

/** JSON-only instruction that also spells out the exact expected shape. */
export function jsonInstructionFor(schema: z.ZodType): string {
  let rendered = '';
  try {
    rendered = JSON.stringify(z.toJSONSchema(schema));
  } catch {
    return JSON_ONLY_INSTRUCTION;
  }
  return (
    JSON_ONLY_INSTRUCTION +
    `\nThe object MUST conform exactly to this JSON Schema (include every required field):\n${rendered}`
  );
}
