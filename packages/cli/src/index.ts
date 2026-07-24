import { createRequire } from 'node:module';
import { HELP, parseConfig } from './config.js';
import { backfill } from './commands/backfill.js';
import { doctor } from './commands/doctor.js';
import { logs } from './commands/logs.js';
import { mcp } from './commands/mcp.js';
import { open } from './commands/open.js';
import { serve } from './commands/serve.js';
import { start } from './commands/start.js';
import { status } from './commands/status.js';
import { stop } from './commands/stop.js';
import { tui } from './commands/tui.js';
import { update } from './commands/update.js';

// `botty logs | head` closes stdout early — exit quietly instead of crashing.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

async function main(): Promise<void> {
  const cfg = parseConfig(process.argv.slice(2), process.env);
  switch (cfg.command) {
    case 'help':
      console.log(HELP);
      return;
    case 'version': {
      const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
      console.log(pkg.version);
      return;
    }
    case 'start':
      return start(cfg);
    case 'stop':
      return stop(cfg);
    case 'restart':
      await stop(cfg);
      return start(cfg);
    case 'status':
      return status(cfg);
    case 'logs':
      return logs(cfg);
    case 'serve':
      return serve(cfg);
    case 'tui':
      return tui(cfg);
    case 'open':
      return open(cfg);
    case 'doctor':
      return doctor(cfg);
    case 'mcp':
      return mcp(cfg);
    case 'backfill':
      return backfill(cfg);
    case 'update':
      return update(cfg);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
