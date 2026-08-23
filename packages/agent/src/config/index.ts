import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { CONFIG_FILE_NAMES, type ConfigFileName } from '@botty/shared';
import type { AgentEnv } from '../env.js';
import type { Bus } from '../bus/index.js';
import type { Db } from '../db/index.js';
import { parseHeartbeat, parseTeam, type HeartbeatConfig, type TeamConfig } from './parse.js';
import { EMPTY_MCP_CONFIG, parseMcpConfig, type McpConfig } from './mcp.js';

export type { ChecklistTask, HeartbeatConfig, TeamConfig, TeamMember } from './parse.js';
export { checklistTaskId, parseHeartbeat, parseTeam } from './parse.js';
export { EMPTY_MCP_CONFIG, McpConfigSchema, McpServerConfigSchema, McpToolModeSchema } from './mcp.js';
export type { McpConfig, McpParseResult, McpServerConfig, McpToolMode } from './mcp.js';
export {
  answersFromConfig,
  personaAnswersFromRaw,
  renderHeartbeat,
  renderMcp,
  renderPersona,
  renderTeam,
} from './render.js';

const DEBOUNCE_MS = 500;
/** mcp.json is JSON, not markdown, so it's watched/loaded outside the CONFIG_FILE_NAMES trio. */
const MCP_FILE_NAME = 'mcp.json';
/** Internal key for the mcp.json debounce timer + config.changed name — never in CONFIG_FILE_NAMES. */
const MCP_KEY = 'mcp';

/** Warnings from a heartbeat.md version that is NOT being served (see heartbeatIssues). */
export interface ConfigIssues {
  warnings: string[];
  /** When the offending content was first seen. */
  since: string;
}

export interface ConfigManager {
  /** Raw markdown of a config file. */
  raw(name: ConfigFileName): string;
  /** PERSONA.md content (raw markdown, injected into prompts). */
  persona(): string;
  /**
   * Team roster (TEAM.md) in effect. Same last-known-good semantics as
   * heartbeat()/mcp(): a revision that parses with warnings never replaces a
   * previously clean roster — a truncated/corrupted write must not silently
   * demote everyone to tier-2/'departed' via materializePeople(). The single
   * "TEAM.md defines no people" warning (an intentionally empty file, not a
   * parse failure) is exempt — see teamIssues()'s doc comment.
   */
  team(): TeamConfig;
  /**
   * Warnings for the current team.md content when it isn't what's being
   * served (last-known-good in effect), or when a broken file was served with
   * defaults at boot. Null when the file on disk parsed cleanly (an
   * intentionally-empty file, which parses with only the "defines no people"
   * warning, counts as clean here — it's expected on a fresh install, not a
   * truncation/parse-failure signal).
   */
  teamIssues(): ConfigIssues | null;
  /**
   * The heartbeat config in effect. A hot reload (or save) whose content parses
   * with warnings does NOT replace a previously clean config — the last-known-good
   * version keeps being served and the rejected content's warnings are exposed
   * via heartbeatIssues(). On boot with a broken file there is no last-known-good,
   * so the per-field-defaulted parse is served (with issues set).
   */
  heartbeat(): HeartbeatConfig;
  /**
   * Warnings for the current heartbeat.md content when it is not what's being
   * served (last-known-good in effect), or when a broken file was served with
   * defaults at boot. Null when the file on disk parsed cleanly.
   */
  heartbeatIssues(): ConfigIssues | null;
  /**
   * External MCP servers/tools (mcp.json) in effect. Same last-known-good
   * semantics as heartbeat(): a hot-reloaded revision with warnings never
   * replaces a previously-good config; on boot with a broken/missing file
   * this serves the empty config ({ servers: {} }).
   */
  mcp(): McpConfig;
  /** Warnings for the current mcp.json content when it isn't what's being served. Null when clean. */
  mcpIssues(): ConfigIssues | null;
  /** Raw mcp.json content on disk ('' when absent). */
  mcpRaw(): string;
  /**
   * Same validate → archive → write → hot-reload path as save(), for mcp.json
   * (archived as mcp-<ts>.json — added with the onboarding wizard; previously
   * only the markdown trio was archived). Archive copies contain env secrets
   * exactly as the live file does — same directory, same exposure.
   */
  saveMcp(content: string): { warnings: string[] };
  /**
   * Validate + snapshot the previous version to config/archive/ + write + hot-reload.
   * Returns parser warnings (never throws on content issues — config is forgiving).
   */
  save(name: ConfigFileName, content: string): { warnings: string[] };
  /**
   * Upsert the people table from TEAM.md (CRITICAL/HIGH ⇒ tier 1, else tier 2);
   * team_md rows no longer in the file are demoted to tier 2.
   */
  materializePeople(): void;
  /** Start the chokidar watcher (500ms debounce). */
  startWatching(): void;
  stop(): Promise<void>;
}

export function createConfig(env: AgentEnv, db: Db, bus: Bus): ConfigManager {
  const filePath = (name: ConfigFileName) => path.join(env.configDir, `${name}.md`);
  const mcpFilePath = path.join(env.configDir, MCP_FILE_NAME);
  const contents = new Map<ConfigFileName, string>();
  let teamCache: TeamConfig | null = null;
  /** Last team.md config that parsed without BLOCKING warnings (fail-safe for hot reloads). */
  let teamLastGood: TeamConfig | null = null;
  /** Warnings + timestamp for on-disk team.md content that is not being served. */
  let teamPending: ConfigIssues | null = null;
  let heartbeatCache: HeartbeatConfig | null = null;
  /** Last heartbeat config that parsed without warnings (fail-safe for hot reloads). */
  let heartbeatLastGood: HeartbeatConfig | null = null;
  /** Warnings + timestamp for on-disk heartbeat content that is not being served. */
  let heartbeatPending: ConfigIssues | null = null;
  let mcpRaw = '';
  let mcpCache: McpConfig | null = null;
  /** Last mcp.json config that parsed without warnings; empty on first boot if broken. */
  let mcpLastGood: McpConfig = EMPTY_MCP_CONFIG;
  /** Warnings + timestamp for on-disk mcp.json content that is not being served. */
  let mcpPending: ConfigIssues | null = null;
  let watcher: FSWatcher | null = null;
  const timers = new Map<ConfigFileName | typeof MCP_KEY, NodeJS.Timeout>();

  function readFile(name: ConfigFileName): string {
    try {
      return fs.readFileSync(filePath(name), 'utf8');
    } catch {
      return '';
    }
  }

  function readMcpFile(): string {
    try {
      return fs.readFileSync(mcpFilePath, 'utf8');
    } catch {
      return '';
    }
  }

  function load(name: ConfigFileName): boolean {
    const next = readFile(name);
    if (contents.get(name) === next) return false;
    contents.set(name, next);
    if (name === 'team') teamCache = null;
    if (name === 'heartbeat') heartbeatCache = null;
    return true;
  }

  function loadMcp(): boolean {
    const next = readMcpFile();
    if (mcpRaw === next) return false;
    mcpRaw = next;
    mcpCache = null;
    return true;
  }

  /**
   * Evaluate the current team.md content with the same last-known-good
   * semantics as evalHeartbeat/evalMcp: a parse with BLOCKING warnings (an
   * unparseable line, an unknown field/weight — the kind of thing a truncated
   * mid-write leaves behind) never replaces a previously clean roster; the
   * last-good roster keeps being served. "TEAM.md defines no people" is the
   * ONE non-blocking warning (render.ts already treats it the same way when
   * building the combined config-issues banner) — a genuinely empty/missing
   * file is "no data yet", not a parse failure, and must be free to adopt
   * (materializePeople() also short-circuits on an empty roster rather than
   * demoting anyone — see its own comment). Boot with a broken file, like the
   * other two, serves the per-field-defaulted parse (there's no last-good yet).
   */
  function evalTeam(): TeamConfig {
    const parsed = parseTeam(contents.get('team') ?? '');
    const blocking = parsed.warnings.filter((w) => w !== 'TEAM.md defines no people');
    if (blocking.length === 0) {
      teamLastGood = parsed;
      teamPending = null;
      return parsed;
    }
    teamPending = {
      warnings: [...parsed.warnings],
      since: teamPending?.since ?? new Date().toISOString(),
    };
    return teamLastGood ?? parsed;
  }

  /**
   * Evaluate the current heartbeat.md content with last-known-good semantics:
   * clean parse ⇒ adopt it (and remember it as last-good); warnings ⇒ keep
   * serving the last-good config and stash the warnings; warnings with no
   * last-good (boot with a broken file) ⇒ serve the per-field-defaulted parse.
   */
  function evalHeartbeat(): HeartbeatConfig {
    const parsed = parseHeartbeat(contents.get('heartbeat') ?? '', env.mode);
    if (parsed.warnings.length === 0) {
      heartbeatLastGood = parsed;
      heartbeatPending = null;
      return parsed;
    }
    heartbeatPending = {
      warnings: [...parsed.warnings],
      since: heartbeatPending?.since ?? new Date().toISOString(),
    };
    return heartbeatLastGood ?? parsed;
  }

  /**
   * Evaluate the current mcp.json content with the same last-known-good
   * semantics as evalHeartbeat: clean parse ⇒ adopt + remember; warnings ⇒
   * keep serving the last-good config (empty on first boot if broken).
   */
  function evalMcp(): McpConfig {
    const { config, warnings } = parseMcpConfig(mcpRaw);
    if (warnings.length === 0) {
      mcpLastGood = config;
      mcpPending = null;
      return config;
    }
    mcpPending = {
      warnings: [...warnings],
      since: mcpPending?.since ?? new Date().toISOString(),
    };
    return mcpLastGood;
  }

  function afterChange(name: ConfigFileName | typeof MCP_KEY): void {
    if (name === MCP_KEY) {
      // Force evaluation so mcpPending reflects the new content, same pattern
      // as heartbeat below.
      manager.mcp();
      const warnings = mcpPending?.warnings;
      bus.broadcast({
        type: 'config.changed',
        payload: { name: MCP_KEY, ...(warnings && warnings.length > 0 ? { warnings } : {}) },
      });
      return;
    }
    if (name === 'team') {
      // materializePeople() itself calls manager.team(), which forces
      // evaluation so teamPending reflects the new content — same pattern as
      // heartbeat/mcp below. A blocking-warning revision is never adopted (the
      // last-known-good roster keeps materializing), so a truncated write
      // can no longer demote the whole roster to tier-2/'departed'.
      materializePeople();
      const warnings = teamPending?.warnings;
      bus.broadcast({
        type: 'config.changed',
        payload: { name, ...(warnings && warnings.length > 0 ? { warnings } : {}) },
      });
      return;
    }
    if (name === 'heartbeat') {
      // Force evaluation so heartbeatPending reflects the new content, and
      // surface the warnings in the broadcast (hot-reload warnings used to be
      // silently discarded — the save() HTTP path was the only place they showed).
      manager.heartbeat();
      const warnings = heartbeatPending?.warnings;
      bus.broadcast({
        type: 'config.changed',
        payload: { name, ...(warnings && warnings.length > 0 ? { warnings } : {}) },
      });
      return;
    }
    bus.broadcast({ type: 'config.changed', payload: { name } });
  }

  function materializePeople(): void {
    const { people } = manager.team();
    // Empty parse (missing/unreadable TEAM.md) means "no data", not "everyone left" —
    // never demote the whole roster off a blank file.
    if (people.length === 0) return;
    const keepIds = people.map(
      (member) =>
        db.upsertTeamPerson({
          name: member.name,
          weight: member.weight,
          slackHandle: member.slackHandle,
          email: member.email,
          cadence: member.cadence,
          notes: member.notes,
        }).id,
    );
    // People removed (or renamed away) in TEAM.md must not keep tier-1 status forever.
    db.demoteTeamPeopleNotIn(keepIds);
  }

  const manager: ConfigManager = {
    raw(name) {
      return contents.get(name) ?? '';
    },
    persona() {
      return contents.get('persona') ?? '';
    },
    team() {
      if (!teamCache) teamCache = evalTeam();
      return teamCache;
    },
    teamIssues() {
      manager.team(); // ensure the current content has been evaluated
      return teamPending;
    },
    heartbeat() {
      if (!heartbeatCache) heartbeatCache = evalHeartbeat();
      return heartbeatCache;
    },
    heartbeatIssues() {
      manager.heartbeat(); // ensure the current content has been evaluated
      return heartbeatPending;
    },
    mcp() {
      if (!mcpCache) mcpCache = evalMcp();
      return mcpCache;
    },
    mcpIssues() {
      manager.mcp(); // ensure the current content has been evaluated
      return mcpPending;
    },
    mcpRaw() {
      return mcpRaw;
    },
    saveMcp(content) {
      const { warnings } = parseMcpConfig(content);
      const previous = readMcpFile();
      if (previous) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.mkdirSync(env.configArchiveDir, { recursive: true });
        fs.writeFileSync(path.join(env.configArchiveDir, `mcp-${ts}.json`), previous, 'utf8');
      }
      fs.writeFileSync(mcpFilePath, content, 'utf8');
      if (loadMcp()) afterChange(MCP_KEY);
      return { warnings };
    },
    save(name, content) {
      // Validate (parsers never throw; they collect warnings).
      const warnings =
        name === 'team'
          ? parseTeam(content).warnings
          : name === 'heartbeat'
            ? parseHeartbeat(content, env.mode).warnings
            : [];
      // Snapshot the previous version.
      const previous = readFile(name);
      if (previous) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        fs.mkdirSync(env.configArchiveDir, { recursive: true });
        fs.writeFileSync(path.join(env.configArchiveDir, `${name}-${ts}.md`), previous, 'utf8');
      }
      fs.writeFileSync(filePath(name), content, 'utf8');
      if (load(name)) afterChange(name);
      return { warnings };
    },
    materializePeople,
    startWatching() {
      if (watcher) return;
      watcher = chokidar.watch(
        [...CONFIG_FILE_NAMES.map((n) => filePath(n)), mcpFilePath],
        { ignoreInitial: true },
      );
      watcher.on('all', (_event, changedPath) => {
        if (path.basename(changedPath) === MCP_FILE_NAME) {
          clearTimeout(timers.get(MCP_KEY));
          timers.set(
            MCP_KEY,
            setTimeout(() => {
              timers.delete(MCP_KEY);
              if (loadMcp()) afterChange(MCP_KEY);
            }, DEBOUNCE_MS),
          );
          return;
        }
        const base = path.basename(changedPath, '.md') as ConfigFileName;
        if (!CONFIG_FILE_NAMES.includes(base)) return;
        clearTimeout(timers.get(base));
        timers.set(
          base,
          setTimeout(() => {
            timers.delete(base);
            if (load(base)) afterChange(base);
          }, DEBOUNCE_MS),
        );
      });
    },
    async stop() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
    },
  };

  for (const name of CONFIG_FILE_NAMES) load(name);
  loadMcp();
  return manager;
}
