export const AGENT_PORT = 4820;
export const SIM_PORT = 4821;

export const SOURCES = ['slack', 'gmail', 'gcal', 'jira', 'github'] as const;
export type SourceId = (typeof SOURCES)[number];

export type LlmTask =
  | 'chat'
  | 'judgment'
  | 'classification'
  | 'extraction'
  | 'briefing'
  | 'resolution'
  | 'seal';

export const DEFAULT_MODELS: Record<LlmTask, string> = {
  chat: 'claude-sonnet-5',
  judgment: 'claude-sonnet-5',
  briefing: 'claude-sonnet-5',
  classification: 'claude-haiku-4-5',
  extraction: 'claude-haiku-4-5',
  // Wrongly closing a task is worse than a missed nudge — resolution gets the judgment-tier model.
  resolution: 'claude-sonnet-5',
  // Session-seal summaries are housekeeping, not user-facing judgment — cheap-model routing
  // (2026-07-09 investigation "Cheap-model overrides for housekeeping").
  seal: 'claude-haiku-4-5',
};

// ---------- costs ----------

/** Activity buckets for the costs report, derived from ai_decisions.kind. */
export const COST_CATEGORIES = ['chat', 'intake', 'proactive', 'resolution', 'briefing', 'other'] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const COST_CATEGORY_LABELS: Record<CostCategory, string> = {
  chat: 'Chat',
  intake: 'Source intake',
  proactive: 'Proactive loop',
  resolution: 'Resolution sweep',
  briefing: 'Briefings & summaries',
  other: 'Other',
};

/** ai_decisions.kind → category. Chat records as 'chat_turn'; structured kinds match LlmTask. */
export const COST_CATEGORY_BY_KIND: Record<string, CostCategory> = {
  chat_turn: 'chat',
  classification: 'intake',
  extraction: 'intake',
  judgment: 'proactive',
  resolution: 'resolution',
  briefing: 'briefing',
  // Session-seal summaries are chat housekeeping, not a morning/evening briefing.
  seal: 'chat',
};

export interface ModelPricing {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/**
 * Claude API list prices (USD/MTok). botty runs on a subscription via the Agent
 * SDK, so the costs report prices what the recorded usage *would* cost at API
 * rates. Extend/override per model via the `llm.pricing` settings key.
 */
export const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
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
  // Candidate-gathering thresholds (tick step 4).
  /** DUE_SOON: open tasks due within this many days. */
  dueSoonDays: 2,
  /** NEVER_SURFACED: open tasks created at least this many hours ago with surface_count=0. */
  neverSurfacedMinAgeHours: 4,
  /** STALE: open tasks not updated in this many days. */
  staleAfterDays: 5,
  /** Resolution sweep: auto-close tasks already handled in their source thread. */
  autoResolveTasks: true,
  // Evidence only arrives via source polls (slack real: 10m) — sweeping faster is wasted.
  resolutionSweepIntervalMin: 10,
  maxResolutionChecksPerSweep: 5,
  resolutionCheckCooldownMin: 10,
  /** Minimum LLM confidence (0-1) to auto-close. */
  resolutionConfidenceMin: 0.8,
  // Inferred commitments (2026-07-09 investigation feature #2): hidden post-turn
  // chat extraction of short-lived follow-ups, delivered through the tick when due.
  /** Enable the post-turn commitment-extraction pass. */
  inferCommitments: true,
  /** Echo-back guard: a commitment can't be delivered within this many minutes of creation. */
  commitmentMinAgeMin: 30,
  /** Delivery cap: at most this many commitment notifications in a trailing 24h window. */
  commitmentsMaxPerDay: 3,
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
  | 'DEDUPED' // extraction matched an existing open task cross-source; no new task created
  | 'UPSERTED' // structured sources (jira/github/gcal) that skip the funnel
  | 'ERROR';
