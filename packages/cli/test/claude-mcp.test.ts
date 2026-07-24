import { describe, expect, it } from 'vitest';
import {
  discoverClaudeServers,
  expandPlaceholders,
  mergeImport,
  sanitizeKey,
  toolsFromProbe,
  type ClaudeFiles,
  type DiscoveredServer,
} from '../src/claude-mcp.js';

const CWD = '/home/u/proj';

function files(over: Partial<ClaudeFiles> = {}): ClaudeFiles {
  return {
    claudeJson: null,
    settingsJson: null,
    installedPluginsJson: null,
    managedSettingsJson: null,
    projectMcpJson: null,
    pluginMcpJson: () => null,
    cwd: CWD,
    ...over,
  };
}

function stdio(key: string, over: Partial<DiscoveredServer> = {}): DiscoveredServer {
  return { key, source: 'user', transport: 'stdio', command: 'run', args: [], env: {}, ...over };
}

describe('discoverClaudeServers', () => {
  it('finds user-scope stdio servers in ~/.claude.json', () => {
    const d = discoverClaudeServers(
      files({ claudeJson: JSON.stringify({ mcpServers: { db: { command: 'db-mcp', args: ['--ro'], env: { A: '1' } } } }) }),
    );
    expect(d.servers).toEqual([
      { key: 'db', source: 'user', transport: 'stdio', command: 'db-mcp', args: ['--ro'], env: { A: '1' }, pluginRoot: undefined },
    ]);
    expect(d.warnings).toEqual([]);
  });

  it('marks sse/http servers with their transport (not importable)', () => {
    const d = discoverClaudeServers(
      files({
        claudeJson: JSON.stringify({
          mcpServers: {
            a: { type: 'sse', url: 'https://x.example/sse' },
            b: { url: 'https://x.example/mcp' },
          },
        }),
      }),
    );
    expect(d.servers.map((s) => s.transport)).toEqual(['sse', 'http']);
  });

  it('reads project .mcp.json and marks disabledMcpjsonServers entries', () => {
    const d = discoverClaudeServers(
      files({
        projectMcpJson: JSON.stringify({ mcpServers: { on: { command: 'a' }, off: { command: 'b' } } }),
        claudeJson: JSON.stringify({ projects: { [CWD]: { disabledMcpjsonServers: ['off'] } } }),
      }),
    );
    expect(d.servers.find((s) => s.key === 'off')?.disabledInClaude).toBe(true);
    expect(d.servers.find((s) => s.key === 'on')?.disabledInClaude).toBeUndefined();
  });

  it('resolves the plugin chain: enabledPlugins → installed_plugins → plugin .mcp.json with ${CLAUDE_PLUGIN_ROOT}', () => {
    const d = discoverClaudeServers(
      files({
        settingsJson: JSON.stringify({ enabledPlugins: { 'tg@official': true, 'lsp@official': true, 'off@official': false } }),
        installedPluginsJson: JSON.stringify({
          version: 2,
          plugins: {
            'tg@official': [{ installPath: '/cache/tg/0.0.6', version: '0.0.6' }],
            'lsp@official': [{ installPath: '/cache/lsp/1.0.0', version: '1.0.0' }],
          },
        }),
        pluginMcpJson: (p) =>
          p === '/cache/tg/0.0.6'
            ? JSON.stringify({ mcpServers: { telegram: { command: 'bun', args: ['run', '--cwd', '${CLAUDE_PLUGIN_ROOT}', 'start'] } } })
            : null, // lsp plugin has no .mcp.json → silently skipped
      }),
    );
    expect(d.servers).toHaveLength(1);
    expect(d.servers[0]).toMatchObject({
      key: 'telegram',
      source: 'plugin:tg',
      transport: 'stdio',
      pluginRoot: '/cache/tg/0.0.6',
      args: ['run', '--cwd', '${CLAUDE_PLUGIN_ROOT}', 'start'],
    });
  });

  it('reads managed-settings servers and applies precedence (managed > project > user > plugin)', () => {
    const d = discoverClaudeServers(
      files({
        managedSettingsJson: JSON.stringify({ mcpServers: { dupe: { command: 'managed' } } }),
        claudeJson: JSON.stringify({ mcpServers: { dupe: { command: 'user' } } }),
      }),
    );
    const [managed, user] = d.servers;
    expect(managed?.source).toBe('managed');
    expect(managed?.shadowedBy).toBeUndefined();
    expect(user).toMatchObject({ source: 'user', shadowedBy: 'managed' });
  });

  it('reports claude.ai connectors as names', () => {
    const d = discoverClaudeServers(
      files({ claudeJson: JSON.stringify({ claudeAiMcpEverConnected: ['claude.ai Gmail', 'claude.ai Google Drive'] }) }),
    );
    expect(d.connectors).toEqual(['claude.ai Gmail', 'claude.ai Google Drive']);
  });

  it('turns malformed sources into warnings, never throws', () => {
    const d = discoverClaudeServers(
      files({
        claudeJson: '{nope',
        settingsJson: '[]',
        projectMcpJson: JSON.stringify({ mcpServers: { bad: { args: [] }, alsoBad: 42 } }),
      }),
    );
    expect(d.servers).toEqual([]);
    expect(d.warnings).toEqual([
      '~/.claude.json: invalid JSON — ignored',
      'project server "bad": no command — ignored',
      'project server "alsoBad": not an object — ignored',
      '~/.claude/settings.json: not a JSON object — ignored',
    ]);
  });
});

describe('sanitizeKey', () => {
  it('replaces invalid characters', () => {
    expect(sanitizeKey('my.server', new Set())).toEqual({ key: 'my-server', renamed: true });
    expect(sanitizeKey('ok_key-1', new Set())).toEqual({ key: 'ok_key-1', renamed: false });
  });

  it('suffixes on collision', () => {
    expect(sanitizeKey('a.b', new Set(['a-b'])).key).toBe('a-b-2');
    expect(sanitizeKey('a.b', new Set(['a-b', 'a-b-2'])).key).toBe('a-b-3');
  });
});

describe('expandPlaceholders', () => {
  it('expands CLAUDE_PLUGIN_ROOT and env vars, tracking sources', () => {
    const r = expandPlaceholders('${CLAUDE_PLUGIN_ROOT}/bin ${TOKEN}', { CLAUDE_PLUGIN_ROOT: '/p' }, { TOKEN: 't1' });
    expect(r).toEqual({ value: '/p/bin t1', unresolved: [], fromEnv: ['TOKEN'] });
  });

  it('uses ${VAR:-default} fallbacks and keeps unresolved literals', () => {
    const r = expandPlaceholders('${PORT:-8080} ${MISSING}', {}, {});
    expect(r.value).toBe('8080 ${MISSING}');
    expect(r.unresolved).toEqual(['MISSING']);
  });
});

describe('mergeImport', () => {
  const env = {};

  it('creates a fresh default-deny config with trailing newline', () => {
    const out = mergeImport('', [stdio('db', { command: 'db-mcp', args: ['--ro'] })], { force: false, env });
    if (!out.ok) throw new Error(out.error);
    expect(out.results).toEqual([{ key: 'db', original: 'db', source: 'user', status: 'imported', warnings: [] }]);
    expect(out.json.endsWith('\n')).toBe(true);
    expect(JSON.parse(out.json)).toEqual({
      servers: { db: { type: 'stdio', command: 'db-mcp', args: ['--ro'], env: {}, tools: {} } },
    });
  });

  it('preserves unknown top-level keys and untouched entries verbatim', () => {
    const existing = JSON.stringify({ note: 'mine', servers: { keep: { type: 'stdio', command: 'x', custom: 1 } } });
    const out = mergeImport(existing, [stdio('new')], { force: false, env });
    if (!out.ok) throw new Error(out.error);
    const root = JSON.parse(out.json);
    expect(root.note).toBe('mine');
    expect(root.servers.keep).toEqual({ type: 'stdio', command: 'x', custom: 1 });
    expect(Object.keys(root.servers)).toEqual(['keep', 'new']);
  });

  it('skips existing keys without --force; --force updates but keeps the tools allowlist', () => {
    const existing = JSON.stringify({
      servers: { db: { type: 'stdio', command: 'old', args: [], env: {}, tools: { query: 'read' } } },
    });
    const skip = mergeImport(existing, [stdio('db')], { force: false, env });
    if (!skip.ok) throw new Error(skip.error);
    expect(skip.results[0]!.status).toBe('skipped-exists');
    expect(skip.changed).toBe(false);

    const force = mergeImport(existing, [stdio('db', { command: 'new-cmd' })], { force: true, env });
    if (!force.ok) throw new Error(force.error);
    expect(force.results[0]!.status).toBe('updated');
    expect(JSON.parse(force.json).servers.db).toEqual({
      type: 'stdio',
      command: 'new-cmd',
      args: [],
      env: {},
      tools: { query: 'read' },
    });
  });

  it('skips non-stdio, disabled, and shadowed picks', () => {
    const out = mergeImport(
      '',
      [
        { key: 'sse', source: 'user', transport: 'sse', url: 'https://x.example' },
        stdio('off', { disabledInClaude: true }),
        stdio('dupe', { shadowedBy: 'managed' }),
      ],
      { force: false, env },
    );
    if (!out.ok) throw new Error(out.error);
    expect(out.results.map((r) => r.status)).toEqual(['skipped-transport', 'skipped-disabled', 'skipped-shadowed']);
    expect(out.changed).toBe(false);
  });

  it('expands plugin root and environment at import time', () => {
    const out = mergeImport(
      '',
      [stdio('tg', { args: ['--cwd', '${CLAUDE_PLUGIN_ROOT}'], env: { KEY: '${SECRET}' }, pluginRoot: '/p' })],
      { force: false, env: { SECRET: 's3' } },
    );
    if (!out.ok) throw new Error(out.error);
    expect(JSON.parse(out.json).servers.tg).toMatchObject({ args: ['--cwd', '/p'], env: { KEY: 's3' } });
    expect(out.results[0]!.warnings).toEqual(['env SECRET resolved from your environment and stored in mcp.json']);
  });

  it('refuses to touch a broken existing file', () => {
    expect(mergeImport('{oops', [stdio('db')], { force: false, env }).ok).toBe(false);
    expect(mergeImport('[]', [stdio('db')], { force: false, env }).ok).toBe(false);
    expect(mergeImport('{"servers": 3}', [stdio('db')], { force: false, env }).ok).toBe(false);
  });

  it('renames colliding keys within a batch', () => {
    const out = mergeImport('', [stdio('a.b'), stdio('a-b')], { force: false, env });
    if (!out.ok) throw new Error(out.error);
    expect(out.results.map((r) => r.key)).toEqual(['a-b', 'a-b-2']);
    expect(out.results[0]!.warnings).toEqual(['imported as a-b (renamed from a.b)']);
  });
});

describe('toolsFromProbe', () => {
  it('adds discovered tools as action, never downgrading or dropping', () => {
    const r = toolsFromProbe({ query: 'read', old: 'action' }, ['query', 'send']);
    expect(r.tools).toEqual({ query: 'read', old: 'action', send: 'action' });
  });

  it('skips tool names that would invalidate botty config', () => {
    const r = toolsFromProbe({}, ['ok_tool', 'bad tool!']);
    expect(r.tools).toEqual({ ok_tool: 'action' });
    expect(r.skipped).toEqual(['bad tool!']);
  });
});
