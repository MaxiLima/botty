import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CliConfig } from '../config.js';
import { getJson, waitHealthy } from '../http.js';
import { acquireSpawnLock, logPath, ownership, releaseSpawnLock, repoRoot, spawnDetached } from '../procs.js';
import type { ProcName } from '../procs.js';

export const webDistIndex = path.join(repoRoot, 'packages/web/dist/index.html');

/**
 * The agent serves packages/web/dist. Build it iff absent — an existing dist is
 * never rebuilt (a live agent may be serving it, CLAUDE.md rule); `doctor`
 * reports staleness instead.
 */
export function ensureWebDist(): void {
  if (fs.existsSync(webDistIndex)) return;
  console.log('web UI not built yet — running `npm run build -w @botty/web` (one time)…');
  const res = spawnSync('npm', ['run', 'build', '-w', '@botty/web'], { cwd: repoRoot, stdio: 'inherit' });
  if (res.status !== 0) throw new Error('web build failed — fix it and re-run `botty start`.');
}

/**
 * Spawn `name` iff nothing owns it yet — guarded so a second `botty start`
 * racing during the boot window (child spawned but not yet listening, so
 * `ownership()` still reads "down") can't also spawn and overwrite the first
 * spawn's pidfile. Losing the race just means waiting for the winner's
 * `waitHealthy` below instead of spawning a duplicate.
 */
async function spawnIfDown(cfg: CliConfig, name: ProcName, label: string): Promise<void> {
  const before = ownership(cfg, name);
  if (before.state !== 'down') {
    const port = name === 'agent' ? cfg.port : cfg.simPort;
    console.log(`${label} already running on :${port} (${before.state === 'foreign' ? `pid ${before.pid}, not started by botty` : 'reusing it'}).`);
    return;
  }
  if (!acquireSpawnLock(cfg.dataDir, name)) {
    console.log(`another \`botty start\` is already bringing up ${label} — waiting for it.`);
    return;
  }
  try {
    // Re-check: the lock winner may have finished spawning while we waited on I/O above.
    if (ownership(cfg, name).state === 'down') spawnDetached(cfg, name);
  } finally {
    releaseSpawnLock(cfg.dataDir, name);
  }
}

/**
 * Bring the daemon up (idempotent): sim first when mode=sim, then the agent.
 * Foreign listeners on a target port are treated as the running instance —
 * reported, not fought. Verifies isolation before returning.
 */
export async function startDaemon(cfg: CliConfig): Promise<void> {
  ensureWebDist();

  if (cfg.mode === 'sim') {
    await spawnIfDown(cfg, 'sim', 'sim');
    await waitHealthy(`${cfg.simUrl}/control/state`, logPath(cfg.dataDir, 'sim'));
  }

  await spawnIfDown(cfg, 'agent', 'agent');
  await waitHealthy(`${cfg.agentUrl}/api/health`, logPath(cfg.dataDir, 'agent'));

  // Isolation: the agent answering on this port must be using our data dir.
  const health = await getJson(`${cfg.agentUrl}/api/health`);
  if (typeof health.dbPath === 'string' && !health.dbPath.startsWith(cfg.dataDir + path.sep)) {
    throw new Error(
      `agent on :${cfg.port} uses dbPath ${health.dbPath}, outside ${cfg.dataDir} — refusing to drive it. ` +
        `Is the port taken by another instance? (--port/--data-dir to disambiguate)`,
    );
  }
}

export async function start(cfg: CliConfig): Promise<void> {
  await startDaemon(cfg);
  console.log(`
botty is up
  app     ${cfg.agentUrl}   (web UI + API — \`botty open\`)
  tui     botty tui${cfg.mode === 'sim' ? `\n  sim     ${cfg.simUrl}   (inject events, drive the scenario clock)` : ''}
  data    ${cfg.dataDir}
  logs    botty logs [-f]   ·   stop: botty stop`);
}

/** Shared by `tui`/`open`: make sure something is answering, honoring --no-start. */
export async function ensureUp(cfg: CliConfig): Promise<void> {
  if (ownership(cfg, 'agent').state !== 'down') return;
  if (cfg.noStart) throw new Error(`nothing listening on :${cfg.port} and --no-start given — run \`botty start\` first.`);
  await startDaemon(cfg);
}
