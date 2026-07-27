#!/usr/bin/env node
// Workspace packages ship TypeScript sources (like @botty/agent, which runs via
// tsx) — register tsx's ESM loader, then load the real entry point. The
// tsconfig is passed explicitly: tsx only auto-detects it from the cwd, and
// the bin can be invoked from anywhere.
import { fileURLToPath } from 'node:url';

let register;
try {
  ({ register } = await import('tsx/esm/api'));
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    // The classic first-run stumble: `npm link -w @botty/cli` succeeds without
    // the repo's dependencies being installed (e.g. after a failed `npm install`).
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    console.error(
      `botty: dependencies are not installed (cannot load tsx).\n` +
        `Run \`npm install\` in ${repoRoot} and make sure it completes without errors, then retry.`,
    );
    process.exit(1);
  }
  throw err;
}
register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) });
await import('../src/index.ts');
