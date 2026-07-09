#!/usr/bin/env tsx
/**
 * Replay harness (docs/specs/loop.md "Replay harness").
 *
 *   npm run replay -w @botty/agent -- --kind judgment --last 20
 *   npm run replay -w @botty/agent -- --kind judgment --last 20 --model claude-opus-4-8
 *   npm run replay -w @botty/agent -- --kind judgment --system-file ./new-prompt.md
 *   npm run replay -w @botty/agent -- --kind classification --last 50 --diff-only
 *
 * Loads stored ai_decisions of a kind, re-runs llm.structured with the SAME
 * stored inputs (optionally substituting the system prompt and/or model),
 * prints a per-row diff table and a changed/unchanged summary. Re-runs are
 * recorded with kind '<kind>:replay' so they never pollute the primary log.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import {
  BriefingOutputSchema,
  ClassifierOutputSchema,
  ExtractorOutputSchema,
  JudgmentOutputSchema,
  ResolutionOutputSchema,
  type AiDecision,
  type LlmTask,
} from '@botty/shared';
import type { z } from 'zod';
import { Db } from '../db/index.js';
import { loadEnv } from '../env.js';
import { makeModelResolver } from '../llm/index.js';
import { MockLlmClient } from '../llm/mock.js';
import { SdkLlmClient, loadSdkQueryFn } from '../llm/sdk.js';
import type { DecisionRecorder, LlmClient } from '../llm/types.js';

type ReplayableKind = Exclude<LlmTask, 'chat'>;

const SCHEMAS: Record<ReplayableKind, z.ZodType<unknown>> = {
  judgment: JudgmentOutputSchema,
  classification: ClassifierOutputSchema,
  extraction: ExtractorOutputSchema,
  briefing: BriefingOutputSchema,
  resolution: ResolutionOutputSchema,
  // Session-seal summaries share BriefingOutputSchema's { title, body } shape.
  seal: BriefingOutputSchema,
};

interface RowResult {
  decision: AiDecision;
  oldSummary: string;
  newSummary: string;
  changed: boolean;
  error?: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      kind: { type: 'string' },
      last: { type: 'string', default: '20' },
      model: { type: 'string' },
      'system-file': { type: 'string' },
      'diff-only': { type: 'boolean', default: false },
    },
  });

  const kind = values.kind as ReplayableKind | undefined;
  if (!kind || !(kind in SCHEMAS)) {
    console.error(`usage: replay --kind <${Object.keys(SCHEMAS).join('|')}> [--last N] [--model M] [--system-file F] [--diff-only]`);
    process.exit(1);
  }
  const last = Number(values.last);
  if (!Number.isFinite(last) || last <= 0) {
    console.error(`invalid --last: ${values.last}`);
    process.exit(1);
  }
  const systemOverride = values['system-file']
    ? fs.readFileSync(values['system-file'], 'utf8')
    : null;

  const env = loadEnv();
  const db = new Db(env.dbPath);
  const decisions = db.listAiDecisions({ kind, limit: last }).reverse(); // chronological
  if (decisions.length === 0) {
    console.log(`no ai_decisions rows of kind '${kind}' in ${env.dbPath}`);
    db.close();
    return;
  }

  // Recorder that suffixes ':replay' so re-runs never pollute the primary log.
  const record: DecisionRecorder = (input) =>
    db.insertAiDecision({ ...input, kind: `${input.kind}:replay` }).id;
  const defaultModelFor = makeModelResolver(db);
  const modelFor = (task: LlmTask) => values.model ?? defaultModelFor(task);
  const llm: LlmClient = env.mockLlm
    ? new MockLlmClient({ db, modelFor, record })
    : new SdkLlmClient({ queryFn: await loadSdkQueryFn(), db, modelFor, record });

  console.log(
    `replaying ${decisions.length} '${kind}' decision(s)` +
      `${values.model ? ` with model ${values.model}` : ''}` +
      `${systemOverride ? ` and system prompt from ${values['system-file']}` : ''}\n`,
  );

  const results: RowResult[] = [];
  for (const decision of decisions) {
    results.push(await replayOne(llm, kind, decision, systemOverride));
  }

  printTable(results, values['diff-only'] === true);
  const changed = results.filter((r) => r.changed && !r.error).length;
  const errors = results.filter((r) => r.error).length;
  const unchanged = results.length - changed - errors;
  console.log(`\nsummary: ${results.length} replayed · ${changed} changed · ${unchanged} unchanged · ${errors} errors`);
  db.close();
}

async function replayOne(
  llm: LlmClient,
  kind: ReplayableKind,
  decision: AiDecision,
  systemOverride: string | null,
): Promise<RowResult> {
  const oldOutput = decision.outputJson ? (JSON.parse(decision.outputJson) as unknown) : null;
  const oldSummary = decision.error
    ? `(error: ${decision.error.slice(0, 40)})`
    : summarize(kind, oldOutput);

  let input: { system?: string; prompt?: string };
  try {
    input = JSON.parse(decision.inputJson) as { system?: string; prompt?: string };
  } catch {
    return { decision, oldSummary, newSummary: '(bad stored input)', changed: false, error: 'bad input_json' };
  }
  if (typeof input.prompt !== 'string') {
    return { decision, oldSummary, newSummary: '(no stored prompt)', changed: false, error: 'no prompt' };
  }

  try {
    const output = await llm.structured({
      task: kind,
      system: systemOverride ?? input.system ?? '',
      prompt: input.prompt,
      schema: SCHEMAS[kind],
      relatedRef: `replay:${decision.id}`,
    });
    return {
      decision,
      oldSummary,
      newSummary: summarize(kind, output),
      changed: stableJson(output) !== stableJson(oldOutput),
    };
  } catch (err) {
    return {
      decision,
      oldSummary,
      newSummary: `(error: ${(err as Error).message.slice(0, 60)})`,
      changed: true,
      error: (err as Error).message,
    };
  }
}

/** Compact one-line summary of a structured output, per kind. */
function summarize(kind: ReplayableKind, output: unknown): string {
  if (output === null || output === undefined) return '(none)';
  const o = output as Record<string, unknown>;
  switch (kind) {
    case 'judgment': {
      const actions = (o.actions as { type: string; taskId: string; score: number }[] | undefined) ?? [];
      const skipped = (o.skipped as unknown[] | undefined) ?? [];
      if (actions.length === 0) return `skip all (${skipped.length} skipped)`;
      return actions.map((a) => `${a.type}(${a.taskId.slice(0, 8)},${a.score})`).join(' ');
    }
    case 'classification': {
      const worth = o.worthExtracting as boolean;
      return `${worth ? 'extract' : 'skip'}(${o.confidence as number})`;
    }
    case 'extraction': {
      const n = (k: string) => ((o[k] as unknown[] | undefined) ?? []).length;
      return `${n('tasks')} tasks · ${n('decisions')} decisions · ${n('people')} people`;
    }
    case 'briefing':
    case 'seal':
      return String(o.title ?? '').slice(0, 48) || '(untitled)';
    case 'resolution':
      return `${o.resolved ? 'resolve' : 'keep'}(${o.confidence as number})`;
  }
}

/** JSON.stringify with sorted object keys, for order-insensitive comparison. */
function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

function printTable(results: RowResult[], diffOnly: boolean): void {
  const rows = diffOnly ? results.filter((r) => r.changed) : results;
  if (rows.length === 0) {
    console.log(diffOnly ? 'no changed rows' : 'no rows');
    return;
  }
  const table = rows.map((r) => ({
    id: r.decision.id.slice(0, 10),
    created: r.decision.createdAt.slice(0, 16).replace('T', ' '),
    old: r.oldSummary.slice(0, 44),
    new: r.newSummary.slice(0, 44),
    diff: r.error ? 'ERROR' : r.changed ? 'CHANGED' : '',
  }));
  const cols = ['id', 'created', 'old', 'new', 'diff'] as const;
  const widths = Object.fromEntries(
    cols.map((c) => [c, Math.max(c.length, ...table.map((row) => row[c].length))]),
  ) as Record<(typeof cols)[number], number>;
  const line = (row: Record<(typeof cols)[number], string>) =>
    cols.map((c) => row[c].padEnd(widths[c])).join('  ');
  console.log(line({ id: 'id', created: 'created', old: 'old', new: 'new', diff: 'diff' }));
  console.log(cols.map((c) => '-'.repeat(widths[c])).join('  '));
  for (const row of table) console.log(line(row));
}

main().catch((err) => {
  console.error('replay failed:', err);
  process.exit(1);
});
