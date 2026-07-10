import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PORT } from '@botty/shared';

export interface AgentEnv {
  /** Root data directory (default ~/.botty, override BOTTY_DATA_DIR). */
  dataDir: string;
  dbPath: string;
  configDir: string;
  /** Snapshots of previous config versions live here. */
  configArchiveDir: string;
  logsDir: string;
  mode: 'sim' | 'real';
  simUrl: string;
  mockLlm: boolean;
  port: number;
}

const CONFIG_FILES = ['persona.md', 'team.md', 'heartbeat.md'] as const;
/** JSON config, seeded/hot-reloaded separately from the markdown trio (config/mcp.ts). */
const MCP_CONFIG_FILE = 'mcp.json';

/** Directory containing the shipped config templates (packages/agent/config-templates). */
export const templatesDir = fileURLToPath(new URL('../config-templates/', import.meta.url));

function truthy(v: string | undefined): boolean {
  return v === '1' || v?.toLowerCase() === 'true';
}

/**
 * Resolve environment variables into a typed AgentEnv, create the data/config/log
 * directories on first run, and seed config templates into <dataDir>/config/ if absent.
 */
export function loadEnv(overrides: Partial<AgentEnv> = {}): AgentEnv {
  const dataDir =
    overrides.dataDir ?? process.env.BOTTY_DATA_DIR ?? path.join(os.homedir(), '.botty');

  const rawMode = process.env.BOTTY_MODE ?? 'sim';
  const mode = overrides.mode ?? (rawMode === 'real' ? 'real' : 'sim');

  const env: AgentEnv = {
    dataDir,
    dbPath: overrides.dbPath ?? path.join(dataDir, 'data', 'botty.db'),
    configDir: overrides.configDir ?? path.join(dataDir, 'config'),
    configArchiveDir: overrides.configArchiveDir ?? path.join(dataDir, 'config', 'archive'),
    logsDir: overrides.logsDir ?? path.join(dataDir, 'logs'),
    mode,
    simUrl: overrides.simUrl ?? process.env.BOTTY_SIM_URL ?? 'http://localhost:4821',
    mockLlm: overrides.mockLlm ?? truthy(process.env.BOTTY_MOCK_LLM),
    port: overrides.port ?? Number(process.env.AGENT_PORT ?? AGENT_PORT),
  };

  fs.mkdirSync(path.dirname(env.dbPath), { recursive: true });
  fs.mkdirSync(env.configDir, { recursive: true });
  fs.mkdirSync(env.configArchiveDir, { recursive: true });
  fs.mkdirSync(env.logsDir, { recursive: true });

  seedConfigTemplates(env.configDir, env.mode);
  return env;
}

/** team.md / persona.md have a `.real.md` counterpart with the Acme/Marian/Sofi/Diego
 *  fixtures (and Maxo's persona) stripped out — see config-templates/*.real.md. */
const REAL_VARIANT_FILES = new Set(['team.md', 'persona.md']);

/**
 * Copy any missing config files from the shipped templates. Never overwrites.
 *
 * Mode-aware (H3): `sim` keeps the fictional Acme/Marian/Sofi/Diego team.md and
 * Maxo's persona.md — the sim scenario scripts depend on those exact fixtures.
 * `real` seeds the same file names but from the `.real.md` template variants,
 * which ship with zero live people (team.md) and a neutral fill-in-yourself
 * persona, so a fresh real install never treats fictional people as Tier 1.
 */
export function seedConfigTemplates(configDir: string, mode: 'sim' | 'real' = 'sim'): void {
  for (const file of [...CONFIG_FILES, MCP_CONFIG_FILE]) {
    const dest = path.join(configDir, file);
    if (fs.existsSync(dest)) continue;
    const useRealVariant = mode === 'real' && REAL_VARIANT_FILES.has(file);
    const srcName = useRealVariant ? file.replace(/\.md$/, '.real.md') : file;
    const src = path.join(templatesDir, srcName);
    fs.copyFileSync(src, dest);
  }
}
