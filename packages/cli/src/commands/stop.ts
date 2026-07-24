import type { CliConfig } from '../config.js';
import { ownership, stopOwned } from '../procs.js';
import type { ProcName } from '../procs.js';

export async function stop(cfg: CliConfig): Promise<void> {
  for (const name of ['agent', 'sim'] as ProcName[]) {
    const port = name === 'agent' ? cfg.port : cfg.simPort;
    const before = ownership(cfg, name);
    if (before.state === 'foreign') {
      console.log(`${name} :${port} — foreign listener (pid ${before.pid}, not started by botty) — not stopping.`);
      continue;
    }
    const result = await stopOwned(cfg, name);
    console.log(`${name} :${port} — ${result === 'stopped' ? 'stopped' : 'not running'}.`);
  }
  console.log(`data kept in ${cfg.dataDir}.`);
}
