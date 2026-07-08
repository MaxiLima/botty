import { loadEnv } from './env.js';
import { Db } from './db/index.js';
import { createBus } from './bus/index.js';
import { createConfig } from './config/index.js';
import { createLlm } from './llm/index.js';
import { createMemory } from './memory/index.js';
import { createChat } from './chat/index.js';
import { createIngest } from './ingest/index.js';
import { createLoop } from './loop/index.js';
import { createServer } from './server/index.js';
import type { AgentContext } from './context.js';

async function main(): Promise<void> {
  // 1. env — dirs created, templates seeded
  const env = loadEnv();
  // 2. db — migrations run on open
  const db = new Db(env.dbPath);
  // 3. bus
  const bus = createBus();
  // 4. config — load, materialize people from TEAM.md, hot-reload watcher
  const config = createConfig(env, db, bus);
  config.materializePeople();
  config.startWatching();
  // 5. llm
  const llm = await createLlm({ env, db, bus });
  // 6. memory
  const memory = createMemory({ db, config });
  // 7. chat
  const chat = createChat({ db, bus, llm, memory });

  const ctx: AgentContext = { env, db, bus, config, llm, memory, chat };

  // 8-10. ingest → loop → server
  const ingest = createIngest(ctx);
  const loop = createLoop(ctx);
  const server = createServer(ctx, { ingest, loop });

  await server.start();
  ingest.start();
  loop.start();

  console.log(
    `[botty] agent up on http://localhost:${env.port} (mode=${env.mode}, mockLlm=${env.mockLlm}, db=${env.dbPath})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[botty] ${signal} — shutting down…`);
    try {
      loop.stop();
      ingest.stop();
      await server.stop();
      await config.stop();
      db.close();
    } catch (err) {
      console.error('[botty] shutdown error:', err);
      process.exitCode = 1;
    }
    process.exit();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  const errno = err as NodeJS.ErrnoException & { port?: number };
  if (errno?.code === 'EADDRINUSE') {
    // Routine when a second instance starts next to a live one — no stack trace.
    console.error(
      `[botty] port ${errno.port ?? '?'} is already in use — is another agent running? ` +
        'Set AGENT_PORT to use a different port.',
    );
    process.exit(1);
  }
  console.error('[botty] fatal:', err);
  process.exit(1);
});
