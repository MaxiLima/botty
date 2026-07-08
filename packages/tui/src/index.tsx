// Explicit React import: tsx/esbuild only picks up this package's tsconfig
// (jsx: react-jsx) when run from inside it; the classic transform needs React
// in scope so the bin works from any cwd.
import React from 'react';
import { render } from 'ink';
import { App } from './App.js';
import { HELP, parseConfig } from './config.js';
import { stopWs } from './ws.js';

const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

let config;
try {
  config = parseConfig(argv, process.env);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

if (!process.stdin.isTTY) {
  console.error('botty-tui needs an interactive terminal (stdin is not a TTY)');
  process.exit(1);
}

const { waitUntilExit } = render(<App config={config} />);
await waitUntilExit();
// The WS socket and its reconnect timers keep the event loop alive after Ink
// unmounts (via /quit or Ctrl+C) — shut down explicitly.
stopWs();
process.exit(0);
