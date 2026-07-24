import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { CliConfig } from '../config.js';
import { logPath } from '../procs.js';

export function logs(cfg: CliConfig): void {
  const target = cfg.args[0] ?? 'agent';
  if (target !== 'agent' && target !== 'sim') throw new Error(`unknown log "${target}" (agent|sim)`);
  const file = logPath(cfg.dataDir, target);
  if (!fs.existsSync(file)) throw new Error(`no log at ${file} — has \`botty start\` run with this data dir?`);
  if (cfg.follow) {
    spawnSync('tail', ['-f', '-n', '50', file], { stdio: 'inherit' });
  } else {
    spawnSync('tail', ['-n', '200', file], { stdio: 'inherit' });
  }
}
