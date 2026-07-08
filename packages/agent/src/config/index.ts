import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { CONFIG_FILE_NAMES, type ConfigFileName } from '@botty/shared';
import type { AgentEnv } from '../env.js';
import type { Bus } from '../bus/index.js';
import type { Db } from '../db/index.js';
import { parseHeartbeat, parseTeam, type HeartbeatConfig, type TeamConfig } from './parse.js';

export type { HeartbeatConfig, TeamConfig, TeamMember } from './parse.js';
export { parseHeartbeat, parseTeam } from './parse.js';

const DEBOUNCE_MS = 500;

export interface ConfigManager {
  /** Raw markdown of a config file. */
  raw(name: ConfigFileName): string;
  /** PERSONA.md content (raw markdown, injected into prompts). */
  persona(): string;
  team(): TeamConfig;
  heartbeat(): HeartbeatConfig;
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
  const contents = new Map<ConfigFileName, string>();
  let teamCache: TeamConfig | null = null;
  let heartbeatCache: HeartbeatConfig | null = null;
  let watcher: FSWatcher | null = null;
  const timers = new Map<ConfigFileName, NodeJS.Timeout>();

  function readFile(name: ConfigFileName): string {
    try {
      return fs.readFileSync(filePath(name), 'utf8');
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

  function afterChange(name: ConfigFileName): void {
    if (name === 'team') materializePeople();
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
      if (!teamCache) teamCache = parseTeam(contents.get('team') ?? '');
      return teamCache;
    },
    heartbeat() {
      if (!heartbeatCache) heartbeatCache = parseHeartbeat(contents.get('heartbeat') ?? '', env.mode);
      return heartbeatCache;
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
        CONFIG_FILE_NAMES.map((n) => filePath(n)),
        { ignoreInitial: true },
      );
      watcher.on('all', (_event, changedPath) => {
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
  return manager;
}
