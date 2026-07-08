import { describe, expect, it } from 'vitest';
import { COMMANDS, filterCommands, parseSlash, resolveCommand } from '../src/commands.js';

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
