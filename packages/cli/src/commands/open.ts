import { spawnSync } from 'node:child_process';
import type { CliConfig } from '../config.js';
import { ensureUp } from './start.js';

export async function open(cfg: CliConfig): Promise<void> {
  await ensureUp(cfg);
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const res = spawnSync(opener, [cfg.agentUrl], { stdio: 'ignore' });
  if (res.status !== 0) throw new Error(`could not open a browser — the app is at ${cfg.agentUrl}`);
  console.log(`opened ${cfg.agentUrl}`);
}
