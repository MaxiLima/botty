import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliConfig } from './config.js';
import { sleep } from './http.js';

export type ProcName = 'agent' | 'sim';

export interface Pidfile {
  pid: number;
  port: number;
  startedAt: string;
}

/** Repo root, resolved relative to this module (packages/cli/src → ../../..). */
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function pidfilePath(dataDir: string, name: ProcName): string {
  return path.join(dataDir, 'run', `${name}.pid`);
}

export function logPath(dataDir: string, name: ProcName): string {
  return path.join(dataDir, 'logs', `${name}.log`);
}

/** Parse pidfile JSON; null on garbage or missing fields. */
export function parsePidfile(content: string): Pidfile | null {
  try {
    const raw = JSON.parse(content);
    if (typeof raw.pid !== 'number' || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    if (typeof raw.port !== 'number') return null;
    return { pid: raw.pid, port: raw.port, startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '' };
  } catch {
    return null;
  }
}

/**
 * Does a `ps -o command=` line look like the botty entry point we spawn for
 * `name`? Guards against pid reuse: a recycled pid running something else must
 * never be claimed (and later killed) on the strength of a stale pidfile.
 */
export function commandLooksLikeBotty(name: ProcName, commandLine: string): boolean {
  return commandLine.includes(`@botty/${name}`) || commandLine.includes(`packages/${name}/src/index`);
}

function processCommand(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    return out || null;
  } catch {
    return null; // process gone
  }
}

export interface Claim {
  state: 'owned' | 'none';
  pidfile?: Pidfile;
}

/**
 * Read the pidfile for `name` and decide whether it still owns a live botty
 * process. Stale pidfiles (dead pid, unparseable, or a recycled pid running
 * something unrelated) are deleted on sight.
 */
export function claim(dataDir: string, name: ProcName): Claim {
  const file = pidfilePath(dataDir, name);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: 'none' };
  }
  const pidfile = parsePidfile(content);
  const cmd = pidfile ? processCommand(pidfile.pid) : null;
  if (!pidfile || cmd === null || !commandLooksLikeBotty(name, cmd)) {
    fs.rmSync(file, { force: true });
    return { state: 'none' };
  }
  return { state: 'owned', pidfile };
}

export function listeningPids(port: number): number[] {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map(Number);
  } catch {
    return []; // lsof exits 1 when nothing matches
  }
}

export type Ownership = 'owned' | 'foreign' | 'down';

/** Who is on this process's port: our pidfile-owned spawn, someone else, or nobody. */
export function ownership(cfg: CliConfig, name: ProcName): { state: Ownership; pid?: number } {
  const port = name === 'agent' ? cfg.port : cfg.simPort;
  const listeners = listeningPids(port);
  const owned = claim(cfg.dataDir, name);
  // The pidfile pid is the detached tsx wrapper, not the listener itself — a
  // live claim plus any listener on the port means it's ours.
  if (owned.state === 'owned' && listeners.length > 0) return { state: 'owned', pid: owned.pidfile!.pid };
  if (listeners.length > 0) return { state: 'foreign', pid: listeners[0] };
  return { state: 'down' };
}

/**
 * Env for spawned processes. When launched from inside a Claude Code session,
 * the session's internal env (CLAUDECODE, CLAUDE_CODE_*, its scoped
 * ANTHROPIC_API_KEY) leaks in and breaks the agent's SDK auth — strip it so the
 * SDK falls back to the user's own login. Only done when CLAUDECODE marks a
 * nested session; a deliberately exported user API key outside a session is
 * left alone.
 */
export function childEnv(cfg: CliConfig, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  if (env.CLAUDECODE) {
    for (const key of Object.keys(env)) {
      if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_') || key === 'CLAUDE_EFFORT') delete env[key];
    }
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return {
    ...env,
    BOTTY_DATA_DIR: cfg.dataDir,
    BOTTY_MODE: cfg.mode,
    AGENT_PORT: String(cfg.port),
    BOTTY_SIM_PORT: String(cfg.simPort),
    BOTTY_SIM_URL: cfg.simUrl,
    BOTTY_MOCK_LLM: cfg.mockLlm ? '1' : '0',
  };
}

/**
 * Spawn agent/sim detached (own process group), log to <dataDir>/logs, write
 * the pidfile. tsx is invoked directly with the absolute entry path — not via
 * `npm run`, whose process title collapses to an unidentifiable "npm run
 * start", which would defeat the pid-reuse guard in claim().
 */
export function spawnDetached(cfg: CliConfig, name: ProcName): number {
  fs.mkdirSync(path.join(cfg.dataDir, 'run'), { recursive: true });
  fs.mkdirSync(path.join(cfg.dataDir, 'logs'), { recursive: true });
  const fd = fs.openSync(logPath(cfg.dataDir, name), 'a');
  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
  const entry = path.join(repoRoot, 'packages', name, 'src', 'index.ts');
  const child = spawn(process.execPath, [tsxBin, entry], {
    cwd: path.join(repoRoot, 'packages', name),
    env: childEnv(cfg),
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);
  if (child.pid === undefined) throw new Error(`failed to spawn ${name}`);
  const pidfile: Pidfile = {
    pid: child.pid,
    port: name === 'agent' ? cfg.port : cfg.simPort,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(pidfilePath(cfg.dataDir, name), JSON.stringify(pidfile), 'utf8');
  return child.pid;
}

/**
 * SIGTERM the pidfile-owned process group (detached spawn → PGID = wrapper pid,
 * so the whole tsx → node chain gets the signal). Never SIGKILL, never
 * kill-by-port: a foreign listener is reported by the caller and left alone.
 */
export async function stopOwned(cfg: CliConfig, name: ProcName): Promise<'stopped' | 'not-running'> {
  const owned = claim(cfg.dataDir, name);
  if (owned.state !== 'owned') return 'not-running';
  const pid = owned.pidfile!.pid;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM'); // group already gone; try the wrapper alone
    } catch {
      /* already dead */
    }
  }
  for (let i = 0; i < 20; i++) {
    if (processCommand(pid) === null) break;
    await sleep(250);
  }
  if (processCommand(pid) !== null) {
    console.error(`warning: ${name} (pid ${pid}) still running 5s after SIGTERM — leaving it (never SIGKILL).`);
    return 'stopped';
  }
  fs.rmSync(pidfilePath(cfg.dataDir, name), { force: true });
  return 'stopped';
}
