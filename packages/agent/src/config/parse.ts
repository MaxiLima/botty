import { createHash } from 'node:crypto';
import { HEARTBEAT_DEFAULTS, SOURCES, SOURCE_INTERVALS_REAL, SOURCE_INTERVALS_SIM } from '@botty/shared';
import type { SourceId } from '@botty/shared';

// ---------- TEAM.md ----------

export interface TeamMember {
  name: string;
  weight: 'CRITICAL' | 'HIGH' | 'NORMAL';
  slackHandle: string | null;
  email: string | null;
  cadence: string | null;
  notes: string | null;
}

export interface TeamConfig {
  people: TeamMember[];
  warnings: string[];
}

const WEIGHTS = new Set(['CRITICAL', 'HIGH', 'NORMAL']);

/**
 * Parse TEAM.md. Expected format (robust to spacing / missing fields):
 *
 *   ## People
 *   - **Name** — weight: HIGH | slack: @handle | email: x@y | cadence: weekly | notes: ...
 */
export function parseTeam(md: string): TeamConfig {
  const warnings: string[] = [];
  const people: TeamMember[] = [];
  const section = extractSection(md, 'People');
  const body = section ?? md; // tolerate a file without the header
  if (section === null) warnings.push("TEAM.md has no '## People' section; scanning whole file");

  for (const line of body.split('\n')) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (!bullet) continue;
    const text = bullet[1]!.trim();
    if (!text) continue;

    // Name: bold text if present, otherwise everything before the first — / | / em-dash.
    let name: string | undefined;
    let rest = text;
    const bold = text.match(/\*\*(.+?)\*\*/);
    if (bold) {
      name = bold[1]!.trim();
      rest = text.slice(text.indexOf(bold[0]) + bold[0].length);
    } else {
      const m = text.match(/^([^—|–-]+)[—|–-]/);
      if (m) {
        name = m[1]!.trim();
        rest = text.slice(m[0].length);
      }
    }
    if (!name) {
      warnings.push(`Skipped unparseable team line: "${text.slice(0, 60)}"`);
      continue;
    }

    const member: TeamMember = {
      name,
      weight: 'NORMAL',
      slackHandle: null,
      email: null,
      cadence: null,
      notes: null,
    };
    // Fields are `key: value` separated by |; the leading segment may start with — .
    for (const partRaw of rest.replace(/^\s*[—–-]\s*/, '').split('|')) {
      const part = partRaw.trim();
      if (!part) continue;
      const kv = part.match(/^([a-zA-Z_ ]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1]!.trim().toLowerCase();
      const value = kv[2]!.trim();
      if (!value) continue;
      switch (key) {
        case 'weight': {
          const w = value.toUpperCase();
          if (WEIGHTS.has(w)) member.weight = w as TeamMember['weight'];
          else warnings.push(`Unknown weight "${value}" for ${name}; defaulting to NORMAL`);
          break;
        }
        case 'slack':
        case 'slack handle':
          member.slackHandle = value.startsWith('@') ? value : `@${value}`;
          break;
        case 'email':
          member.email = value;
          break;
        case 'cadence':
          member.cadence = value;
          break;
        case 'notes':
          member.notes = value;
          break;
        default:
          warnings.push(`Unknown field "${key}" for ${name}`);
      }
    }
    people.push(member);
  }
  if (people.length === 0) warnings.push('TEAM.md defines no people');
  return { people, warnings };
}

// ---------- HEARTBEAT.md ----------

/**
 * A user-programmable recurring checklist item from '## Tasks' in heartbeat.md.
 * Due items are offered to the tick's judgment layer as trusted, user-authored
 * instructions (unlike ingested candidate content).
 */
export interface ChecklistTask {
  /** Stable content hash of the prompt — survives reordering/re-parsing. */
  id: string;
  intervalMin: number;
  prompt: string;
}

/** Stable id for a checklist prompt (used as the settings-state key). */
export function checklistTaskId(prompt: string): string {
  return createHash('sha256').update(prompt.trim()).digest('hex').slice(0, 12);
}

export interface HeartbeatConfig {
  tickIntervalMin: number;
  /**
   * HARD on/off window (with activeDays): outside it botty does nothing —
   * no source polls, no ticks, no briefings, no LLM calls. Stronger than
   * quietHours, which only gates surfacing inside the window.
   */
  workingHours: { start: string; end: string };
  quietHours: { start: string; end: string };
  /** 0=Sun .. 6=Sat */
  activeDays: number[];
  morningBriefAt: string;
  eveningBriefAt: string;
  surfacingThreshold: number;
  maxSurfacesPerTask: number;
  maxProactivePerHour: number;
  minGapBetweenNudgesMin: number;
  maxSnoozesPerTick: number;
  /** Hours before an unanswered surface expires (response tracker). */
  responseWindowHours: number;
  /** Rules gate 7: suppress nudges while the user chatted within this many minutes. */
  chatActiveGateMin: number;
  /**
   * Minutes of chat inactivity before a session is sealed. Parsed here for
   * completeness; the chat-side consumer still reads HEARTBEAT_DEFAULTS.
   */
  sessionIdleSealMin: number;
  /** Rules gate 1: per-task cooldown hours keyed by surface_count (1/2/3+). */
  surfaceCooldownHours: Record<number, number>;
  meetingPrepLeadMin: number;
  // Candidate-gathering thresholds (tick step 4).
  dueSoonDays: number;
  neverSurfacedMinAgeHours: number;
  staleAfterDays: number;
  /** Resolution sweep: auto-close tasks already handled in their source thread. */
  autoResolveTasks: boolean;
  resolutionSweepIntervalMin: number;
  maxResolutionChecksPerSweep: number;
  resolutionCheckCooldownMin: number;
  /** Minimum LLM confidence (0-1) to auto-close. */
  resolutionConfidenceMin: number;
  /** Enable the post-turn commitment-extraction pass (chat/commitments.ts). */
  inferCommitments: boolean;
  /** Echo-back guard: a commitment can't be delivered within this many minutes of creation. */
  commitmentMinAgeMin: number;
  /** Delivery cap: at most this many commitment notifications in a trailing 24h window. */
  commitmentsMaxPerDay: number;
  sources: Record<SourceId, { enabled: boolean; intervalMin: number }>;
  /** '## Tasks': recurring user-programmed checklist items for the tick. */
  checklistTasks: ChecklistTask[];
  instructions: string;
  thisWeek: string;
  warnings: string[];
}

/**
 * "HH:MM" syntax + range check (00-23 : 00-59). Mirrors loop/time.ts's
 * parseHHMM range rules; duplicated rather than imported to avoid a
 * config/ <-> loop/ cycle (loop/* already imports config/).
 */
function isValidHHMM(value: string): boolean {
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59;
}

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tuesday: 2,
  wed: 3, wednesday: 3,
  thu: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

/**
 * Parse HEARTBEAT.md. Sections: '## Schedule', '## Behavior', '## Sources',
 * '## Instructions', '## This week' — all values optional; defaults from
 * HEARTBEAT_DEFAULTS in @botty/shared.
 */
export function parseHeartbeat(md: string, mode: 'sim' | 'real' = 'sim'): HeartbeatConfig {
  const warnings: string[] = [];
  const d = HEARTBEAT_DEFAULTS;
  const sourceDefaults = mode === 'sim' ? SOURCE_INTERVALS_SIM : SOURCE_INTERVALS_REAL;

  const cfg: HeartbeatConfig = {
    tickIntervalMin: d.tickIntervalMin,
    workingHours: { ...d.workingHours },
    quietHours: { ...d.quietHours },
    activeDays: [...d.activeDays],
    morningBriefAt: d.morningBriefAt,
    eveningBriefAt: d.eveningBriefAt,
    surfacingThreshold: d.surfacingThreshold,
    maxSurfacesPerTask: d.maxSurfacesPerTask,
    maxProactivePerHour: d.maxProactivePerHour,
    minGapBetweenNudgesMin: d.minGapBetweenNudgesMin,
    maxSnoozesPerTick: d.maxSnoozesPerTick,
    responseWindowHours: d.responseWindowHours,
    chatActiveGateMin: d.chatActiveGateMin,
    sessionIdleSealMin: d.sessionIdleSealMin,
    surfaceCooldownHours: { ...d.surfaceCooldownHours },
    meetingPrepLeadMin: d.meetingPrepLeadMin,
    dueSoonDays: d.dueSoonDays,
    neverSurfacedMinAgeHours: d.neverSurfacedMinAgeHours,
    staleAfterDays: d.staleAfterDays,
    autoResolveTasks: d.autoResolveTasks,
    resolutionSweepIntervalMin: d.resolutionSweepIntervalMin,
    maxResolutionChecksPerSweep: d.maxResolutionChecksPerSweep,
    resolutionCheckCooldownMin: d.resolutionCheckCooldownMin,
    resolutionConfidenceMin: d.resolutionConfidenceMin,
    inferCommitments: d.inferCommitments,
    commitmentMinAgeMin: d.commitmentMinAgeMin,
    commitmentsMaxPerDay: d.commitmentsMaxPerDay,
    sources: Object.fromEntries(
      SOURCES.map((s) => [s, { enabled: true, intervalMin: sourceDefaults[s] }]),
    ) as HeartbeatConfig['sources'],
    checklistTasks: [],
    instructions: '',
    thisWeek: '',
    warnings,
  };

  const kv = (sectionName: string): Map<string, string> => {
    const section = extractSection(md, sectionName);
    const map = new Map<string, string>();
    if (section === null) return map;
    for (const line of section.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('<!--') || trimmed.startsWith('#')) continue;
      const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_ ]*):\s*(.+)$/);
      if (!m) continue;
      map.set(m[1]!.trim().toLowerCase().replace(/\s+/g, '_'), m[2]!.trim());
    }
    return map;
  };

  const num = (map: Map<string, string>, key: string, fallback: number, apply: (n: number) => void) => {
    const v = map.get(key);
    if (v === undefined) return;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) apply(n);
    else warnings.push(`Invalid number for ${key}: "${v}" (using ${fallback})`);
  };

  const schedule = kv('Schedule');
  num(schedule, 'tick_interval_min', cfg.tickIntervalMin, (n) => (cfg.tickIntervalMin = n));
  const window = (key: string, apply: (w: { start: string; end: string }) => void) => {
    const v = schedule.get(key);
    if (v === undefined) return;
    const m = v.match(/^(\d{1,2}:\d{2})\s*[-–—]\s*(\d{1,2}:\d{2})$/);
    if (m && isValidHHMM(m[1]!) && isValidHHMM(m[2]!)) apply({ start: m[1]!, end: m[2]! });
    else warnings.push(`Invalid ${key} "${v}" (expected HH:MM-HH:MM, each 00-23:00-59)`);
  };
  window('working_hours', (w) => (cfg.workingHours = w));
  window('quiet_hours', (w) => (cfg.quietHours = w));
  const days = schedule.get('active_days');
  if (days) {
    const parsed = parseActiveDays(days);
    if (parsed.length > 0) cfg.activeDays = parsed;
    else warnings.push(`Invalid active_days "${days}"`);
  }
  const time = (key: string, apply: (v: string) => void) => {
    const v = schedule.get(key);
    if (v === undefined) return;
    if (isValidHHMM(v)) apply(v);
    else warnings.push(`Invalid time for ${key}: "${v}" (expected HH:MM, 00-23:00-59)`);
  };
  time('morning_brief_at', (v) => (cfg.morningBriefAt = v));
  time('evening_brief_at', (v) => (cfg.eveningBriefAt = v));

  const behavior = kv('Behavior');
  num(behavior, 'surfacing_threshold', cfg.surfacingThreshold, (n) => (cfg.surfacingThreshold = n));
  num(behavior, 'max_surfaces_per_task', cfg.maxSurfacesPerTask, (n) => (cfg.maxSurfacesPerTask = n));
  num(behavior, 'max_proactive_per_hour', cfg.maxProactivePerHour, (n) => (cfg.maxProactivePerHour = n));
  num(behavior, 'min_gap_between_nudges_min', cfg.minGapBetweenNudgesMin, (n) => (cfg.minGapBetweenNudgesMin = n));
  num(behavior, 'max_snoozes_per_tick', cfg.maxSnoozesPerTick, (n) => (cfg.maxSnoozesPerTick = n));
  num(behavior, 'response_window_hours', cfg.responseWindowHours, (n) => (cfg.responseWindowHours = n));
  num(behavior, 'chat_active_gate_min', cfg.chatActiveGateMin, (n) => (cfg.chatActiveGateMin = n));
  num(behavior, 'session_idle_seal_min', cfg.sessionIdleSealMin, (n) => (cfg.sessionIdleSealMin = n));
  num(behavior, 'meeting_prep_lead_min', cfg.meetingPrepLeadMin, (n) => (cfg.meetingPrepLeadMin = n));
  num(behavior, 'due_soon_days', cfg.dueSoonDays, (n) => (cfg.dueSoonDays = n));
  num(behavior, 'never_surfaced_min_age_hours', cfg.neverSurfacedMinAgeHours, (n) => (cfg.neverSurfacedMinAgeHours = n));
  num(behavior, 'stale_after_days', cfg.staleAfterDays, (n) => (cfg.staleAfterDays = n));
  num(behavior, 'resolution_sweep_interval_min', cfg.resolutionSweepIntervalMin, (n) => (cfg.resolutionSweepIntervalMin = n));
  num(behavior, 'max_resolution_checks_per_sweep', cfg.maxResolutionChecksPerSweep, (n) => (cfg.maxResolutionChecksPerSweep = n));
  num(behavior, 'resolution_check_cooldown_min', cfg.resolutionCheckCooldownMin, (n) => (cfg.resolutionCheckCooldownMin = n));
  const confidence = behavior.get('resolution_confidence_min');
  if (confidence !== undefined) {
    const n = Number(confidence);
    if (Number.isFinite(n) && n >= 0 && n <= 1) cfg.resolutionConfidenceMin = n;
    else warnings.push(`Invalid resolution_confidence_min: "${confidence}" (expected 0-1, using ${cfg.resolutionConfidenceMin})`);
  }
  // surface_cooldown_hours: 48/96/168 — cooldowns for surface_count 1 / 2 / 3+.
  const cooldowns = behavior.get('surface_cooldown_hours');
  if (cooldowns !== undefined) {
    const m = cooldowns.match(/^(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)$/);
    if (m) cfg.surfaceCooldownHours = { 1: Number(m[1]), 2: Number(m[2]), 3: Number(m[3]) };
    else warnings.push(`Invalid surface_cooldown_hours "${cooldowns}" (expected e.g. 48/96/168 for 1st/2nd/3rd+ surface)`);
  }
  const autoResolve = behavior.get('auto_resolve_tasks');
  if (autoResolve !== undefined) {
    const on = /^(on|enabled|true|yes)\b/i.test(autoResolve);
    const off = /^(off|disabled|false|no)\b/i.test(autoResolve);
    if (on || off) cfg.autoResolveTasks = on;
    else warnings.push(`Unclear value "${autoResolve}" for auto_resolve_tasks (keeping ${cfg.autoResolveTasks ? 'on' : 'off'})`);
  }
  num(behavior, 'commitment_min_age_min', cfg.commitmentMinAgeMin, (n) => (cfg.commitmentMinAgeMin = n));
  num(behavior, 'commitments_max_per_day', cfg.commitmentsMaxPerDay, (n) => (cfg.commitmentsMaxPerDay = n));
  const inferCommitments = behavior.get('infer_commitments');
  if (inferCommitments !== undefined) {
    const on = /^(on|enabled|true|yes)\b/i.test(inferCommitments);
    const off = /^(off|disabled|false|no)\b/i.test(inferCommitments);
    if (on || off) cfg.inferCommitments = on;
    else warnings.push(`Unclear value "${inferCommitments}" for infer_commitments (keeping ${cfg.inferCommitments ? 'on' : 'off'})`);
  }

  const sources = kv('Sources');
  for (const [key, value] of sources) {
    const source = key as SourceId;
    if (!SOURCES.includes(source)) {
      warnings.push(`Unknown source "${key}" in Sources section`);
      continue;
    }
    const enabled = /^(on|enabled|true|yes)\b/i.test(value);
    const disabled = /^(off|disabled|false|no)\b/i.test(value);
    if (!enabled && !disabled) warnings.push(`Unclear value "${value}" for source ${key} (treating as off)`);
    const entry = cfg.sources[source];
    entry.enabled = enabled;
    const every = value.match(/every\s+(\d+)\s*m/i);
    if (every) entry.intervalMin = Number(every[1]);
  }

  // '## Tasks' — recurring checklist items: `- every 4h: <instruction>`.
  const tasksSection = extractSection(md, 'Tasks');
  if (tasksSection !== null) {
    const seen = new Set<string>();
    for (const line of tasksSection.split('\n')) {
      const bullet = line.match(/^\s*[-*]\s+(.*)$/);
      if (!bullet) continue; // non-bullet lines (prose, comments) are ignored
      const text = bullet[1]!.trim();
      if (!text) continue;
      const m = text.match(/^every\s+(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)\s*:\s*(.+)$/i);
      if (!m) {
        warnings.push(`Unparseable checklist task: "${text.slice(0, 60)}" (expected "every <N><m|h|d>: <instruction>")`);
        continue;
      }
      const unit = m[2]!.toLowerCase();
      const mult = unit.startsWith('d') ? 1440 : unit.startsWith('h') ? 60 : 1;
      const intervalMin = Number(m[1]) * mult;
      if (!(intervalMin > 0)) {
        warnings.push(`Checklist task interval must be positive: "${text.slice(0, 60)}"`);
        continue;
      }
      const prompt = m[3]!.trim();
      const id = checklistTaskId(prompt);
      if (seen.has(id)) {
        warnings.push(`Duplicate checklist task ignored: "${prompt.slice(0, 60)}"`);
        continue;
      }
      seen.add(id);
      cfg.checklistTasks.push({ id, intervalMin, prompt });
    }
  }

  cfg.instructions = (extractSection(md, 'Instructions') ?? '').trim();
  cfg.thisWeek = (extractSection(md, 'This week') ?? '').trim();
  return cfg;
}

function parseActiveDays(value: string): number[] {
  const out = new Set<number>();
  for (const partRaw of value.split(',')) {
    const part = partRaw.trim().toLowerCase();
    if (!part) continue;
    const range = part.match(/^([a-z]+)\s*[-–]\s*([a-z]+)$/);
    if (range) {
      const from = DAY_NAMES[range[1]!];
      const to = DAY_NAMES[range[2]!];
      if (from === undefined || to === undefined) return [];
      let day = from;
      // walk forward with wraparound
      for (let i = 0; i < 7; i++) {
        out.add(day);
        if (day === to) break;
        day = (day + 1) % 7;
      }
      continue;
    }
    const single = DAY_NAMES[part] ?? (/^[0-6]$/.test(part) ? Number(part) : undefined);
    if (single === undefined) return [];
    out.add(single);
  }
  return [...out].sort((a, b) => a - b);
}

/** Return the body of a `## Heading` section (case-insensitive), or null if absent. */
export function extractSection(md: string, heading: string): string | null {
  const lines = md.split('\n');
  const start = lines.findIndex(
    (l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase(),
  );
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l.trim()) || /^#\s/.test(l.trim()));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}
