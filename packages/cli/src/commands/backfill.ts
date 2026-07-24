import type { BackfillSourceProgress, BackfillStartResponse, BackfillState } from '@botty/shared';
import { BACKFILL_SOURCES } from '@botty/shared';
import type { CliConfig } from '../config.js';
import { getJson, postJson, sleep } from '../http.js';

const USAGE = 'usage: botty backfill [status|cancel|resume] [--source slack,gmail,gcal] [--days 30] [--max-llm-calls 50] [--no-wait]';

export async function backfill(cfg: CliConfig): Promise<void> {
  const sub = cfg.args[0];
  if (sub !== undefined && sub !== 'status' && sub !== 'cancel' && sub !== 'resume') {
    throw new Error(`unknown subcommand "backfill ${sub}"\n${USAGE}`);
  }

  const health = await getJson(`${cfg.agentUrl}/api/health`).catch(() => null);
  if (!health) {
    throw new Error(`no agent on :${cfg.port} — \`botty start\` first`);
  }

  if (sub === 'status') {
    const { state } = (await getJson(`${cfg.agentUrl}/api/backfill`)) as { state: BackfillState };
    printState(state);
    process.exitCode = state.status === 'error' ? 1 : 0;
    return;
  }

  if (sub === 'cancel') {
    const { state } = (await postJson(`${cfg.agentUrl}/api/backfill/cancel`, {})) as { state: BackfillState };
    console.log(state.status === 'running' ? 'cancel requested — stopping between pages' : `nothing running (last run: ${state.status})`);
    return;
  }

  if (cfg.backfillSources) {
    const bad = cfg.backfillSources.filter((s) => !(BACKFILL_SOURCES as readonly string[]).includes(s));
    if (bad.length > 0) {
      throw new Error(`--source: "${bad.join(', ')}" not backfillable (valid: ${BACKFILL_SOURCES.join(', ')})`);
    }
  }

  const res = (await postJson(`${cfg.agentUrl}/api/backfill/start`, {
    ...(cfg.backfillSources ? { sources: cfg.backfillSources } : {}),
    ...(cfg.days !== undefined ? { days: cfg.days } : {}),
    ...(cfg.maxLlmCalls !== undefined ? { maxLlmCalls: cfg.maxLlmCalls } : {}),
    resume: sub === 'resume',
  })) as BackfillStartResponse;

  if (!res.started) {
    console.log('a backfill is already running — `botty backfill status` to watch it, `botty backfill cancel` to stop it');
    process.exitCode = 1;
    return;
  }
  const w = res.state.window!;
  console.log(`backfill started — ${Object.keys(res.state.sources).join(', ')} · last ${w.days} days (since ${w.oldest.slice(0, 10)})`);

  if (cfg.noWait) {
    console.log('running in the background — `botty backfill status` for progress');
    return;
  }

  console.log('(^C detaches; the run keeps going server-side — `botty backfill status`)');
  let state: BackfillState = res.state;
  for (;;) {
    await sleep(1000);
    ({ state } = (await getJson(`${cfg.agentUrl}/api/backfill`)) as { state: BackfillState });
    if (state.status !== 'running') break;
  }
  printState(state);
  process.exitCode = state.status === 'error' ? 1 : 0;
}

function sourceLine(source: string, p: BackfillSourceProgress): string {
  const status = p.error ? `✗ ${p.error}` : p.done ? '✓' : '…';
  return `  ${source.padEnd(6)} ${String(p.newEvents).padStart(4)} new · ${p.duplicates} duplicates (${p.fetched} fetched) ${status}`;
}

function printState(state: BackfillState): void {
  if (state.status === 'idle') {
    console.log('no backfill has run yet — `botty backfill` to start one');
    return;
  }
  const w = state.window;
  console.log(`backfill ${state.status}${w ? ` — last ${w.days} days` : ''}${state.finishedAt ? ` (finished ${state.finishedAt.slice(0, 19)}Z)` : ''}`);
  for (const [source, p] of Object.entries(state.sources)) console.log(sourceLine(source, p));
  const d = state.distill;
  const capNote = d.done ? '' : d.callsUsed >= d.callCap ? ` — call cap reached, \`botty backfill resume\` to continue` : '';
  console.log(`  distill ${d.threadsDistilled}/${d.threadsSeen} threads → ${d.decisionsCreated} decisions, ${d.notesAdded} people notes (${d.callsUsed}/${d.callCap} LLM calls${d.errors ? `, ${d.errors} errors` : ''})${capNote}`);
}
