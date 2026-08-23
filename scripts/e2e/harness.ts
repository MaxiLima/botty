/**
 * e2e harness — spawn an isolated sim + agent pair (mock LLM, temp data dir,
 * free ports) and tear it down. Reusable primitive for `npm run e2e`
 * (scripts/e2e/run.ts) and any future integration test.
 *
 * Safety: never touches the owner's live 4820/4821, the /verify 5820/5821 pair
 * or the 6820/6821 sandbox — ports are allocated by the OS (ephemeral range),
 * the data dir is a fresh mkdtemp, and only the child processes this harness
 * spawned are ever signalled.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SOURCES = ['slack', 'gmail', 'gcal', 'jira', 'github'] as const;

export interface InstanceOptions {
  /** BOTTY_MOCK_LLM=1 (default true). */
  mock?: boolean;
  /** Extra env for both processes. */
  env?: Record<string, string>;
  /** Keep child stdout/stderr in these files (default: <dataDir>/logs/e2e-*.log). */
  logDir?: string;
  /** Seed heartbeat.md with the fast profile (all time gates collapsed) before boot. Default true. */
  fastHeartbeat?: boolean;
  /** Boot timeout in ms (default 30s). */
  bootTimeoutMs?: number;
}

export interface Instance {
  agentPort: number;
  simPort: number;
  agentUrl: string;
  simUrl: string;
  dataDir: string;
  dbPath: string;
  /** Restart only the agent (e.g. around a timewarp). Resolves once healthy. */
  restartAgent(): Promise<void>;
  /** Stop only the agent (SIGTERM + wait). */
  stopAgent(): Promise<void>;
  /** Stop everything; remove the data dir unless keep=true. */
  teardown(keep?: boolean): Promise<void>;
}

/** Ask the OS for a free TCP port (ephemeral range — never the reserved dev ports). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** heartbeat.md fast profile: working/quiet hours disabled, min-age/gaps zeroed, fast sweeps. */
export function fastHeartbeatMd(): string {
  const template = fs.readFileSync(path.join(REPO, 'packages/agent/config-templates/heartbeat.md'), 'utf8');
  const patches: Array<[string, string]> = [
    ['tick_interval_min: 20', 'tick_interval_min: 60'],
    ['working_hours: 08:00-19:00', 'working_hours: 00:00-00:00'],
    ['quiet_hours: 22:00-08:00', 'quiet_hours: 00:00-00:00'],
    ['active_days: mon,tue,wed,thu,fri', 'active_days: mon,tue,wed,thu,fri,sat,sun'],
    ['chat_active_gate_min: 2', 'chat_active_gate_min: 0'],
    ['never_surfaced_min_age_hours: 4', 'never_surfaced_min_age_hours: 0'],
    ['min_gap_between_nudges_min: 30', 'min_gap_between_nudges_min: 0'],
    ['resolution_check_cooldown_min: 10', 'resolution_check_cooldown_min: 0'],
    ['commitment_min_age_min: 30', 'commitment_min_age_min: 0'],
    ['morning_brief_at: 08:45', 'morning_brief_at: 03:33'],
    ['evening_brief_at: 18:00', 'evening_brief_at: 03:34'],
  ];
  let out = template;
  for (const [from, to] of patches) {
    if (!out.includes(from)) throw new Error(`heartbeat template no longer contains "${from}" — update scripts/e2e/harness.ts`);
    out = out.replace(from, to);
  }
  return out;
}

/** Strip the Claude Code session env so a spawned agent never inherits a nested-session auth. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_EFFORT' || key === 'CLAUDE_PID') delete env[key];
  }
  delete env.BOTTY_MOCK_LLM;
  delete env.BOTTY_URL;
  return { ...env, ...extra };
}

async function waitFor(url: string, timeoutMs: number, label: string): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not come up within ${timeoutMs}ms (${String(lastErr)})`);
}

function stopChild(child: ChildProcess | null, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export async function startInstance(opts: InstanceOptions = {}): Promise<Instance> {
  const mock = opts.mock ?? true;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-e2e-'));
  const logDir = opts.logDir ?? path.join(dataDir, 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
  if (opts.fastHeartbeat ?? true) {
    fs.writeFileSync(path.join(dataDir, 'config', 'heartbeat.md'), fastHeartbeatMd());
  }
  const agentPort = await freePort();
  const simPort = await freePort();
  const agentUrl = `http://127.0.0.1:${agentPort}`;
  const simUrl = `http://127.0.0.1:${simPort}`;
  const env = childEnv({
    AGENT_PORT: String(agentPort),
    BOTTY_SIM_PORT: String(simPort),
    BOTTY_SIM_URL: simUrl,
    BOTTY_DATA_DIR: dataDir,
    BOTTY_MODE: 'sim',
    ...(mock ? { BOTTY_MOCK_LLM: '1' } : {}),
    ...(opts.env ?? {}),
  });
  const tsx = path.join(REPO, 'node_modules', '.bin', 'tsx');
  const bootTimeoutMs = opts.bootTimeoutMs ?? 30_000;

  const spawnOne = (name: 'sim' | 'agent'): ChildProcess => {
    const entry = name === 'sim' ? 'packages/sim/src/index.ts' : 'packages/agent/src/index.ts';
    const out = fs.openSync(path.join(logDir, `e2e-${name}.log`), 'a');
    const child = spawn(tsx, [entry], { cwd: REPO, env, stdio: ['ignore', out, out] });
    child.on('exit', () => fs.closeSync(out));
    return child;
  };

  let sim: ChildProcess | null = spawnOne('sim');
  let agent: ChildProcess | null = spawnOne('agent');
  try {
    await waitFor(`${simUrl}/control/state`, bootTimeoutMs, 'sim');
    const health = (await waitFor(`${agentUrl}/api/health`, bootTimeoutMs, 'agent')) as { dbPath: string };
    if (!health.dbPath.startsWith(dataDir)) {
      throw new Error(`agent dbPath ${health.dbPath} is outside the temp data dir ${dataDir} — refusing to continue`);
    }
  } catch (err) {
    await Promise.all([stopChild(sim), stopChild(agent)]);
    throw err;
  }

  const instance: Instance = {
    agentPort,
    simPort,
    agentUrl,
    simUrl,
    dataDir,
    dbPath: path.join(dataDir, 'data', 'botty.db'),
    async stopAgent() {
      await stopChild(agent);
      agent = null;
    },
    async restartAgent() {
      await stopChild(agent);
      agent = spawnOne('agent');
      await waitFor(`${agentUrl}/api/health`, bootTimeoutMs, 'agent (restart)');
    },
    async teardown(keep = false) {
      await Promise.all([stopChild(agent), stopChild(sim)]);
      agent = null;
      sim = null;
      if (!keep) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
  return instance;
}

/** Run the timewarp CLI against an instance's DB (agent must be stopped first). */
export function timewarp(inst: Instance, args: string[]): string {
  const tsx = path.join(REPO, 'node_modules', '.bin', 'tsx');
  const r = spawnSync(tsx, ['packages/agent/src/tools/timewarp.ts', ...args], {
    cwd: REPO,
    env: childEnv({ BOTTY_DATA_DIR: inst.dataDir }),
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`timewarp failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

// ---------- tiny HTTP helpers ----------

export async function getJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function postJson<T = unknown>(url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: parsed as T };
}

export async function putJson<T = unknown>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, body: parsed as T };
}

/** Poll `fn` until it returns a truthy value or the timeout elapses. */
export async function until<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, label: string, everyMs = 300): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
      last = v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label} (last: ${String(last)})`);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
