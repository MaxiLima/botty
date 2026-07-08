#!/usr/bin/env node
// Workspace packages ship TypeScript sources (like @botty/agent, which runs via
// tsx) — register tsx's ESM loader, then load the real entry point. The
// tsconfig is passed explicitly: tsx only auto-detects it from the cwd, and
// the bin can be invoked from anywhere.
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) });
await import('../src/index.tsx');
