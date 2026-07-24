import { spawnSync } from 'node:child_process';
import type { CliConfig } from '../config.js';
import { waitHealthy } from '../http.js';
import { childEnv, logPath, ownership, repoRoot, spawnDetached } from '../procs.js';
import { ensureWebDist } from './start.js';

/**
 * Run the agent in the foreground (stdio inherited, no pidfile) — the shape a
 * launchd/systemd unit wants. In sim mode the sim must already be up;
 * --with-sim spawns it detached first.
 */
export async function serve(cfg: CliConfig): Promise<void> {
  ensureWebDist();
  if (cfg.mode === 'sim' && cfg.withSim && ownership(cfg, 'sim').state === 'down') {
    spawnDetached(cfg, 'sim');
    await waitHealthy(`${cfg.simUrl}/control/state`, logPath(cfg.dataDir, 'sim'));
  }
  const res = spawnSync('npm', ['run', '-w', '@botty/agent', 'start'], {
    cwd: repoRoot,
    env: childEnv(cfg),
    stdio: 'inherit',
  });
  process.exitCode = res.status ?? 0;
}
