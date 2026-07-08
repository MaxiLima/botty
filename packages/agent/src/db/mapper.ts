/** snake_case → camelCase key mapping, done once at the Db layer. */

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Map a raw sqlite row (snake_case keys) into a camelCase object typed as T. */
export function mapRow<T>(row: unknown): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[toCamel(k)] = v;
  }
  return out as T;
}

export function mapRows<T>(rows: unknown[]): T[] {
  return rows.map((r) => mapRow<T>(r));
}

export function nowIso(): string {
  return new Date().toISOString();
}
