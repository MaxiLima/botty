import os from 'node:os';
import path from 'node:path';
import { AGENT_PORT, SIM_PORT } from '@botty/shared';

export type Command =
  | 'start'
  | 'stop'
  | 'restart'
  | 'status'
  | 'logs'
  | 'serve'
  | 'tui'
  | 'open'
  | 'doctor'
  | 'mcp'
  | 'backfill'
  | 'update'
  | 'help'
  | 'version';

export interface CliConfig {
  command: Command;
  /** Positional args after the command (e.g. `logs sim`). */
  args: string[];
  port: number;
  simPort: number;
  /** Absolute. */
  dataDir: string;
  mode: 'sim' | 'real';
  mockLlm: boolean;
  noStart: boolean;
  withSim: boolean;
  follow: boolean;
  force: boolean;
  probe: boolean;
  noWait: boolean;
  /** backfill: --source slack,gmail (undefined = all backfillable sources). */
  backfillSources?: string[];
  /** backfill: --days lookback window. */
  days?: number;
  /** backfill: --max-llm-calls distillation cap. */
  maxLlmCalls?: number;
  agentUrl: string;
  simUrl: string;
}

export const HELP = `botty — start and drive the botty daemon (agent + sim) and its clients

Usage: botty <command> [flags]

  start              boot the daemon detached (idempotent), print the app URL.
                     Runs REAL mode by default (gmail/gcal via your claude.ai
                     connectors); --sim boots the simulator instead
  stop               stop the processes botty started (pidfile-owned only)
  restart            stop + start
  status             per-process pid/port/ownership + agent health, sim state
  logs [agent|sim]   print the last 200 log lines (default agent); -f to tail
  serve              run the agent in the foreground (for launchd/systemd)
  tui                attach the terminal client (starts the daemon if needed)
  open               open the web app in the browser (aliases: gui, web)
  doctor             check the environment: node, web build, agent, LLM auth
  mcp list           show MCP servers configured in Claude Code + import status
  mcp import [keys]  copy Claude Code MCP servers into ~/.botty/config/mcp.json
                     (tools default-deny — see docs/specs/mcp.md)
  backfill           one-shot historical ingest for context only — people,
                     interactions, calendar, decisions; never tasks
                     (docs/specs/backfill.md). Subcommands: status, cancel, resume
  backfill status    print the current/last run's progress
  backfill cancel    stop a running backfill (state is kept for resume)
  update             pull the latest version (git ff-only), reinstall/rebuild
                     as needed, restart what botty was running

Flags:
  --port <n>         agent port         (default $AGENT_PORT or ${AGENT_PORT})
  --sim-port <n>     sim port           (default $BOTTY_SIM_PORT or ${SIM_PORT})
  --data-dir <path>  data directory     (default $BOTTY_DATA_DIR or ~/.botty)
  --sim              run against the built-in simulator (BOTTY_MODE=sim);
                     without it botty runs real mode
  --mock-llm         run with the deterministic LLM stub (BOTTY_MOCK_LLM=1)
  --no-start         tui/open: fail instead of starting the daemon implicitly
  --with-sim         serve: also spawn the sim (detached) first
  --force            mcp import: overwrite existing entries (keeps their tools)
  --probe            mcp import: spawn each imported server once via the agent
                     to discover tools (may disturb a live Claude Code session)
  --source <list>    backfill: comma-separated sources (default slack,gmail,gcal)
  --days <n>         backfill: lookback window in days (default 30)
  --max-llm-calls <n> backfill: distillation call cap; 0 = deterministic only
  --no-wait          backfill: kick off and return without polling progress
  -f, --follow       logs: tail -f
  -h, --help         this help · -V, --version

Dev tooling stays in npm scripts: npm run sandbox / timewarp / replay.`;

const COMMAND_ALIASES: Record<string, Command> = {
  start: 'start',
  stop: 'stop',
  restart: 'restart',
  status: 'status',
  logs: 'logs',
  serve: 'serve',
  tui: 'tui',
  open: 'open',
  gui: 'open',
  web: 'open',
  doctor: 'doctor',
  mcp: 'mcp',
  backfill: 'backfill',
  update: 'update',
  upgrade: 'update',
  help: 'help',
};

const VALUE_FLAGS = ['--port', '--sim-port', '--data-dir', '--source', '--days', '--max-llm-calls'] as const;
const BOOL_FLAGS = ['--sim', '--mock-llm', '--no-start', '--with-sim', '--force', '--probe', '--no-wait', '-f', '--follow', '-h', '--help', '-V', '--version'] as const;

function truthy(v: string | undefined): boolean {
  return v === '1' || v?.toLowerCase() === 'true';
}

function parsePort(name: string, raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a number`);
  return Number(raw);
}

function parseCount(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  return Number(raw);
}

export function parseConfig(argv: string[], env: Record<string, string | undefined>): CliConfig {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if ((VALUE_FLAGS as readonly string[]).includes(arg)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) throw new Error(`${arg} requires a value`);
      values.set(arg, v);
      i++;
    } else if ((BOOL_FLAGS as readonly string[]).includes(arg)) {
      bools.add(arg);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown flag ${arg} (botty --help)`);
    } else {
      positional.push(arg);
    }
  }

  let command: Command;
  if (bools.has('-V') || bools.has('--version')) {
    command = 'version';
  } else if (bools.has('-h') || bools.has('--help') || positional.length === 0) {
    command = 'help';
  } else {
    const resolved = COMMAND_ALIASES[positional[0]!];
    if (!resolved) throw new Error(`unknown command "${positional[0]}" (botty --help)`);
    command = resolved;
  }

  const port = values.has('--port')
    ? parsePort('--port', values.get('--port')!)
    : env.AGENT_PORT !== undefined
      ? parsePort('AGENT_PORT', env.AGENT_PORT)
      : AGENT_PORT;
  const simPort = values.has('--sim-port')
    ? parsePort('--sim-port', values.get('--sim-port')!)
    : env.BOTTY_SIM_PORT !== undefined
      ? parsePort('BOTTY_SIM_PORT', env.BOTTY_SIM_PORT)
      : SIM_PORT;
  const dataDir = path.resolve(values.get('--data-dir') ?? env.BOTTY_DATA_DIR ?? path.join(os.homedir(), '.botty'));

  return {
    command,
    args: positional.slice(1),
    port,
    simPort,
    dataDir,
    // Real mode is the default since the 2026-07-27 gmail/gcal connector
    // drivers: `botty start` runs the actual app. `--sim` (or BOTTY_MODE=sim)
    // opts into the simulator; dev npm scripts keep their own sim default.
    mode: bools.has('--sim') || env.BOTTY_MODE === 'sim' ? 'sim' : 'real',
    mockLlm: bools.has('--mock-llm') || truthy(env.BOTTY_MOCK_LLM),
    noStart: bools.has('--no-start'),
    withSim: bools.has('--with-sim'),
    follow: bools.has('-f') || bools.has('--follow'),
    force: bools.has('--force'),
    probe: bools.has('--probe'),
    noWait: bools.has('--no-wait'),
    backfillSources: values
      .get('--source')
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    days: parseCount('--days', values.get('--days')),
    maxLlmCalls: parseCount('--max-llm-calls', values.get('--max-llm-calls')),
    agentUrl: `http://127.0.0.1:${port}`,
    simUrl: env.BOTTY_SIM_URL ?? `http://localhost:${simPort}`,
  };
}
