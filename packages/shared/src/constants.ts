export const AGENT_PORT = 4820;
export const SIM_PORT = 4821;

export const SOURCES = ['slack', 'gmail', 'gcal', 'jira', 'github'] as const;
export type SourceId = (typeof SOURCES)[number];

export type LlmTask = 'chat' | 'judgment' | 'classification' | 'extraction' | 'briefing' | 'resolution';

export const DEFAULT_MODELS: Record<LlmTask, string> = {
  chat: 'claude-sonnet-5',
  judgment: 'claude-sonnet-5',
  briefing: 'claude-sonnet-5',
  classification: 'claude-haiku-4-5',
  extraction: 'claude-haiku-4-5',
  // Wrongly closing a task is worse than a missed nudge — resolution gets the judgment-tier model.
  resolution: 'claude-sonnet-5',
};

export const HEARTBEAT_DEFAULTS = {
  tickIntervalMin: 20,
  /**
   * Hard on/off window: outside working hours (or on inactive days) botty does
   * NOTHING — no source polls, no ticks, no briefings, no LLM calls. Zero token
   * usage. quietHours (below) remains a softer surfacing gate inside the window.
   */
  workingHours: { start: '08:00', end: '19:00' },
  quietHours: { start: '22:00', end: '08:00' },
  activeDays: [1, 2, 3, 4, 5], // Mon-Fri (0=Sun)
  surfacingThreshold: 7,
  maxSurfacesPerTask: 3,
  maxProactivePerHour: 2,
  minGapBetweenNudgesMin: 30,
  maxSnoozesPerTick: 5,
  morningBriefAt: '08:45',
  eveningBriefAt: '18:00',
  responseWindowHours: 24,
  chatActiveGateMin: 2,
  sessionIdleSealMin: 30,
  /** cooldown hours keyed by surface_count before this surface */
  surfaceCooldownHours: { 1: 48, 2: 96, 3: 168 } as Record<number, number>,
  meetingPrepLeadMin: 60,
  /** Resolution sweep: auto-close tasks already handled in their source thread. */
  autoResolveTasks: true,
  // Evidence only arrives via source polls (slack real: 10m) — sweeping faster is wasted.
  resolutionSweepIntervalMin: 10,
  maxResolutionChecksPerSweep: 5,
  resolutionCheckCooldownMin: 10,
  /** Minimum LLM confidence (0-1) to auto-close. */
  resolutionConfidenceMin: 0.8,
} as const;

/** Per-source poll intervals in minutes. */
export const SOURCE_INTERVALS_REAL: Record<SourceId, number> = {
  slack: 10, gmail: 30, gcal: 60, jira: 120, github: 120,
};
/** In sim mode everything polls fast so demos feel live (minutes). */
export const SOURCE_INTERVALS_SIM: Record<SourceId, number> = {
  slack: 1, gmail: 1, gcal: 1, jira: 1, github: 1,
};

export type FunnelOutcome =
  | 'DUPLICATE'
  | 'INTERACTION_ONLY'
  | 'NO_SIGNAL'
  | 'CLASSIFIED_OUT'
  | 'EXTRACTED'
  | 'UPSERTED' // structured sources (jira/github/gcal) that skip the funnel
  | 'ERROR';
