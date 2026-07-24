import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CliConfig } from '../config.js';
import { discoverClaudeServers, readClaudeFiles, sanitizeKey } from '../claude-mcp.js';
import { getJson } from '../http.js';
import { repoRoot } from '../procs.js';
import { webDistIndex } from './start.js';

const MIN_NODE = [22, 12] as const;

/** engines.node check, pure for tests. */
export function nodeVersionOk(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** Newest mtime under dir (recursive); 0 when unreadable. */
function newestMtime(dir: string): number {
  try {
    let newest = 0;
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const t = fs.statSync(path.join(entry.parentPath, entry.name)).mtimeMs;
      if (t > newest) newest = t;
    }
    return newest;
  } catch {
    return 0;
  }
}

function onPath(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface Check {
  label: string;
  state: 'ok' | 'warn' | 'fail';
  detail: string;
}

/** Importable Claude Code stdio servers whose (sanitized) key is absent from botty's mcp.json. */
function countUnimportedClaudeServers(cfg: CliConfig): number {
  const d = discoverClaudeServers(readClaudeFiles(os.homedir(), process.cwd()));
  let bottyKeys = new Set<string>();
  try {
    const root: unknown = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, 'config', 'mcp.json'), 'utf8'));
    const servers = (root as { servers?: unknown }).servers;
    if (typeof servers === 'object' && servers !== null) bottyKeys = new Set(Object.keys(servers));
  } catch {
    /* absent or unparseable — treat as none imported */
  }
  return d.servers.filter(
    (s) =>
      s.transport === 'stdio' &&
      s.shadowedBy === undefined &&
      !s.disabledInClaude &&
      !bottyKeys.has(sanitizeKey(s.key, new Set()).key),
  ).length;
}

export async function doctor(cfg: CliConfig): Promise<void> {
  const checks: Check[] = [];

  checks.push({
    label: 'node',
    state: nodeVersionOk(process.versions.node) ? 'ok' : 'fail',
    detail: `${process.versions.node} (need ≥ ${MIN_NODE.join('.')})`,
  });

  if (fs.existsSync(webDistIndex)) {
    const stale = newestMtime(path.join(repoRoot, 'packages/web/src')) > fs.statSync(webDistIndex).mtimeMs;
    checks.push({
      label: 'web dist',
      state: stale ? 'warn' : 'ok',
      detail: stale ? 'built, but web/src is newer — `npm run build -w @botty/web` when the live agent is not serving it' : 'built',
    });
  } else {
    checks.push({ label: 'web dist', state: 'fail', detail: 'missing — `botty start` builds it once' });
  }

  try {
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    checks.push({ label: 'data dir', state: 'ok', detail: cfg.dataDir });
  } catch (err) {
    checks.push({ label: 'data dir', state: 'fail', detail: `${cfg.dataDir} not creatable: ${(err as Error).message}` });
  }

  const health = await getJson(`${cfg.agentUrl}/api/health`).catch(() => null);
  checks.push({
    label: 'agent',
    state: health ? 'ok' : 'fail',
    detail: health ? `:${cfg.port} mode=${health.mode} onboarded=${health.onboarded}` : `nothing healthy on :${cfg.port} — \`botty start\``,
  });

  if (cfg.mode === 'sim') {
    const state = await getJson(`${cfg.simUrl}/control/state`).catch(() => null);
    checks.push({
      label: 'sim',
      state: state ? 'ok' : 'fail',
      detail: state ? `:${cfg.simPort} reachable` : `nothing on :${cfg.simPort} — \`botty start\``,
    });
  }

  if (process.platform === 'darwin') {
    checks.push({
      label: 'notifier',
      state: onPath('terminal-notifier') ? 'ok' : 'warn',
      detail: onPath('terminal-notifier')
        ? 'terminal-notifier on PATH'
        : 'terminal-notifier missing (`brew install terminal-notifier`) — nudge banners fall back, see docs/TESTING.md §1',
    });
  }

  const hasAuthEnv = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const hasClaudeLogin = fs.existsSync(path.join(os.homedir(), '.claude.json')) || fs.existsSync(path.join(os.homedir(), '.claude'));
  checks.push({
    label: 'llm auth',
    state: hasAuthEnv || hasClaudeLogin ? 'ok' : 'warn',
    detail: hasAuthEnv
      ? 'ANTHROPIC_* env var set'
      : hasClaudeLogin
        ? 'Claude Code login detected — the Agent SDK resolves it ambiently'
        : 'no ANTHROPIC_* env var and no Claude Code login found — real-LLM calls will fail (BOTTY_MOCK_LLM=1 unaffected)',
  });

  // Passive nudge only — emitted when Claude Code has importable MCP servers
  // botty doesn't know about; discovery failures must never break doctor.
  try {
    const unimported = countUnimportedClaudeServers(cfg);
    if (unimported > 0) {
      checks.push({
        label: 'mcp',
        state: 'warn',
        detail: `${unimported} Claude Code MCP server(s) not imported — \`botty mcp import\``,
      });
    }
  } catch {
    /* ignore */
  }

  const icon = { ok: '✓', warn: '⚠', fail: '✗' } as const;
  for (const c of checks) console.log(`${icon[c.state]} ${c.label.padEnd(9)} ${c.detail}`);
  if (checks.some((c) => c.state === 'fail')) process.exitCode = 1;
}
