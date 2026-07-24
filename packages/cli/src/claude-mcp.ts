import fs from 'node:fs';
import path from 'node:path';

/**
 * Discovery + import of MCP servers from the user's Claude Code installation
 * into botty's ~/.botty/config/mcp.json (see docs/specs/mcp.md "Importing from
 * Claude Code"). Everything except readClaudeFiles is pure over injected file
 * contents so it stays unit-testable without fs, matching the CLI test style.
 *
 * Imports are default-deny (`tools: {}`): the agent never spawns a server with
 * an empty allowlist, so an import alone can never fight a live Claude Code
 * session over a single-consumer server (telegram-style getUpdates slots,
 * fixed ports). Connecting is a separate, explicit step (`--probe`).
 */

// Mirrors NAME_RE in packages/agent/src/config/mcp.ts:14 — server keys and
// tool names must compose into `<server>_<tool>` chat-tool names.
export const NAME_RE = /^[a-zA-Z0-9_-]+$/;

export type Source = 'managed' | 'project' | 'user' | `plugin:${string}`;

export interface DiscoveredServer {
  /** Original key in the Claude Code config. */
  key: string;
  source: Source;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** sse/http only. */
  url?: string;
  /** Listed in the project's disabledMcpjsonServers. */
  disabledInClaude?: boolean;
  /** A same-key server from a higher-precedence source won. */
  shadowedBy?: Source;
  /** Plugin installPath, for ${CLAUDE_PLUGIN_ROOT} expansion. */
  pluginRoot?: string;
}

export interface Discovery {
  servers: DiscoveredServer[];
  /** claude.ai remote connector names — never importable (auth lives in claude.ai). */
  connectors: string[];
  warnings: string[];
}

/** Raw file contents, null = absent. The only impure part is readClaudeFiles. */
export interface ClaudeFiles {
  claudeJson: string | null;
  settingsJson: string | null;
  installedPluginsJson: string | null;
  managedSettingsJson: string | null;
  projectMcpJson: string | null;
  pluginMcpJson: (installPath: string) => string | null;
  cwd: string;
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function readClaudeFiles(home: string, cwd: string): ClaudeFiles {
  return {
    claudeJson: readIfExists(path.join(home, '.claude.json')),
    settingsJson: readIfExists(path.join(home, '.claude', 'settings.json')),
    installedPluginsJson: readIfExists(path.join(home, '.claude', 'plugins', 'installed_plugins.json')),
    managedSettingsJson: readIfExists('/Library/Application Support/ClaudeCode/managed-settings.json'),
    projectMcpJson: readIfExists(path.join(cwd, '.mcp.json')),
    pluginMcpJson: (installPath) => readIfExists(path.join(installPath, '.mcp.json')),
    cwd,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseSource(label: string, raw: string | null, warnings: string[]): Record<string, unknown> | null {
  if (raw === null || raw.trim() === '') return null;
  try {
    const json: unknown = JSON.parse(raw);
    if (!isRecord(json)) {
      warnings.push(`${label}: not a JSON object — ignored`);
      return null;
    }
    return json;
  } catch {
    warnings.push(`${label}: invalid JSON — ignored`);
    return null;
  }
}

/** One raw `mcpServers` entry → DiscoveredServer, or null (+warning) when unusable. */
function toServer(
  key: string,
  raw: unknown,
  source: Source,
  warnings: string[],
  pluginRoot?: string,
): DiscoveredServer | null {
  if (!isRecord(raw)) {
    warnings.push(`${source} server "${key}": not an object — ignored`);
    return null;
  }
  const type = typeof raw.type === 'string' ? raw.type : undefined;
  const url = typeof raw.url === 'string' ? raw.url : undefined;
  const transport: DiscoveredServer['transport'] =
    type === 'sse' || type === 'http' ? type : url !== undefined && raw.command === undefined ? 'http' : 'stdio';
  if (transport !== 'stdio') return { key, source, transport, url };
  if (typeof raw.command !== 'string' || raw.command === '') {
    warnings.push(`${source} server "${key}": no command — ignored`);
    return null;
  }
  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : [];
  const env: Record<string, string> = {};
  if (isRecord(raw.env)) {
    for (const [k, v] of Object.entries(raw.env)) if (typeof v === 'string') env[k] = v;
  }
  return { key, source, transport: 'stdio', command: raw.command, args, env, pluginRoot };
}

/**
 * Discover MCP servers across Claude Code's config sources. Never throws —
 * malformed sources become warnings. Duplicate keys follow Claude Code
 * precedence (managed > project > user > plugin); losers get `shadowedBy`.
 */
export function discoverClaudeServers(files: ClaudeFiles): Discovery {
  const warnings: string[] = [];
  const servers: DiscoveredServer[] = [];
  const won = new Map<string, Source>();

  const add = (server: DiscoveredServer | null): void => {
    if (!server) return;
    const winner = won.get(server.key);
    if (winner !== undefined) server.shadowedBy = winner;
    else won.set(server.key, server.source);
    servers.push(server);
  };
  const addAll = (obj: Record<string, unknown> | null, source: Source, pluginRoot?: string): void => {
    if (!obj) return;
    for (const [key, raw] of Object.entries(obj)) add(toServer(key, raw, source, warnings, pluginRoot));
  };
  const mcpServersOf = (obj: Record<string, unknown> | null): Record<string, unknown> | null =>
    obj && isRecord(obj.mcpServers) ? obj.mcpServers : null;

  const claudeJson = parseSource('~/.claude.json', files.claudeJson, warnings);
  const project = claudeJson && isRecord(claudeJson.projects) && isRecord(claudeJson.projects[files.cwd])
    ? (claudeJson.projects[files.cwd] as Record<string, unknown>)
    : null;

  // 1. managed (enterprise policy)
  addAll(mcpServersOf(parseSource('managed-settings.json', files.managedSettingsJson, warnings)), 'managed');

  // 2. project: <cwd>/.mcp.json (honoring disabledMcpjsonServers) + projects[cwd].mcpServers
  const disabled = new Set(
    project && Array.isArray(project.disabledMcpjsonServers)
      ? project.disabledMcpjsonServers.filter((k): k is string => typeof k === 'string')
      : [],
  );
  const projectMcp = mcpServersOf(parseSource('.mcp.json', files.projectMcpJson, warnings));
  if (projectMcp) {
    for (const [key, raw] of Object.entries(projectMcp)) {
      const server = toServer(key, raw, 'project', warnings);
      if (server && disabled.has(key)) server.disabledInClaude = true;
      add(server);
    }
  }
  addAll(mcpServersOf(project), 'project');

  // 3. user scope
  addAll(mcpServersOf(claudeJson), 'user');

  // 4. plugins: enabledPlugins -> installed_plugins.json installPath -> <installPath>/.mcp.json
  const settings = parseSource('~/.claude/settings.json', files.settingsJson, warnings);
  const installed = parseSource('installed_plugins.json', files.installedPluginsJson, warnings);
  const registry = installed && isRecord(installed.plugins) ? installed.plugins : installed;
  if (settings && isRecord(settings.enabledPlugins) && registry) {
    for (const [pluginId, enabled] of Object.entries(settings.enabledPlugins)) {
      if (enabled !== true) continue;
      const entries = registry[pluginId];
      const first = Array.isArray(entries) ? entries[0] : entries;
      if (!isRecord(first) || typeof first.installPath !== 'string') continue;
      if (Array.isArray(entries) && entries.length > 1)
        warnings.push(`plugin ${pluginId}: multiple installs, using ${first.installPath}`);
      const pluginName = pluginId.split('@')[0] ?? pluginId;
      const mcp = mcpServersOf(parseSource(`${pluginId} .mcp.json`, files.pluginMcpJson(first.installPath), warnings));
      addAll(mcp, `plugin:${pluginName}`, first.installPath); // plugins without .mcp.json are silently skipped
    }
  }

  const connectors =
    claudeJson && Array.isArray(claudeJson.claudeAiMcpEverConnected)
      ? claudeJson.claudeAiMcpEverConnected.filter((c): c is string => typeof c === 'string')
      : [];

  return { servers, connectors, warnings };
}

/** Sanitize a Claude server key into botty's `[a-zA-Z0-9_-]+`, suffixing on batch collision. */
export function sanitizeKey(key: string, taken: Set<string>): { key: string; renamed: boolean } {
  let base = key.replace(/[^a-zA-Z0-9_-]/g, '-');
  if (base === '') base = 'server';
  let candidate = base;
  for (let i = 2; taken.has(candidate); i++) candidate = `${base}-${i}`;
  return { key: candidate, renamed: candidate !== key };
}

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Expand ${VAR} / ${VAR:-default} the way Claude Code does at launch — botty
 * performs no runtime expansion (connections.ts passes config values to the
 * spawned process literally), so values must be resolved at import time.
 */
export function expandPlaceholders(
  value: string,
  vars: { CLAUDE_PLUGIN_ROOT?: string },
  env: Record<string, string | undefined>,
): { value: string; unresolved: string[]; fromEnv: string[] } {
  const unresolved: string[] = [];
  const fromEnv: string[] = [];
  const out = value.replace(PLACEHOLDER_RE, (match, name: string, fallback: string | undefined) => {
    if (name === 'CLAUDE_PLUGIN_ROOT' && vars.CLAUDE_PLUGIN_ROOT !== undefined) return vars.CLAUDE_PLUGIN_ROOT;
    const fromProcess = env[name];
    if (fromProcess !== undefined) {
      fromEnv.push(name);
      return fromProcess;
    }
    if (fallback !== undefined) return fallback;
    unresolved.push(name);
    return match;
  });
  return { value: out, unresolved, fromEnv };
}

export interface BottyServerEntry {
  type: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  tools: Record<string, 'read' | 'action'>;
}

/** Discovered stdio server → botty mcp.json entry (default-deny tools) + human warnings. */
export function convertServer(
  server: DiscoveredServer,
  env: Record<string, string | undefined>,
): { entry: BottyServerEntry; warnings: string[] } {
  const vars = { CLAUDE_PLUGIN_ROOT: server.pluginRoot };
  const unresolved = new Set<string>();
  const fromEnv = new Set<string>();
  const expand = (value: string): string => {
    const r = expandPlaceholders(value, vars, env);
    for (const name of r.unresolved) unresolved.add(name);
    for (const name of r.fromEnv) fromEnv.add(name);
    return r.value;
  };

  const entry: BottyServerEntry = {
    type: 'stdio',
    command: expand(server.command ?? ''),
    args: (server.args ?? []).map(expand),
    env: Object.fromEntries(Object.entries(server.env ?? {}).map(([k, v]) => [k, expand(v)])),
    tools: {},
  };

  const warnings: string[] = [];
  if (fromEnv.size > 0)
    warnings.push(`env ${[...fromEnv].join(', ')} resolved from your environment and stored in mcp.json`);
  if (unresolved.size > 0)
    warnings.push(
      `unresolved ${[...unresolved].map((n) => `\${${n}}`).join(', ')} — edit the entry in mcp.json before enabling tools`,
    );
  return { entry, warnings };
}

export interface ImportResult {
  /** Key written to botty's mcp.json (post-sanitize). */
  key: string;
  original: string;
  source: Source;
  status: 'imported' | 'updated' | 'skipped-exists' | 'skipped-transport' | 'skipped-disabled' | 'skipped-shadowed';
  warnings: string[];
}

export type MergeOutcome =
  | { ok: true; json: string; results: ImportResult[]; changed: boolean }
  | { ok: false; error: string };

/**
 * Merge picked servers into the existing mcp.json content. The existing file
 * is treated as opaque JSON — unknown keys and untouched entries survive
 * verbatim; only `servers[key]` assignments happen. A file that doesn't parse
 * refuses the whole import (the agent may be serving last-known-good; never
 * clobber the evidence). Callers importing an explicitly named server should
 * clear `disabledInClaude` on the pick first.
 */
export function mergeImport(
  rawExisting: string,
  picks: DiscoveredServer[],
  opts: { force: boolean; env: Record<string, string | undefined> },
): MergeOutcome {
  let root: Record<string, unknown>;
  if (rawExisting.trim() === '') {
    root = { servers: {} };
  } else {
    try {
      const parsed: unknown = JSON.parse(rawExisting);
      if (!isRecord(parsed)) return { ok: false, error: 'existing mcp.json is not a JSON object' };
      root = parsed;
    } catch (err) {
      return { ok: false, error: `existing mcp.json is invalid JSON: ${(err as Error).message}` };
    }
  }
  if (root.servers === undefined) root.servers = {};
  if (!isRecord(root.servers)) return { ok: false, error: 'existing mcp.json "servers" is not an object' };
  const servers = root.servers;

  const results: ImportResult[] = [];
  const batchKeys = new Set<string>();
  let changed = false;

  for (const pick of picks) {
    const result = (status: ImportResult['status'], key: string, warnings: string[] = []): void => {
      results.push({ key, original: pick.key, source: pick.source, status, warnings });
    };
    if (pick.shadowedBy !== undefined) {
      result('skipped-shadowed', pick.key);
      continue;
    }
    if (pick.transport !== 'stdio') {
      result('skipped-transport', pick.key);
      continue;
    }
    if (pick.disabledInClaude) {
      result('skipped-disabled', pick.key);
      continue;
    }
    const { key, renamed } = sanitizeKey(pick.key, batchKeys);
    batchKeys.add(key);
    const warnings = renamed ? [`imported as ${key} (renamed from ${pick.key})`] : [];

    const existing = servers[key];
    if (existing !== undefined && !opts.force) {
      result('skipped-exists', key, warnings);
      continue;
    }
    const converted = convertServer(pick, opts.env);
    warnings.push(...converted.warnings);
    if (existing !== undefined) {
      // --force refreshes command/args/env but never discards the user's
      // curated tools allowlist — that's their consent decisions.
      if (isRecord(existing) && isRecord(existing.tools))
        converted.entry.tools = existing.tools as BottyServerEntry['tools'];
      servers[key] = converted.entry;
      changed = true;
      result('updated', key, warnings);
    } else {
      servers[key] = converted.entry;
      changed = true;
      result('imported', key, warnings);
    }
  }

  return { ok: true, json: `${JSON.stringify(root, null, 2)}\n`, results, changed };
}

/**
 * Fold probed tool names into an existing allowlist: new tools land as
 * 'action' (consent-gated), existing modes are never downgraded, and tools
 * missing from a re-probe are never silently dropped. Names that would fail
 * botty's NAME_RE are skipped (one bad name would invalidate the whole file).
 */
export function toolsFromProbe(
  existing: Record<string, 'read' | 'action'>,
  discovered: string[],
): { tools: Record<string, 'read' | 'action'>; skipped: string[] } {
  const tools = { ...existing };
  const skipped: string[] = [];
  for (const name of discovered) {
    if (!NAME_RE.test(name)) {
      skipped.push(name);
      continue;
    }
    if (tools[name] === undefined) tools[name] = 'action';
  }
  return { tools, skipped };
}
