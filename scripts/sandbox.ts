/**
 * botty sandbox — persistent manual-testing playground.
 *
 * Boots an isolated sim (:6821) + agent (:6820) against ~/.botty-sandbox with a
 * fast heartbeat profile (all time gates collapsed), then attaches the TUI.
 * Never touches the live dev instances on 4820/4821 or the /verify pair on
 * 5820/5821 — all process kills are by port, listener only.
 *
 * Usage:  npm run sandbox [-- <subcommand>] [flags]
 *   start (default)   boot sim+agent (idempotent), load the sandbox scenario, attach TUI
 *   stop              kill the 6820/6821 listeners
 *   reset             stop + wipe ~/.botty-sandbox + start
 *   warp --hours N | --days N   stop agent, shift the sandbox DB clock, restart agent
 *   inject <template-id>        inject a sim template + force the source poll
 *   check [source]    force a poll (all sources, or one of slack|gmail|gcal|jira|github)
 *   tick              force a proactive tick now
 *   sweep             force a resolution sweep now
 *   status            agent health + sim state
 * Flags: --no-tui (don't attach the TUI), --mock (BOTTY_MOCK_LLM=1 — judgment
 * always skips, so no nudges; funnel-only testing).
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_PORT = 6820;
const SIM_PORT = 6821;
const DIR = process.env.BOTTY_SANDBOX_DIR ?? path.join(os.homedir(), '.botty-sandbox');
const AGENT_URL = `http://127.0.0.1:${AGENT_PORT}`;
const SIM_URL = `http://127.0.0.1:${SIM_PORT}`;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = ['slack', 'gmail', 'gcal', 'jira', 'github'] as const;

// ---------- seeded config (written on first boot only; hot-editable afterwards) ----------

const HEARTBEAT_MD = `# HEARTBEAT — sandbox fast profile

All time gates collapsed for manual testing. The degenerate 00:00-00:00 windows
disable the working-hours gate (always on) and quiet hours (never quiet).
Hot-reloaded — edit freely while the sandbox runs.

## Schedule

tick_interval_min: 1
working_hours: 00:00-00:00
quiet_hours: 00:00-00:00
active_days: mon,tue,wed,thu,fri,sat,sun

## Behavior

never_surfaced_min_age_hours: 0
min_gap_between_nudges_min: 0
max_proactive_per_hour: 30
chat_active_gate_min: 0
surface_cooldown_hours: 1/2/4
stale_after_days: 1
session_idle_seal_min: 5
resolution_sweep_interval_min: 1
resolution_check_cooldown_min: 1
commitment_min_age_min: 1
commitments_max_per_day: 10

<!-- surface_cooldown_hours stays nonzero on purpose: with a 1-min tick, 0/0/0 would
re-nudge the same task every minute. Use \`npm run sandbox warp -- --hours 1\` to skip
past a cooldown instead. -->

## Instructions

This is a manual test sandbox. Surface genuinely urgent Tier-1 asks promptly;
still stay silent on noise.
`;

const TEAM_MD = `# TEAM — sandbox fixtures (matches packages/sim/scenarios/sandbox.json)

Weight CRITICAL/HIGH ⇒ Tier 1 (full task extraction). Rodrigo is NORMAL on
purpose so the tier gate is testable — his messages must never become tasks.

## People

- **Marian** — weight: CRITICAL | slack: @marian | email: marian@acme.example | cadence: daily | notes: Manager. Anything she asks for is top priority.
- **Sofi** — weight: CRITICAL | slack: @sofi | email: sofi@acme.example | cadence: daily | notes: Tech lead on the payments platform. Frequent blocker/unblocker.
- **Diego** — weight: HIGH | slack: @diego | email: diego@acme.example | cadence: weekly | notes: Peer staff engineer. Collaborates on cross-team designs.
- **Caro** — weight: HIGH | slack: @caro | email: caro@acme.example | cadence: weekly | notes: PM. Sends meeting notes with action items.
- **Fer** — weight: HIGH | slack: @fer | email: fer@vendorpay.io | cadence: monthly | notes: External vendor contact (VendorPay).
- **Rodrigo** — weight: NORMAL | slack: @rodrigo | email: rodrigo@acme.example | cadence: monthly | notes: Tier-2 on purpose — his messages should die at the tier gate.
`;

// ---------- helpers ----------

function childEnv(mock: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // When the sandbox is launched from inside a Claude Code session, the session's
  // internal env (CLAUDECODE, CLAUDE_CODE_*, its scoped ANTHROPIC_API_KEY) leaks in
  // and breaks the agent's SDK auth — strip it so the SDK falls back to the user's
  // own login. Only done when CLAUDECODE marks a nested session; a deliberately
  // exported user API key outside a session is left alone.
  if (env.CLAUDECODE) {
    for (const key of Object.keys(env)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_EFFORT') delete env[key];
    }
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return {
    ...env,
    BOTTY_DATA_DIR: DIR,
    BOTTY_MODE: 'sim',
    AGENT_PORT: String(AGENT_PORT),
    BOTTY_SIM_PORT: String(SIM_PORT),
    BOTTY_SIM_URL: `http://localhost:${SIM_PORT}`,
    BOTTY_MOCK_LLM: mock ? '1' : '0',
  };
}

function listeningPids(port: number): number[] {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .filter(Boolean)
      .map((s) => Number(s));
  } catch {
    return []; // lsof exits 1 when nothing matches
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function killPort(port: number): Promise<void> {
  const pids = listeningPids(port);
  if (pids.length === 0) return;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  for (let i = 0; i < 20; i++) {
    if (listeningPids(port).length === 0) return;
    await sleep(250);
  }
  console.error(`warning: port ${port} still has a listener after SIGTERM`);
}

async function waitHealthy(url: string, logFile: string, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  let tail = '';
  try {
    const lines = fs.readFileSync(logFile, 'utf8').trimEnd().split('\n');
    tail = lines.slice(-15).join('\n');
  } catch {
    /* no log yet */
  }
  throw new Error(`${url} not healthy after ${timeoutMs / 1000}s.\n--- ${logFile} (tail) ---\n${tail}`);
}

async function post(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.json();
}

/** Write the sandbox team.md/heartbeat.md if absent (agent seeds persona.md/mcp.json itself). */
function seedIfMissing(): boolean {
  const configDir = path.join(DIR, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(DIR, 'logs'), { recursive: true });
  let seeded = false;
  for (const [file, content] of [
    ['team.md', TEAM_MD],
    ['heartbeat.md', HEARTBEAT_MD],
  ] as const) {
    const dest = path.join(configDir, file);
    if (fs.existsSync(dest)) continue;
    fs.writeFileSync(dest, content, 'utf8');
    seeded = true;
  }
  return seeded;
}

function spawnDetached(workspace: string, logName: string, mock: boolean): void {
  const logPath = path.join(DIR, 'logs', logName);
  const fd = fs.openSync(logPath, 'a');
  const child = spawn('npm', ['run', '-w', workspace, 'start'], {
    cwd: REPO,
    env: childEnv(mock),
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
}

// ---------- subcommands ----------

const TEMPLATE_HINTS =
  'slack-dm-urgent · slack-outbound-done · slack-dm-social · gmail-urgent · gmail-meeting-notes\n' +
  '  gcal-soon · gcal-invite-soon · gcal-invite-tomorrow · slack-thread-ask · slack-thread-self-reply\n' +
  '  slack-tier2-noise · jira-assigned · github-pr';

function printCheatsheet(fresh: boolean, mock: boolean): void {
  console.log(`
botty sandbox ${fresh ? '(fresh data dir seeded)' : '(reusing existing state)'}
  agent   ${AGENT_URL}   (web UI + API)
  sim     ${SIM_URL}   ← open this in a browser to inject ad-hoc events
  data    ${DIR}   (heartbeat.md/team.md hot-editable under config/)

  inject events:   open ${SIM_URL}  — or:  npm run sandbox inject <template-id>
  force poll:      npm run sandbox check [slack|gmail|gcal|jira|github]
  force tick:      npm run sandbox tick        resolution sweep:  npm run sandbox sweep
  mock time:       npm run sandbox warp -- --hours 6   (restarts the agent)
  stop / wipe:     npm run sandbox stop  ·  npm run sandbox reset

  templates: ${TEMPLATE_HINTS}

  Tier gate: only team.md CRITICAL/HIGH people get task extraction (Rodrigo is Tier-2 on purpose).
${
  mock
    ? '  ⚠ MOCK LLM: judgment always skips — tasks get captured but the agent will NEVER nudge.'
    : '  Real LLM via your Claude Code login — judgment may legitimately choose silence; check /inspector in the TUI.'
}`);
}

function attachTui(): void {
  console.log('\nAttaching TUI (quit with Ctrl+C — sim/agent keep running; `npm run sandbox stop` to shut down)…\n');
  spawnSync('npx', ['tsx', 'packages/tui/src/index.tsx', '--port', String(AGENT_PORT)], {
    cwd: REPO,
    stdio: 'inherit',
  });
  console.log(`\nTUI detached. Sandbox still running on ${AGENT_URL} — \`npm run sandbox stop\` to shut down.`);
}

async function start(opts: { tui: boolean; mock: boolean }): Promise<void> {
  const fresh = seedIfMissing();
  const simUp = listeningPids(SIM_PORT).length > 0;
  const agentUp = listeningPids(AGENT_PORT).length > 0;
  if (!simUp) spawnDetached('@botty/sim', 'sim.log', opts.mock);
  if (!agentUp) spawnDetached('@botty/agent', 'agent.log', opts.mock);
  if (simUp && agentUp) console.log('sim and agent already running — reusing them.');

  await waitHealthy(`${SIM_URL}/control/state`, path.join(DIR, 'logs', 'sim.log'));
  await waitHealthy(`${AGENT_URL}/api/health`, path.join(DIR, 'logs', 'agent.log'));

  // Confirm isolation before doing anything else.
  const health = await getJson(`${AGENT_URL}/api/health`);
  if (typeof health.dbPath === 'string' && !health.dbPath.startsWith(DIR)) {
    throw new Error(
      `agent on :${AGENT_PORT} uses dbPath ${health.dbPath}, outside ${DIR} — refusing to drive it. Is the port taken by another instance?`,
    );
  }

  // Expose the sandbox templates in the panel/inject API (idempotent; keeps
  // whatever scenario you loaded manually if it's already the sandbox one).
  const state = await getJson(`${SIM_URL}/control/state`);
  const loadedScenario = typeof state.scenario === 'string' ? state.scenario : state.scenario?.name;
  if (loadedScenario !== 'sandbox') {
    try {
      await post(`${SIM_URL}/control/scenario/load`, { name: 'sandbox' });
    } catch (err) {
      console.error(`warning: could not load the sandbox scenario: ${(err as Error).message}`);
    }
  }
  // Keep the scenario clock playing at 1:1. A paused clock freezes sim-now, so every
  // inject shares one occurredAt — the resolution sweep's per-task evidence watermark
  // (newest <= last-checked) then skips all re-checks as no_new_evidence forever.
  try {
    await post(`${SIM_URL}/control/scenario/play`, { speed: 1 });
  } catch (err) {
    console.error(`warning: could not start the sim clock: ${(err as Error).message}`);
  }

  printCheatsheet(fresh, opts.mock);
  if (opts.tui) attachTui();
}

async function stop(): Promise<void> {
  await killPort(AGENT_PORT);
  await killPort(SIM_PORT);
  console.log(`stopped listeners on :${AGENT_PORT} and :${SIM_PORT} (data kept in ${DIR}).`);
}

async function reset(opts: { tui: boolean; mock: boolean }): Promise<void> {
  await stop();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`wiped ${DIR}.`);
  await start(opts);
}

async function warp(args: string[], mock: boolean): Promise<void> {
  const passthrough = args.filter((a) => a !== '--');
  if (passthrough.length === 0) {
    throw new Error('usage: npm run sandbox warp -- --hours N | --days N');
  }
  const dbPath = path.join(DIR, 'data', 'botty.db');
  if (!fs.existsSync(dbPath)) throw new Error(`no sandbox DB at ${dbPath} — run \`npm run sandbox\` first.`);
  const agentWasUp = listeningPids(AGENT_PORT).length > 0;
  if (agentWasUp) {
    console.log('stopping sandbox agent (WAL lock + in-memory timers)…');
    await killPort(AGENT_PORT);
  }
  const res = spawnSync(
    'npm',
    ['run', '-w', '@botty/agent', 'timewarp', '--', ...passthrough, '--db', dbPath],
    { cwd: REPO, stdio: 'inherit' },
  );
  if (res.status !== 0) throw new Error('timewarp failed — agent left stopped; fix and `npm run sandbox` to restart.');
  spawnDetached('@botty/agent', 'agent.log', mock);
  await waitHealthy(`${AGENT_URL}/api/health`, path.join(DIR, 'logs', 'agent.log'));
  console.log(`agent restarted on :${AGENT_PORT}. (If a TUI was attached, relaunch it.)`);
}

async function inject(id: string | undefined): Promise<void> {
  const { templates } = await getJson(`${SIM_URL}/control/templates`);
  const template = (templates as Array<{ id: string; label: string; event: { source: string } }>).find(
    (t) => t.id === id,
  );
  if (!template) {
    const available = (templates as Array<{ id: string }>).map((t) => t.id).join('\n  ');
    throw new Error(`unknown template "${id ?? ''}". Available:\n  ${available}`);
  }
  await post(`${SIM_URL}/control/inject`, template.event);
  await post(`${AGENT_URL}/api/sources/${template.event.source}/check-now`);
  console.log(`injected "${template.label}" and forced a ${template.event.source} poll — watch the TUI.`);
}

async function check(source: string | undefined): Promise<void> {
  const targets = source ? [source] : [...SOURCES];
  for (const s of targets) {
    if (!(SOURCES as readonly string[]).includes(s)) throw new Error(`unknown source "${s}" (${SOURCES.join('|')})`);
    await post(`${AGENT_URL}/api/sources/${s}/check-now`);
  }
  console.log(`check-now fired for: ${targets.join(', ')} (completion lands in the Inspector).`);
}

async function status(): Promise<void> {
  const health = await getJson(`${AGENT_URL}/api/health`).catch(() => null);
  const state = await getJson(`${SIM_URL}/control/state`).catch(() => null);
  console.log(`agent :${AGENT_PORT} → ${health ? JSON.stringify(health) : 'DOWN'}`);
  const scenarioName =
    state && (typeof state.scenario === 'string' ? state.scenario : (state.scenario?.name ?? 'none'));
  console.log(`sim   :${SIM_PORT} → ${state ? `scenario=${scenarioName} clock=${JSON.stringify(state.clock)} released=${state.released?.length ?? '?'} pending=${state.pending?.length ?? '?'}` : 'DOWN'}`);
}

// ---------- main ----------

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const cmd = positional[0] ?? 'start';
  const opts = { tui: !flags.has('--no-tui'), mock: flags.has('--mock') };

  switch (cmd) {
    case 'start':
      await start(opts);
      break;
    case 'stop':
      await stop();
      break;
    case 'reset':
      await reset(opts);
      break;
    case 'warp': {
      // pass --hours/--days (and values) through to timewarp; strip sandbox-only flags
      const warpArgs = process.argv
        .slice(2)
        .filter((a) => a !== 'warp' && a !== '--' && a !== '--mock' && a !== '--no-tui');
      await warp(warpArgs, opts.mock);
      break;
    }
    case 'inject':
      await inject(positional[1]);
      break;
    case 'check':
      await check(positional[1]);
      break;
    case 'tick': {
      const out = await post(`${AGENT_URL}/api/loop/run-now`);
      console.log(`tick forced → ${JSON.stringify(out)} (reasoning in the Inspector).`);
      break;
    }
    case 'sweep':
      await post(`${AGENT_URL}/api/loop/sweep-now`);
      console.log('resolution sweep forced.');
      break;
    case 'status':
      await status();
      break;
    default:
      throw new Error(`unknown subcommand "${cmd}" (start|stop|reset|warp|inject|check|tick|sweep|status)`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
