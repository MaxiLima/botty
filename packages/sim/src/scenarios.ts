import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ScenarioSchema, type Scenario } from '@botty/shared';
import { DEFAULT_TEMPLATES, InjectTemplateSchema, type InjectTemplate } from './templates.js';

const SCENARIOS_DIR =
  process.env.BOTTY_SIM_SCENARIOS_DIR ?? fileURLToPath(new URL('../scenarios/', import.meta.url));

const NAME_RE = /^[A-Za-z0-9_-]+$/;

export function listScenarios(): string[] {
  try {
    return readdirSync(SCENARIOS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Load scenarios/<name>.json. Returns the ScenarioSchema-validated scenario
 * plus its inject templates (scenario-provided `templates` key merged over the
 * built-in defaults; the frozen ScenarioSchema strips unknown keys, so
 * templates are parsed from the raw JSON here).
 */
export function loadScenarioFile(name: string): { scenario: Scenario; templates: InjectTemplate[] } {
  if (!NAME_RE.test(name)) throw new Error(`invalid scenario name: ${name}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(SCENARIOS_DIR, `${name}.json`), 'utf8'));
  } catch (err) {
    throw new Error(`scenario "${name}" not found or unreadable: ${(err as Error).message}`);
  }
  const scenario = ScenarioSchema.parse(raw);
  const extra = z
    .object({ templates: z.array(InjectTemplateSchema).default([]) })
    .parse(raw ?? {}).templates;
  const merged = [...extra, ...DEFAULT_TEMPLATES.filter((d) => !extra.some((t) => t.id === d.id))];
  return { scenario, templates: merged };
}
