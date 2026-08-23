import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import {
  acquireSpawnLock,
  claim,
  commandLooksLikeBotty,
  parsePidfile,
  pidfilePath,
  releaseSpawnLock,
  stopOwned,
} from '../src/procs.js';

function tmpConfig() {
  const cfg = parseConfig(['start'], {});
  cfg.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-procs-test-'));
  fs.mkdirSync(path.join(cfg.dataDir, 'run'), { recursive: true });
  return cfg;
}

/**
 * Spawn a detached process whose `ps -o command=` line satisfies
 * `commandLooksLikeBotty('agent', ...)`, so `claim()`/`stopOwned()` accept it
 * as pidfile-owned. `ignoreTerm` renames it via `exec -a` after making SIGTERM
 * a no-op, to exercise the "still running after SIGTERM" path.
 */
function spawnFakeAgent(ignoreTerm: boolean): number {
  const script = `${ignoreTerm ? 'trap "" TERM; ' : ''}exec -a "packages/agent/src/index.ts" sleep 30`;
  const child = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' });
  child.unref();
  if (child.pid === undefined) throw new Error('failed to spawn fake agent');
  return child.pid;
}

function writePidfile(dataDir: string, pid: number, port = 4820): void {
  fs.writeFileSync(pidfilePath(dataDir, 'agent'), JSON.stringify({ pid, port, startedAt: new Date().toISOString() }), 'utf8');
}

describe('parsePidfile', () => {
  it('parses a valid pidfile', () => {
    expect(parsePidfile('{"pid":123,"port":4820,"startedAt":"2026-07-18T00:00:00Z"}')).toEqual({
      pid: 123,
      port: 4820,
      startedAt: '2026-07-18T00:00:00Z',
    });
  });

  it('rejects garbage, missing/invalid pids, missing port', () => {
    expect(parsePidfile('not json')).toBeNull();
    expect(parsePidfile('{}')).toBeNull();
    expect(parsePidfile('{"pid":"123","port":4820}')).toBeNull();
    expect(parsePidfile('{"pid":-1,"port":4820}')).toBeNull();
    expect(parsePidfile('{"pid":1.5,"port":4820}')).toBeNull();
    expect(parsePidfile('{"pid":123}')).toBeNull();
  });

  it('tolerates a missing startedAt', () => {
    expect(parsePidfile('{"pid":123,"port":4820}')?.startedAt).toBe('');
  });
});

describe('commandLooksLikeBotty', () => {
  it('matches the tsx wrapper we spawn (absolute entry path)', () => {
    expect(
      commandLooksLikeBotty('agent', 'node /repo/node_modules/.bin/tsx /repo/packages/agent/src/index.ts'),
    ).toBe(true);
    expect(commandLooksLikeBotty('sim', 'node /repo/node_modules/.bin/tsx /repo/packages/sim/src/index.ts')).toBe(true);
  });

  it('never claims an unrelated process (pid reuse guard)', () => {
    expect(commandLooksLikeBotty('agent', '/usr/bin/some-daemon --port 4820')).toBe(false);
    expect(commandLooksLikeBotty('agent', 'npm run -w @botty/sim start')).toBe(false);
    expect(commandLooksLikeBotty('sim', 'npm run -w @botty/agent start')).toBe(false);
  });
});

describe('acquireSpawnLock / releaseSpawnLock', () => {
  it('the second acquirer is refused while the first holds the lock, then can acquire after release', () => {
    const cfg = tmpConfig();
    expect(acquireSpawnLock(cfg.dataDir, 'agent')).toBe(true);
    // A second `botty start` racing during the boot window must not also spawn.
    expect(acquireSpawnLock(cfg.dataDir, 'agent')).toBe(false);
    expect(acquireSpawnLock(cfg.dataDir, 'agent')).toBe(false);
    releaseSpawnLock(cfg.dataDir, 'agent');
    expect(acquireSpawnLock(cfg.dataDir, 'agent')).toBe(true);
    releaseSpawnLock(cfg.dataDir, 'agent');
  });

  it('locks for different proc names are independent', () => {
    const cfg = tmpConfig();
    expect(acquireSpawnLock(cfg.dataDir, 'agent')).toBe(true);
    expect(acquireSpawnLock(cfg.dataDir, 'sim')).toBe(true);
    releaseSpawnLock(cfg.dataDir, 'agent');
    releaseSpawnLock(cfg.dataDir, 'sim');
  });

  it('reclaims a stale lock (owner crashed before releasing)', () => {
    const cfg = tmpConfig();
    const lockFile = path.join(cfg.dataDir, 'run', 'agent.starting');
    fs.writeFileSync(lockFile, '999999');
    const old = Date.now() - 60_000;
    fs.utimesSync(lockFile, old / 1000, old / 1000);
    expect(acquireSpawnLock(cfg.dataDir, 'agent')).toBe(true);
    releaseSpawnLock(cfg.dataDir, 'agent');
  });
});

describe('stopOwned', () => {
  const spawned: number[] = [];
  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  it('returns not-running when there is no pidfile', async () => {
    const cfg = tmpConfig();
    expect(await stopOwned(cfg, 'agent')).toBe('not-running');
  });

  it('stops a process that honors SIGTERM and removes the pidfile', async () => {
    const cfg = tmpConfig();
    const pid = spawnFakeAgent(false);
    spawned.push(pid);
    writePidfile(cfg.dataDir, pid);
    expect(await stopOwned(cfg, 'agent')).toBe('stopped');
    expect(fs.existsSync(pidfilePath(cfg.dataDir, 'agent'))).toBe(false);
    expect(claim(cfg.dataDir, 'agent').state).toBe('none');
  }, 10_000);

  it('honestly reports still-running instead of a false "stopped" when SIGTERM is ignored', async () => {
    const cfg = tmpConfig();
    const pid = spawnFakeAgent(true);
    spawned.push(pid);
    writePidfile(cfg.dataDir, pid);
    // stopOwned must never claim success for a process it couldn't kill —
    // regression for the report's "prints stopped when it didn't exit" bug.
    expect(await stopOwned(cfg, 'agent')).toBe('still-running');
    // Pidfile is left in place: the process is still the real owner.
    expect(fs.existsSync(pidfilePath(cfg.dataDir, 'agent'))).toBe(true);
  }, 10_000);
});
