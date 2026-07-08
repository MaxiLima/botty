import { AGENT_PORT } from '@botty/shared';

export interface TuiConfig {
  /** REST base, e.g. http://127.0.0.1:4820 (no trailing slash). */
  baseUrl: string;
  /** WS endpoint derived from baseUrl, e.g. ws://127.0.0.1:4820/ws. */
  wsUrl: string;
  historyLimit: number;
}

export const HELP = `botty-tui — terminal chat client for the botty agent

Usage: botty-tui [--host <host>] [--port <port>]

  --host <host>   agent host (default 127.0.0.1)
  --port <port>   agent port (default $AGENT_PORT or ${AGENT_PORT})

BOTTY_URL=<url> sets the full base URL instead (flags win over it).

Keys: Enter send · Esc interrupt streaming reply · Ctrl+C quit
Scrolling is your terminal's own scrollback.`;

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} requires a value`);
  return v;
}

function toWsUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  // Append to any existing path so a proxy prefix (BOTTY_URL=https://host/botty)
  // keeps working — the REST client preserves it too.
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws`;
  u.search = '';
  return u.toString();
}

export function parseConfig(argv: string[], env: Record<string, string | undefined>): TuiConfig {
  const host = flagValue(argv, '--host');
  const portFlag = flagValue(argv, '--port');
  if (portFlag !== undefined && !/^\d+$/.test(portFlag)) throw new Error('--port must be a number');

  let baseUrl: string;
  if (host !== undefined || portFlag !== undefined) {
    const port = portFlag ?? env.AGENT_PORT ?? String(AGENT_PORT);
    baseUrl = `http://${host ?? '127.0.0.1'}:${port}`;
  } else if (env.BOTTY_URL) {
    baseUrl = env.BOTTY_URL.replace(/\/+$/, '');
    // A scheme-less URL parses "fine" (host becomes the scheme) and then
    // explodes at WebSocket construction — fail with a clear message instead.
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('BOTTY_URL must start with http:// or https://');
  } else {
    baseUrl = `http://127.0.0.1:${env.AGENT_PORT ?? AGENT_PORT}`;
  }
  // Validates the URL early so a typo fails at startup, not on first request.
  return { baseUrl, wsUrl: toWsUrl(baseUrl), historyLimit: 60 };
}
