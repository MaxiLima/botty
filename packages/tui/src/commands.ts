import {
  CONFIG_FILE_NAMES,
  type AiDecision,
  type ConfigFileName,
  type CostsReport,
  type Interaction,
  type PendingAction,
  type Person,
  type SourceCheckRow,
  type Task,
  type TickLogRow,
} from '@botty/shared';
import type { Api } from './api.js';
import { byPriorityThenAge } from './format.js';
import { sanitizeTerminalText } from './sanitize.js';

/** Structured output of a slash command, rendered as a block in the transcript. */
export type PanelData =
  | { type: 'help' }
  | { type: 'welcome'; version: string; mode: string; baseUrl: string; taskCount: number; onboarded: boolean }
  | { type: 'tasks'; tasks: Task[] }
  | { type: 'people'; people: Person[] }
  | { type: 'person'; person: Person; interactions: Interaction[]; tasks: Task[] }
  | { type: 'inspector'; decisions: AiDecision[]; ticks: TickLogRow[]; checks: SourceCheckRow[] }
  | { type: 'costs'; report: CostsReport }
  | { type: 'config'; name: string; content: string }
  | { type: 'onboardingReview'; files: { name: string; content: string; changed: boolean }[] }
  | { type: 'health'; ok: boolean; version: string; mode: string; dbPath: string; baseUrl: string };

export interface CommandResult {
  panel?: PanelData;
  info?: string;
  error?: string;
  /** Side effects the App owns (sealing prints a seam; quit unmounts;
   * onboarding enters the wizard mode that owns the input line until exit). */
  action?: 'seal' | 'quit' | 'onboarding';
}

/**
 * State the App tracks that a command needs but doesn't fetch itself — the
 * default target for the argument-less nudge/approval actions below.
 */
export interface CommandContext {
  /** taskId from the most recent `notification` WS event that carried one. */
  lastNudgeTaskId: string | null;
}

export interface Command {
  name: string;
  /** Argument hint shown in the menu, e.g. "[name]". */
  args?: string;
  description: string;
  run: (api: Api, arg: string, baseUrl: string, ctx: CommandContext) => Promise<CommandResult>;
}

/** First 8 chars — enough to disambiguate in the rare multi-pending case, short enough to type. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** Resolve a user-typed id (full or the `shortId` prefix shown in the UI) against a list, by id. */
function resolveActionId<T extends { id: string }>(items: T[], arg: string): T | undefined {
  return items.find((i) => i.id === arg || shortId(i.id) === arg);
}

/** `/approve`/`/deny` with no id: the single pending action, if there's exactly one. */
function pickPending(actions: PendingAction[], arg: string): { action?: PendingAction; error?: string } {
  if (arg) {
    const hit = resolveActionId(actions, arg);
    return hit ? { action: hit } : { error: `no pending approval matching "${arg}"` };
  }
  if (actions.length === 0) return { error: 'no pending approvals' };
  if (actions.length === 1) return { action: actions[0] };
  return {
    error: `${actions.length} pending approvals — specify one: ${actions.map((a) => shortId(a.id)).join(', ')}`,
  };
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
    name: 'costs',
    description: 'LLM spend by activity & model',
    run: async (api) => {
      const { report } = await api.costs();
      return { panel: { type: 'costs', report } };
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
    name: 'done',
    args: '[taskId]',
    description: 'mark a nudged task done (default: the last nudge)',
    run: async (api, arg, _baseUrl, ctx) => {
      const taskId = arg || ctx.lastNudgeTaskId;
      if (!taskId) return { error: 'no recent nudge to act on — pass a task id: /done <taskId>' };
      const { task } = await api.taskAction(taskId, { action: 'done' });
      return { info: `✓ done — ${sanitizeTerminalText(task.description)}` };
    },
  },
  {
    name: 'snooze',
    args: '[taskId]',
    description: 'snooze a nudged task 3 days (default: the last nudge)',
    run: async (api, arg, _baseUrl, ctx) => {
      const taskId = arg || ctx.lastNudgeTaskId;
      if (!taskId) return { error: 'no recent nudge to act on — pass a task id: /snooze <taskId>' };
      const { task } = await api.taskAction(taskId, { action: 'snooze', snoozeDays: 3 });
      return { info: `⏰ snoozed 3d — ${sanitizeTerminalText(task.description)}` };
    },
  },
  {
    name: 'dismiss',
    args: '[taskId]',
    description: 'dismiss a nudged task (default: the last nudge)',
    run: async (api, arg, _baseUrl, ctx) => {
      const taskId = arg || ctx.lastNudgeTaskId;
      if (!taskId) return { error: 'no recent nudge to act on — pass a task id: /dismiss <taskId>' };
      const { task } = await api.taskAction(taskId, { action: 'dismiss' });
      return { info: `✗ dismissed — ${sanitizeTerminalText(task.description)}` };
    },
  },
  {
    name: 'approve',
    args: '[id]',
    description: 'approve a pending MCP action (default: the only one pending)',
    run: async (api, arg) => {
      const { actions } = await api.actions('pending');
      const { action, error } = pickPending(actions, arg);
      if (error || !action) return { error: error ?? 'no pending approvals' };
      const { action: resolved } = await api.approveAction(action.id);
      return { info: `✓ approved — ${sanitizeTerminalText(resolved.summary)}` };
    },
  },
  {
    name: 'deny',
    args: '[id]',
    description: 'dismiss a pending MCP action (default: the only one pending)',
    run: async (api, arg) => {
      const { actions } = await api.actions('pending');
      const { action, error } = pickPending(actions, arg);
      if (error || !action) return { error: error ?? 'no pending approvals' };
      const { action: resolved } = await api.dismissAction(action.id);
      return { info: `· dismissed — ${sanitizeTerminalText(resolved.summary)}` };
    },
  },
  {
    name: 'onboarding',
    description: 'guided setup — persona, team, sources, schedule…',
    run: async () => ({ action: 'onboarding' }),
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
