import {
  HEARTBEAT_DEFAULTS,
  SOURCES,
  SOURCE_INTERVALS_REAL,
  SOURCE_INTERVALS_SIM,
} from '@botty/shared';
import type {
  DirectivesAnswers,
  McpAnswers,
  OnboardingAnswers,
  PersonaAnswers,
  ScheduleAnswers,
  SourcesAnswers,
  TeamAnswers,
} from '@botty/shared';
import type { HeartbeatConfig, TeamMember } from './parse.js';
import type { McpConfig } from './mcp.js';

/**
 * The answers→files renderer for the onboarding wizard (docs/specs/onboarding.md).
 * Co-located with the parsers so round-trip tests can assert parse(render(a)) is
 * lossless for the structured files. Clients never generate markdown/JSON — this
 * module is the single renderer, used by the /api/onboarding endpoints.
 */

const DAY_SHORT = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Free text going into a markdown section body: a line starting with '#' would
 * terminate the section in extractSection, silently truncating on re-parse.
 * Escape it markdown-style (renders identically, no longer heading-shaped). */
function escapeSectionBody(text: string): string {
  return text.replace(/^(\s*)#/gm, '$1\\#');
}

/** Field values inside a team bullet: '|' is the field separator and newlines end
 * the bullet — both would corrupt the line. Stated v1 trade-off: normalized away. */
function sanitizeInlineField(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/').trim();
}

// ---------- team.md ----------

const TEAM_HEADER = `# TEAM

People botty tracks. Weight \`CRITICAL\` or \`HIGH\` puts a person in **Tier 1** (their messages
go through full task extraction); everyone else is Tier 2 (interactions logged only).

Format — one bullet per person under \`## People\`:

\`- **Name** — weight: CRITICAL|HIGH|NORMAL | slack: @handle | email: x@y | cadence: daily|weekly|... | notes: free text\`

## People
`;

const TEAM_EMPTY_COMMENT = `<!--
  No one added yet. Add the teammates you actually work with using the bullet
  format shown above (a new top-level "- **Name** — weight: ..." line under
  this heading, outside this comment block). Until you do, botty has zero Tier-1
  contacts: nobody's messages get full task extraction, everything is just logged.
-->`;

export function renderTeam(answers: TeamAnswers): string {
  const lines: string[] = [TEAM_HEADER];
  if (answers.people.length === 0) {
    lines.push(TEAM_EMPTY_COMMENT);
  } else {
    for (const p of answers.people) {
      const name = sanitizeInlineField(p.name).replace(/\*\*/g, '');
      const fields: string[] = [`weight: ${p.weight}`];
      const slack = p.slackHandle && sanitizeInlineField(p.slackHandle);
      if (slack) fields.push(`slack: ${slack.startsWith('@') ? slack : `@${slack}`}`);
      if (p.email?.trim()) fields.push(`email: ${sanitizeInlineField(p.email)}`);
      if (p.cadence?.trim()) fields.push(`cadence: ${sanitizeInlineField(p.cadence)}`);
      if (p.notes?.trim()) fields.push(`notes: ${sanitizeInlineField(p.notes)}`);
      lines.push(`- **${name}** — ${fields.join(' | ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------- persona.md ----------

/** Template defaults for guided composition when a field is left blank. */
const PERSONA_VOICE_DEFAULT = `- Direct, warm but terse. Answer first, context after — never bury the lede.
- Short paragraphs, tight bullets. No walls of text.
- Never invent facts about people, tasks, or messages. If memory doesn't have it, say so.
- When referencing a tracked task or person, use their exact name/description from memory.`;

const PERSONA_BANNED_DEFAULT = `- Filler openers: "Great question", "Sure!", "I hope this helps", "As an AI".
- Emojis, exclamation-point enthusiasm, corporate cheerfulness.
- Restating the user's question back at them.
- Apologizing more than once for the same thing.`;

export function renderPersona(answers: PersonaAnswers): string {
  if (answers.kind === 'raw') {
    return answers.content.endsWith('\n') ? answers.content : `${answers.content}\n`;
  }
  if (answers.kind === 'sections') {
    const about = answers.aboutHeading?.trim() || 'About';
    const parts = [
      '# PERSONA',
      '## Identity',
      escapeSectionBody(answers.identity.trim()),
      `## ${about.replace(/^#+\s*/, '')}`,
      escapeSectionBody(answers.about.trim()),
      '## Voice & tone',
      escapeSectionBody(answers.voice.trim()),
      '## Banned',
      escapeSectionBody(answers.banned.trim()),
    ];
    return `${parts.filter((p) => p !== '').join('\n\n')}\n`;
  }
  // kind === 'fields': guided composition into the template's section structure.
  const name = sanitizeInlineField(answers.name) || 'the user';
  const role = answers.role.trim();
  const addressAs = answers.addressAs.trim();
  const timezone = answers.timezone.trim();
  const identity =
    `You are **botty**, the personal proactive assistant of **${name}**` +
    `${role ? `, ${escapeSectionBody(role)}` : ''}. You run locally on their machine, watch their\n` +
    'work signals (Slack, email, calendar, Jira, GitHub), remember people and commitments across\n' +
    'sessions, and surface the right thing at the right moment — without nagging.';
  const aboutLines = [
    role ? `- ${escapeSectionBody(role)}.` : null,
    // Explicit, clearly-labeled timezone line — prose only in v1 (schedule times
    // stay host-local); it exists so the LLM stops guessing.
    timezone ? `- Timezone: ${escapeSectionBody(timezone)}.` : null,
    addressAs ? `- Address them as: ${escapeSectionBody(addressAs)}.` : null,
  ].filter((l): l is string => l !== null);
  const parts = [
    '# PERSONA',
    '## Identity',
    identity,
    `## About ${name}`,
    aboutLines.length > 0 ? aboutLines.join('\n') : '(nothing noted yet)',
    '## Voice & tone',
    answers.tone.trim() ? escapeSectionBody(answers.tone.trim()) : PERSONA_VOICE_DEFAULT,
    '## Banned',
    answers.banned.trim() ? escapeSectionBody(answers.banned.trim()) : PERSONA_BANNED_DEFAULT,
  ];
  return `${parts.join('\n\n')}\n`;
}

// ---------- heartbeat.md ----------

// The template's explanatory comment blocks are part of the canonical render
// (docs/specs/onboarding.md §rendering rules). Custom comments a user hand-added
// are lost on a wizard re-run — stated v1 trade-off; archive is the recovery path.
const HB_INTRO = `Controls the proactive loop. Every value is optional — anything missing falls back to the
built-in default (shown here). Lines are \`key: value\`.`;

const HB_SCHEDULE_COMMENT = `<!-- working_hours is the HARD on/off switch: outside this window (or on days not in
active_days) botty does absolutely nothing — no source polls, no ticks, no briefings, no LLM
calls (zero token usage). quiet_hours is the softer gate: inside working hours it only stops
notifications from surfacing. Manual actions (run-now, check-now) always bypass the gate. -->`;

const HB_BEHAVIOR_COMMENT_1 = `<!-- surface_cooldown_hours is per-task re-nudge spacing for the 1st / 2nd / 3rd+ surface.
response_window_hours — how long an unanswered nudge stays open before it expires.
chat_active_gate_min — no nudges while you chatted with botty this recently.
session_idle_seal_min — chat inactivity before the session is summarized and sealed.
due_soon_days / never_surfaced_min_age_hours / stale_after_days tune which open tasks
become tick candidates (due within N days / created N+ hours ago and never surfaced /
untouched for N+ days). infer_commitments turns on a hidden post-chat-turn pass that notices
short-lived follow-ups you mention in passing ("my interview is tomorrow at 3") and reminds you
when they're due — not a task, not memory. commitment_min_age_min stops one from echoing right
back at you moments after you mention it; commitments_max_per_day caps how many can notify in a
rolling 24h window (extras just wait for the next tick). -->`;

const HB_BEHAVIOR_COMMENT_2 = `<!-- auto_resolve_tasks: the resolution sweep reads each open slack/gmail task's thread and
auto-closes tasks already handled there (you replied "done", the requester said "ya está", …).
Only threads with NEW messages trigger an LLM check (max max_resolution_checks_per_sweep per
sweep, one per task per resolution_check_cooldown_min, closing only at or above
resolution_confidence_min); every auto-close shows a chat card with a reopen button. -->`;

const HB_SOURCES_COMMENT = `<!-- Optional per-source poll interval, e.g. \`slack: on, every 10m\`. Defaults come from mode
(sim: 1m each; real: slack 10m, gmail 30m, gcal 60m, jira 120m, github 120m). -->`;

const HB_TASKS_COMMENT = `<!-- Optional recurring checklist items, one bullet per item, evaluated on the tick:
\`- every 4h: check whether the CI dashboard has red builds I should mention\`
\`- every 1d: remind me to review my inbox zero state\`
Intervals take m/h/d. A due item is offered to the judgment layer, which surfaces it as a
plain notification (or stays silent); items never create tasks. Nothing here means no cost. -->`;

function onOff(v: boolean): string {
  return v ? 'on' : 'off';
}

function decomposeInterval(intervalMin: number): { every: number; unit: 'm' | 'h' | 'd' } {
  if (intervalMin % 1440 === 0) return { every: intervalMin / 1440, unit: 'd' };
  if (intervalMin % 60 === 0) return { every: intervalMin / 60, unit: 'h' };
  return { every: intervalMin, unit: 'm' };
}

/**
 * Render heartbeat.md from the wizard answers, layered over the currently-served
 * config: any knob the wizard doesn't ask about (or the user didn't confirm) is
 * carried through from `base` — a wizard run must never reset a hand-tuned
 * resolution_confidence_min to default. `base` should be the parse of the current
 * file (defaults-filled when the file is fresh).
 */
export function renderHeartbeat(
  answers: Pick<OnboardingAnswers, 'schedule' | 'sources' | 'directives'>,
  base: HeartbeatConfig,
  mode: 'sim' | 'real',
): string {
  const sched: ScheduleAnswers = answers.schedule ?? {
    workingHours: base.workingHours,
    quietHours: base.quietHours,
    activeDays: base.activeDays,
    tickIntervalMin: base.tickIntervalMin,
    morningBriefAt: base.morningBriefAt,
    eveningBriefAt: base.eveningBriefAt,
  };
  const adv = answers.directives?.advanced;
  const b = {
    surfacingThreshold: adv?.surfacingThreshold ?? base.surfacingThreshold,
    maxProactivePerHour: adv?.maxProactivePerHour ?? base.maxProactivePerHour,
    minGapBetweenNudgesMin: adv?.minGapBetweenNudgesMin ?? base.minGapBetweenNudgesMin,
    autoResolveTasks: adv?.autoResolveTasks ?? base.autoResolveTasks,
    inferCommitments: adv?.inferCommitments ?? base.inferCommitments,
    commitmentsMaxPerDay: adv?.commitmentsMaxPerDay ?? base.commitmentsMaxPerDay,
  };

  const modeDefaults = mode === 'sim' ? SOURCE_INTERVALS_SIM : SOURCE_INTERVALS_REAL;
  const sourceLines = SOURCES.map((s) => {
    const fromAnswers = answers.sources?.[s];
    const enabled = fromAnswers?.enabled ?? base.sources[s].enabled;
    // Emit an explicit interval only when it differs from the mode default —
    // an omitted override keeps tracking the default if it ever changes.
    const intervalMin = fromAnswers
      ? fromAnswers.intervalMin
      : base.sources[s].intervalMin !== modeDefaults[s]
        ? base.sources[s].intervalMin
        : undefined;
    const every = intervalMin !== undefined && intervalMin !== modeDefaults[s] ? `, every ${intervalMin}m` : '';
    return `${s}: ${onOff(enabled)}${every}`;
  });

  const checklist: DirectivesAnswers['checklist'] = answers.directives
    ? answers.directives.checklist
    : base.checklistTasks.map((t) => ({ ...decomposeInterval(t.intervalMin), text: t.prompt }));
  const checklistLines = checklist.map(
    (item) => `- every ${item.every}${item.unit}: ${sanitizeInlineField(item.text)}`,
  );

  const instructions = (answers.directives ? answers.directives.instructions : base.instructions).trim();
  const thisWeekRaw = (answers.directives ? answers.directives.thisWeek : base.thisWeek).trim();
  const thisWeek = thisWeekRaw || '(nothing noted)';

  const activeDays = [...new Set(sched.activeDays)].sort((a, z) => a - z);
  const scheduleBody = [
    `tick_interval_min: ${sched.tickIntervalMin}`,
    `working_hours: ${sched.workingHours.start}-${sched.workingHours.end}`,
    `quiet_hours: ${sched.quietHours.start}-${sched.quietHours.end}`,
    // An empty selection can't be expressed in the file format (the parser
    // treats it as invalid) — omit the line so the default applies.
    ...(activeDays.length > 0 ? [`active_days: ${activeDays.map((d) => DAY_SHORT[d]).join(',')}`] : []),
    `morning_brief_at: ${sched.morningBriefAt}`,
    `evening_brief_at: ${sched.eveningBriefAt}`,
  ].join('\n');

  const behaviorBody = [
    `surfacing_threshold: ${b.surfacingThreshold}`,
    `max_surfaces_per_task: ${base.maxSurfacesPerTask}`,
    `max_proactive_per_hour: ${b.maxProactivePerHour}`,
    `min_gap_between_nudges_min: ${b.minGapBetweenNudgesMin}`,
    `max_snoozes_per_tick: ${base.maxSnoozesPerTick}`,
    `surface_cooldown_hours: ${base.surfaceCooldownHours[1] ?? HEARTBEAT_DEFAULTS.surfaceCooldownHours[1]}/${base.surfaceCooldownHours[2] ?? HEARTBEAT_DEFAULTS.surfaceCooldownHours[2]}/${base.surfaceCooldownHours[3] ?? HEARTBEAT_DEFAULTS.surfaceCooldownHours[3]}`,
    `response_window_hours: ${base.responseWindowHours}`,
    `chat_active_gate_min: ${base.chatActiveGateMin}`,
    `session_idle_seal_min: ${base.sessionIdleSealMin}`,
    `meeting_prep_lead_min: ${base.meetingPrepLeadMin}`,
    `due_soon_days: ${base.dueSoonDays}`,
    `never_surfaced_min_age_hours: ${base.neverSurfacedMinAgeHours}`,
    `stale_after_days: ${base.staleAfterDays}`,
    `auto_resolve_tasks: ${onOff(b.autoResolveTasks)}`,
    `resolution_sweep_interval_min: ${base.resolutionSweepIntervalMin}`,
    `max_resolution_checks_per_sweep: ${base.maxResolutionChecksPerSweep}`,
    `resolution_check_cooldown_min: ${base.resolutionCheckCooldownMin}`,
    `resolution_confidence_min: ${base.resolutionConfidenceMin}`,
    `infer_commitments: ${onOff(b.inferCommitments)}`,
    `commitment_min_age_min: ${base.commitmentMinAgeMin}`,
    `commitments_max_per_day: ${b.commitmentsMaxPerDay}`,
  ].join('\n');

  const parts = [
    '# HEARTBEAT',
    HB_INTRO,
    '## Schedule',
    scheduleBody,
    HB_SCHEDULE_COMMENT,
    '## Behavior',
    behaviorBody,
    HB_BEHAVIOR_COMMENT_1,
    HB_BEHAVIOR_COMMENT_2,
    '## Sources',
    sourceLines.join('\n'),
    HB_SOURCES_COMMENT,
    '## Tasks',
    ...(checklistLines.length > 0 ? [checklistLines.join('\n')] : []),
    HB_TASKS_COMMENT,
    '## Instructions',
    ...(instructions ? [escapeSectionBody(instructions)] : []),
    '## This week',
    escapeSectionBody(thisWeek),
  ];
  return `${parts.join('\n\n')}\n`;
}

// ---------- mcp.json ----------

export function renderMcp(answers: McpAnswers): string {
  const servers: Record<string, unknown> = {};
  for (const [key, s] of Object.entries(answers.servers)) {
    servers[key] = {
      type: 'stdio',
      command: s.command,
      ...(s.args.length > 0 ? { args: s.args } : {}),
      ...(Object.keys(s.env).length > 0 ? { env: s.env } : {}),
      ...(Object.keys(s.tools).length > 0 ? { tools: s.tools } : {}),
    };
  }
  return `${JSON.stringify({ servers }, null, 2)}\n`;
}

// ---------- prefill: current config → answers ----------

const PERSONA_KNOWN_HEADINGS = ['identity', 'voice & tone', 'banned'];

/** Split persona.md into the template's sections, or degrade to raw. */
export function personaAnswersFromRaw(raw: string): { answers: PersonaAnswers; warnings: string[] } {
  const warnings: string[] = [];
  const lines = raw.split('\n');
  const headings = lines
    .map((l) => l.trim())
    .filter((l) => /^##\s/.test(l))
    .map((l) => l.replace(/^##\s+/, '').trim());
  const known = (h: string) => {
    const lower = h.toLowerCase();
    return PERSONA_KNOWN_HEADINGS.includes(lower) || lower.startsWith('about');
  };
  const aboutHeading = headings.find((h) => h.toLowerCase().startsWith('about'));
  const matched = headings.filter(known);
  if (matched.length === 0) {
    warnings.push(
      'persona.md no longer matches the template section headings — editing as a single file',
    );
    return { answers: { kind: 'raw', content: raw }, warnings };
  }
  const unknown = headings.filter((h) => !known(h));
  if (unknown.length > 0) {
    warnings.push(
      `persona.md has sections the wizard doesn't know (${unknown.join(', ')}) — editing as a single file so nothing is lost`,
    );
    return { answers: { kind: 'raw', content: raw }, warnings };
  }
  const section = (heading: string): string => {
    const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
    if (start === -1) return '';
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^##?\s/.test(l.trim()));
    return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  };
  return {
    answers: {
      kind: 'sections',
      identity: section('Identity'),
      about: aboutHeading ? section(aboutHeading) : '',
      ...(aboutHeading ? { aboutHeading } : {}),
      voice: section('Voice & tone'),
      banned: section('Banned'),
    },
    warnings,
  };
}

/**
 * Parse the current config back into a prefill answers object. Warnings list the
 * parts that couldn't round-trip (degraded persona, parser warnings — content the
 * parser skipped would be lost on a re-render that touches that file).
 */
export function answersFromConfig(input: {
  personaRaw: string;
  team: { people: TeamMember[]; warnings: string[] };
  heartbeat: HeartbeatConfig;
  mcp: McpConfig;
  mode: 'sim' | 'real';
  /** The llm.models setting, when set. */
  models?: Record<string, string>;
}): { answers: OnboardingAnswers; warnings: string[] } {
  const warnings: string[] = [];

  const persona = personaAnswersFromRaw(input.personaRaw);
  warnings.push(...persona.warnings);

  const team: TeamAnswers = {
    people: input.team.people.map((p) => ({
      name: p.name,
      weight: p.weight,
      ...(p.slackHandle !== null ? { slackHandle: p.slackHandle } : {}),
      ...(p.email !== null ? { email: p.email } : {}),
      ...(p.cadence !== null ? { cadence: p.cadence } : {}),
      ...(p.notes !== null ? { notes: p.notes } : {}),
    })),
  };
  warnings.push(...input.team.warnings.filter((w) => w !== 'TEAM.md defines no people').map((w) => `team.md: ${w}`));

  const hb = input.heartbeat;
  const modeDefaults = input.mode === 'sim' ? SOURCE_INTERVALS_SIM : SOURCE_INTERVALS_REAL;
  const sources = Object.fromEntries(
    SOURCES.map((s) => [
      s,
      {
        enabled: hb.sources[s].enabled,
        ...(hb.sources[s].intervalMin !== modeDefaults[s] ? { intervalMin: hb.sources[s].intervalMin } : {}),
      },
    ]),
  ) as SourcesAnswers;

  const schedule: ScheduleAnswers = {
    workingHours: { ...hb.workingHours },
    quietHours: { ...hb.quietHours },
    activeDays: [...hb.activeDays],
    tickIntervalMin: hb.tickIntervalMin,
    morningBriefAt: hb.morningBriefAt,
    eveningBriefAt: hb.eveningBriefAt,
  };

  const directives: DirectivesAnswers = {
    instructions: hb.instructions,
    thisWeek: hb.thisWeek === '(nothing noted)' ? '' : hb.thisWeek,
    checklist: hb.checklistTasks.map((t) => ({ ...decomposeInterval(t.intervalMin), text: t.prompt })),
    advanced: {
      surfacingThreshold: hb.surfacingThreshold,
      maxProactivePerHour: hb.maxProactivePerHour,
      minGapBetweenNudgesMin: hb.minGapBetweenNudgesMin,
      autoResolveTasks: hb.autoResolveTasks,
      inferCommitments: hb.inferCommitments,
      commitmentsMaxPerDay: hb.commitmentsMaxPerDay,
      ...(input.models ? { models: input.models } : {}),
    },
  };
  warnings.push(...hb.warnings.map((w) => `heartbeat.md: ${w}`));

  const mcp: McpAnswers = {
    servers: Object.fromEntries(
      Object.entries(input.mcp.servers).map(([key, s]) => [
        key,
        { type: 'stdio' as const, command: s.command, args: s.args, env: s.env, tools: s.tools },
      ]),
    ),
  };

  return {
    answers: { persona: persona.answers, team, sources, mcp, schedule, directives },
    warnings,
  };
}
