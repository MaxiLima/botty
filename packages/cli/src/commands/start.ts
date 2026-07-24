import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CliConfig } from '../config.js';
import { getJson, waitHealthy } from '../http.js';
import { logPath, ownership, repoRoot, spawnDetached } from '../procs.js';

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
 * Bring the daemon up (idempotent): sim first when mode=sim, then the agent.
 * Foreign listeners on a target port are treated as the running instance —
 * reported, not fought. Verifies isolation before returning.
 */
export async function startDaemon(cfg: CliConfig): Promise<void> {
  ensureWebDist();

  if (cfg.mode === 'sim') {
    const sim = ownership(cfg, 'sim');
    if (sim.state === 'down') spawnDetached(cfg, 'sim');
    else console.log(`sim already running on :${cfg.simPort} (${sim.state === 'foreign' ? `pid ${sim.pid}, not started by botty` : 'reusing it'}).`);
    await waitHealthy(`${cfg.simUrl}/control/state`, logPath(cfg.dataDir, 'sim'));
  }

  const agent = ownership(cfg, 'agent');
  if (agent.state === 'down') spawnDetached(cfg, 'agent');
  else console.log(`agent already running on :${cfg.port} (${agent.state === 'foreign' ? `pid ${agent.pid}, not started by botty` : 'reusing it'}).`);
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
