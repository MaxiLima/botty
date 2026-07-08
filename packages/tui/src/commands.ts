import {
  CONFIG_FILE_NAMES,
  type AiDecision,
  type ConfigFileName,
  type Interaction,
  type Person,
  type SourceCheckRow,
  type Task,
  type TickLogRow,
} from '@botty/shared';
import type { Api } from './api.js';
import { byPriorityThenAge } from './format.js';

/** Structured output of a slash command, rendered as a block in the transcript. */
export type PanelData =
  | { type: 'help' }
  | { type: 'welcome'; version: string; mode: string; baseUrl: string; taskCount: number }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'people'; people: Person[] }
  | { type: 'person'; person: Person; interactions: Interaction[]; tasks: Task[] }
  | { type: 'inspector'; decisions: AiDecision[]; ticks: TickLogRow[]; checks: SourceCheckRow[] }
  | { type: 'config'; name: string; content: string }
  | { type: 'health'; ok: boolean; version: string; mode: string; dbPath: string; baseUrl: string };

export interface CommandResult {
  panel?: PanelData;
  info?: string;
  error?: string;
  /** Side effects the App owns (sealing prints a seam; quit unmounts). */
  action?: 'seal' | 'quit';
}

export interface Command {
  name: string;
  /** Argument hint shown in the menu, e.g. "[name]". */
  args?: string;
  description: string;
  run: (api: Api, arg: string, baseUrl: string) => Promise<CommandResult>;
}

export const COMMANDS: Command[] = [
  {
    name: 'help',
    description: 'commands & keys',
    run: async () => ({ panel: { type: 'help' } }),
  },
  {
    name: 'tasks',
    description: 'open task board',
    run: async (api) => {
      const { tasks } = await api.tasks('open');
      return { panel: { type: 'tasks', tasks: [...tasks].sort(byPriorityThenAge) } };
    },
  },
  {
    name: 'people',
    args: '[name]',
    description: 'team roster, or one person in detail',
    run: async (api, arg) => {
      const { people } = await api.people();
      if (!arg) return { panel: { type: 'people', people } };
      const q = arg.toLowerCase();
      const hit = people.find(
        (p) => p.name.toLowerCase().includes(q) || (p.slackHandle ?? '').toLowerCase().includes(q),
      );
      if (!hit) return { error: `no person matching "${arg}" — /people lists everyone` };
      const detail = await api.person(hit.id);
      return { panel: { type: 'person', ...detail } };
    },
  },
  {
    name: 'inspector',
    description: 'recent AI decisions, ticks & source checks',
    run: async (api) => {
      const [d, t, c] = await Promise.all([api.decisions({ limit: 8 }), api.ticks(5), api.sourceChecks(5)]);
      return { panel: { type: 'inspector', decisions: d.decisions, ticks: t.ticks, checks: c.checks } };
    },
  },
  {
    name: 'config',
    args: '[persona|team|heartbeat]',
    description: 'view a config file (edit in the web app)',
    run: async (api, arg) => {
      const { files } = await api.config();
      const name = (arg.toLowerCase() || 'persona') as ConfigFileName;
      if (!CONFIG_FILE_NAMES.includes(name))
        return { error: `unknown config "${arg}" — ${CONFIG_FILE_NAMES.join(', ')}` };
      return { panel: { type: 'config', name: `${name}.md`, content: files[name] } };
    },
  },
  {
    name: 'health',
    description: 'agent status',
    run: async (api, _arg, baseUrl) => {
      const h = await api.health();
      return { panel: { type: 'health', ...h, baseUrl } };
    },
  },
  {
    name: 'new',
    description: 'seal the session, start fresh context',
    run: async (api) => {
      await api.chatSeal();
      return { action: 'seal' };
    },
  },
  {
    name: 'quit',
    description: 'exit botty-tui',
    run: async () => ({ action: 'quit' }),
  },
];

/** "/people marian " → { name: 'people', arg: 'marian' }; null if not a slash input. */
export function parseSlash(input: string): { name: string; arg: string } | null {
  const m = /^\/(\S*)\s*(.*)$/.exec(input.trim());
  if (!m) return null;
  return { name: (m[1] ?? '').toLowerCase(), arg: (m[2] ?? '').trim() };
}

/**
 * Prefix-match commands for the autocomplete menu while the command *name* is
 * being typed. Once an argument starts the menu closes — dispatch then goes
 * through resolveCommand, so menu presentation can't change what Enter runs.
 */
export function filterCommands(input: string): Command[] {
  const parsed = parseSlash(input);
  if (!parsed || parsed.arg || /\s$/.test(input)) return [];
  return COMMANDS.filter((c) => c.name.startsWith(parsed.name));
}

/** Exact-name lookup for dispatch. */
export function resolveCommand(name: string): Command | undefined {
  return COMMANDS.find((c) => c.name === name);
}
