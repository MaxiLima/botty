import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliConfig } from '../config.js';
import { getJson, postJson } from '../http.js';
import {
  discoverClaudeServers,
  mergeImport,
  readClaudeFiles,
  sanitizeKey,
  toolsFromProbe,
  type DiscoveredServer,
  type Discovery,
  type ImportResult,
} from '../claude-mcp.js';

const USAGE = 'usage: botty mcp list | botty mcp import [keys…] [--force] [--probe]';

const PROBE_WARNING = `⚠ --probe spawns each server once to list its tools. Single-consumer servers
  (e.g. the telegram plugin — one Telegram polling slot per bot token) may kill
  or fight a live Claude Code session using the same server. Close that
  session first if in doubt.`;

export async function mcp(cfg: CliConfig): Promise<void> {
  const sub = cfg.args[0];
  if (sub === 'list') return list(cfg);
  if (sub === 'import') return importServers(cfg);
  throw new Error(sub === undefined ? USAGE : `unknown subcommand "mcp ${sub}"\n${USAGE}`);
}

function mcpJsonPath(cfg: CliConfig): string {
  return path.join(cfg.dataDir, 'config', 'mcp.json');
}

/** Best-effort keys of botty's current mcp.json — a broken file just reads as empty here. */
function bottyServerKeys(cfg: CliConfig): Set<string> {
  try {
    const root: unknown = JSON.parse(fs.readFileSync(mcpJsonPath(cfg), 'utf8'));
    const servers = (root as { servers?: unknown }).servers;
    if (typeof servers === 'object' && servers !== null) return new Set(Object.keys(servers));
  } catch {
    /* absent or unparseable */
  }
  return new Set();
}

function discover(): Discovery {
  return discoverClaudeServers(readClaudeFiles(os.homedir(), process.cwd()));
}

/** Import status of a discovered server, for `list`. */
function listStatus(server: DiscoveredServer, bottyKeys: Set<string>): { icon: string; text: string } {
  if (server.shadowedBy !== undefined) return { icon: '⚠', text: `shadowed by ${server.shadowedBy}` };
  if (server.transport !== 'stdio') return { icon: '⚠', text: 'skipped: botty is stdio-only' };
  if (server.disabledInClaude) return { icon: '⚠', text: 'disabled in Claude Code (import by name to include)' };
  if (bottyKeys.has(sanitizeKey(server.key, new Set()).key)) return { icon: '✓', text: 'already in botty mcp.json' };
  return { icon: '✓', text: 'importable' };
}

async function list(cfg: CliConfig): Promise<void> {
  const d = discover();
  const bottyKeys = bottyServerKeys(cfg);
  if (d.servers.length === 0 && d.connectors.length === 0) {
    console.log('no MCP servers found in the local Claude Code config');
  }
  const keyWidth = Math.max(12, ...d.servers.map((s) => s.key.length), ...d.connectors.map((c) => c.length));
  for (const server of d.servers) {
    const { icon, text } = listStatus(server, bottyKeys);
    console.log(`${icon} ${server.key.padEnd(keyWidth)} ${server.source.padEnd(18)} ${server.transport.padEnd(6)} ${text}`);
  }
  for (const name of d.connectors) {
    console.log(`⚠ ${name.padEnd(keyWidth)} ${'claude.ai connector'.padEnd(18)} ${'—'.padEnd(6)} not importable: auth lives in claude.ai`);
  }
  for (const warning of d.warnings) console.log(`⚠ ${warning}`);
}

function describeResult(r: ImportResult): { icon: string; text: string } {
  switch (r.status) {
    case 'imported':
      return { icon: '✓', text: 'imported (tools: none enabled)' };
    case 'updated':
      return { icon: '✓', text: 'updated (kept existing tools allowlist)' };
    case 'skipped-exists':
      return { icon: '⚠', text: 'skipped: already in botty mcp.json (--force to overwrite)' };
    case 'skipped-transport':
      return { icon: '⚠', text: 'skipped: not stdio (botty is stdio-only)' };
    case 'skipped-disabled':
      return { icon: '⚠', text: 'skipped: disabled in Claude Code (import by name to include)' };
    case 'skipped-shadowed':
      return { icon: '⚠', text: 'skipped: shadowed by a higher-precedence source' };
  }
}

/** Archive the previous mcp.json (mirrors ConfigManager.saveMcp) and write the new content. */
function writeMcpJson(cfg: CliConfig, json: string): string | null {
  const file = mcpJsonPath(cfg);
  let archived: string | null = null;
  if (fs.existsSync(file)) {
    const archiveDir = path.join(path.dirname(file), 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    archived = path.join(archiveDir, `mcp-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.copyFileSync(file, archived);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(file, json);
  return archived;
}

async function importServers(cfg: CliConfig): Promise<void> {
  const d = discover();
  const names = cfg.args.slice(1);

  let picks: DiscoveredServer[];
  if (names.length > 0) {
    picks = names.map((name) => {
      const match =
        d.servers.find((s) => s.shadowedBy === undefined && s.key === name) ??
        d.servers.find((s) => s.shadowedBy === undefined && sanitizeKey(s.key, new Set()).key === name);
      if (!match) {
        const known = d.servers.filter((s) => s.shadowedBy === undefined).map((s) => s.key);
        throw new Error(`no Claude Code MCP server named "${name}" (found: ${known.join(', ') || 'none'})`);
      }
      // Naming a server explicitly overrides its Claude-side disablement.
      return { ...match, disabledInClaude: false };
    });
  } else {
    picks = d.servers;
  }
  if (picks.length === 0) {
    console.log('nothing to import — no MCP servers found in the local Claude Code config');
    return;
  }

  // The user asked for a probed import: make sure the agent is there before writing anything.
  if (cfg.probe) {
    const health = await getJson(`${cfg.agentUrl}/api/health`).catch(() => null);
    if (!health)
      throw new Error(
        `--probe needs the agent (nothing healthy on :${cfg.port}) — \`botty start\` first, or rerun without --probe for a config-only import`,
      );
  }

  const file = mcpJsonPath(cfg);
  const rawExisting = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const out = mergeImport(rawExisting, picks, { force: cfg.force, env: process.env });
  if (!out.ok) throw new Error(`${out.error}\nfix ${file} by hand (previous versions are in config/archive/), then retry`);

  for (const r of out.results) {
    const { icon, text } = describeResult(r);
    console.log(`${icon} ${r.key.padEnd(12)} ${text} — from ${r.source}`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
  }
  for (const w of d.warnings) console.log(`⚠ ${w}`);

  if (!out.changed) {
    console.log('nothing written');
    return;
  }
  const archived = writeMcpJson(cfg, out.json);
  if (archived) console.log(`archived previous mcp.json → ${archived}`);
  console.log(`wrote ${file}`);

  const written = out.results.filter((r) => r.status === 'imported' || r.status === 'updated');
  if (cfg.probe) {
    await probeServers(cfg, written.map((r) => r.key));
  } else {
    console.log(`
Tools are default-deny: botty never spawns a server until you allowlist tools,
so this import cannot conflict with a live Claude Code session. Enable with
\`botty mcp import <key> --force --probe\` (spawns the server once), or add
"tools": { "<name>": "read" | "action" } to the server in ${file}`);
  }
}

/** Probe each written server via the agent's tested endpoint and fold the tools in as 'action'. */
async function probeServers(cfg: CliConfig, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  console.log(`\n${PROBE_WARNING}`);

  const file = mcpJsonPath(cfg);
  const root = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    servers: Record<string, { command: string; args: string[]; env: Record<string, string>; tools: Record<string, 'read' | 'action'> }>;
  };
  let changed = false;
  for (const key of keys) {
    const server = root.servers[key];
    if (!server) continue;
    const res = await postJson(`${cfg.agentUrl}/api/onboarding/mcp-probe`, {
      server: { command: server.command, args: server.args, env: server.env },
    }).catch((err: Error) => ({ ok: false, tools: [], error: err.message }));
    if (!res.ok) {
      console.log(`✗ ${key.padEnd(12)} probe failed — ${res.error ?? 'unknown error'} (tools left as-is)`);
      continue;
    }
    const folded = toolsFromProbe(server.tools ?? {}, res.tools as string[]);
    for (const name of folded.skipped) console.log(`  ⚠ ${key}: tool "${name}" has an unsupported name — skipped`);
    server.tools = folded.tools;
    changed = true;
    const count = res.tools.length - folded.skipped.length;
    console.log(
      `✓ ${key.padEnd(12)} probe ok — ${count} tools written as "action" (consent-gated; edit to "read" for read-only tools)`,
    );
  }
  if (changed) writeMcpJson(cfg, `${JSON.stringify(root, null, 2)}\n`);
}
