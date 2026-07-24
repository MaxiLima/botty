import { spawnSync } from 'node:child_process';
import type { CliConfig } from '../config.js';
import { childEnv, repoRoot } from '../procs.js';
import { ensureUp } from './start.js';

export async function tui(cfg: CliConfig): Promise<void> {
  await ensureUp(cfg);
  const res = spawnSync('npm', ['run', '-w', '@botty/tui', 'start', '--', '--port', String(cfg.port)], {
    cwd: repoRoot,
    env: childEnv(cfg),
    stdio: 'inherit',
  });
  process.exitCode = res.status ?? 0;
}
