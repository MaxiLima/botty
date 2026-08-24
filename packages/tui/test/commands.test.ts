import { describe, expect, it, vi } from 'vitest';
import type { PendingAction, Task } from '@botty/shared';
import type { Api } from '../src/api.js';
import { COMMANDS, filterCommands, parseSlash, resolveCommand, shortId, type CommandContext } from '../src/commands.js';

const task = (overrides: Partial<Task> = {}): Task => ({
  id: 't-1',
  description: 'send the deck',
  rawText: null,
  source: 'slack',
  sourceRef: null,
  status: 'open',
  priority: 2,
  owner: 'me',
  requestedBy: null,
  requesterName: null,
  projectId: null,
  dueDate: null,
  snoozeUntil: null,
  doneAt: null,
  surfaceCount: 0,
  lastSurfacedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
});

const pendingAction = (overrides: Partial<PendingAction> = {}): PendingAction => ({
  id: 'abcdefgh12345',
  server: 'slack',
  tool: 'send_message',
  argsJson: '{}',
  summary: 'send a slack message to #general',
  status: 'pending',
  createdAt: '2026-08-01T00:00:00.000Z',
  resolvedAt: null,
  resultJson: null,
  sourceTurnId: null,
  ...overrides,
});

const noCtx: CommandContext = { lastNudgeTaskId: null };

describe('parseSlash', () => {
  it('splits command and argument', () => {
    expect(parseSlash('/people marian rios')).toEqual({ name: 'people', arg: 'marian rios' });
    expect(parseSlash('/tasks')).toEqual({ name: 'tasks', arg: '' });
    expect(parseSlash('  /HELP  ')).toEqual({ name: 'help', arg: '' });
  });

  it('returns null for non-slash input', () => {
    expect(parseSlash('hello botty')).toBeNull();
  });
});

describe('filterCommands', () => {
  it('prefix-matches while the name is being typed', () => {
    expect(filterCommands('/').map((c) => c.name)).toEqual(COMMANDS.map((c) => c.name));
    expect(filterCommands('/pe').map((c) => c.name)).toEqual(['people']);
    expect(filterCommands('/h').map((c) => c.name)).toEqual(['help', 'health']);
  });

  it('closes the menu once an argument starts (dispatch goes via resolveCommand)', () => {
    expect(filterCommands('/people mar')).toEqual([]);
    expect(filterCommands('/people ')).toEqual([]);
    expect(filterCommands('/pe mar')).toEqual([]);
  });

  it('matches nothing for unknown names', () => {
    expect(filterCommands('/zzz')).toEqual([]);
  });
});

describe('resolveCommand', () => {
  it('resolves exact names only', () => {
    expect(resolveCommand('people')?.name).toBe('people');
    expect(resolveCommand('pe')).toBeUndefined();
  });
});

describe('command registry', () => {
  it('has unique names and help entries for every command', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of COMMANDS) expect(c.description.length).toBeGreaterThan(0);
  });
});

describe('shortId', () => {
  it('takes the first 8 characters', () => {
    expect(shortId('abcdefgh12345')).toBe('abcdefgh');
    expect(shortId('abc')).toBe('abc');
  });
});

// Nudges/approvals used to be display-only in the TUI (report §3 Appendix E) —
// /done, /snooze, /dismiss, /approve, /deny make them actionable via the
// REST endpoints the web app already uses.
describe('/done, /snooze, /dismiss — task actions on a nudge', () => {
  const cmd = (name: string) => resolveCommand(name)!;

  it('acts on the last-nudge task id when no argument is given', async () => {
    const taskAction = vi.fn().mockResolvedValue({ task: task({ description: 'send the deck' }) });
    const api = { taskAction } as unknown as Api;
    const ctx: CommandContext = { lastNudgeTaskId: 't-42' };

    const res = await cmd('done').run(api, '', '', ctx);
    expect(taskAction).toHaveBeenCalledWith('t-42', { action: 'done' });
    expect(res.info).toContain('send the deck');
  });

  it('snoozes 3 days, matching the web app default', async () => {
    const taskAction = vi.fn().mockResolvedValue({ task: task() });
    const api = { taskAction } as unknown as Api;
    await cmd('snooze').run(api, '', '', { lastNudgeTaskId: 't-1' });
    expect(taskAction).toHaveBeenCalledWith('t-1', { action: 'snooze', snoozeDays: 3 });
  });

  it('an explicit task id argument overrides the last-nudge default', async () => {
    const taskAction = vi.fn().mockResolvedValue({ task: task() });
    const api = { taskAction } as unknown as Api;
    await cmd('dismiss').run(api, 't-other', '', { lastNudgeTaskId: 't-1' });
    expect(taskAction).toHaveBeenCalledWith('t-other', { action: 'dismiss' });
  });

  it('errors instead of calling the API when there is no target', async () => {
    const taskAction = vi.fn();
    const api = { taskAction } as unknown as Api;
    const res = await cmd('done').run(api, '', '', noCtx);
    expect(taskAction).not.toHaveBeenCalled();
    expect(res.error).toMatch(/no recent nudge/);
  });

  it('sanitizes the returned task description before it reaches the transcript', async () => {
    const taskAction = vi.fn().mockResolvedValue({ task: task({ description: 'ok\x1B[2J now' }) });
    const api = { taskAction } as unknown as Api;
    const res = await cmd('done').run(api, '', '', { lastNudgeTaskId: 't-1' });
    expect(res.info).not.toMatch(/\x1B/);
    expect(res.info).toContain('ok now');
  });
});

describe('/approve, /deny — pending MCP action approvals', () => {
  const cmd = (name: string) => resolveCommand(name)!;

  it('acts on the only pending approval when no id is given', async () => {
    const approveAction = vi.fn().mockResolvedValue({ action: pendingAction({ status: 'executed' }) });
    const api = {
      actions: vi.fn().mockResolvedValue({ actions: [pendingAction()] }),
      approveAction,
    } as unknown as Api;
    const res = await cmd('approve').run(api, '', '', noCtx);
    expect(approveAction).toHaveBeenCalledWith('abcdefgh12345');
    expect(res.info).toContain('send a slack message to #general');
  });

  it('resolves a short-id argument to the matching full id', async () => {
    const dismissAction = vi.fn().mockResolvedValue({ action: pendingAction({ status: 'dismissed' }) });
    const api = {
      actions: vi.fn().mockResolvedValue({ actions: [pendingAction({ id: 'zzzzzzzz99999' })] }),
      dismissAction,
    } as unknown as Api;
    const res = await cmd('deny').run(api, 'zzzzzzzz', '', noCtx);
    expect(dismissAction).toHaveBeenCalledWith('zzzzzzzz99999');
    expect(res.info).toBeDefined();
  });

  it('errors with no pending approvals', async () => {
    const api = { actions: vi.fn().mockResolvedValue({ actions: [] }) } as unknown as Api;
    const res = await cmd('approve').run(api, '', '', noCtx);
    expect(res.error).toMatch(/no pending approvals/);
  });

  it('asks the user to disambiguate when more than one is pending and no id was given', async () => {
    const api = {
      actions: vi.fn().mockResolvedValue({ actions: [pendingAction({ id: 'aaa11111' }), pendingAction({ id: 'bbb22222' })] }),
    } as unknown as Api;
    const res = await cmd('approve').run(api, '', '', noCtx);
    expect(res.error).toMatch(/2 pending approvals/);
    expect(res.error).toMatch(/aaa11111/);
  });

  it('errors on an id matching none of the pending approvals', async () => {
    const api = { actions: vi.fn().mockResolvedValue({ actions: [pendingAction()] }) } as unknown as Api;
    const res = await cmd('approve').run(api, 'nope', '', noCtx);
    expect(res.error).toMatch(/no pending approval matching/);
  });
});
