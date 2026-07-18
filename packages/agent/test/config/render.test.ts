import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEARTBEAT_DEFAULTS } from '@botty/shared';
import type { OnboardingAnswers, ScheduleAnswers, TeamAnswers } from '@botty/shared';
import { parseHeartbeat, parseTeam } from '../../src/config/parse.js';
import { parseMcpConfig } from '../../src/config/mcp.js';
import {
  answersFromConfig,
  personaAnswersFromRaw,
  renderHeartbeat,
  renderMcp,
  renderPersona,
  renderTeam,
} from '../../src/config/render.js';
import { templatesDir } from '../../src/env.js';

const template = (name: string): string => fs.readFileSync(path.join(templatesDir, name), 'utf8');

const BASE = parseHeartbeat('', 'sim'); // pure defaults

describe('renderTeam ⇄ parseTeam round-trip', () => {
  const answers: TeamAnswers = {
    people: [
      { name: 'Marian', weight: 'CRITICAL', slackHandle: '@marian', email: 'marian@acme.example', cadence: 'daily', notes: 'Manager. Top priority.' },
      { name: 'Diego', weight: 'HIGH', slackHandle: 'diego' }, // no leading @, sparse fields
      { name: 'Nadia', weight: 'NORMAL', notes: 'Peer' },
    ],
  };

  it('round-trips every person losslessly', () => {
    const { people, warnings } = parseTeam(renderTeam(answers));
    expect(warnings).toEqual([]);
    expect(people).toEqual([
      { name: 'Marian', weight: 'CRITICAL', slackHandle: '@marian', email: 'marian@acme.example', cadence: 'daily', notes: 'Manager. Top priority.' },
      { name: 'Diego', weight: 'HIGH', slackHandle: '@diego', email: null, cadence: null, notes: null },
      { name: 'Nadia', weight: 'NORMAL', slackHandle: null, email: null, cadence: null, notes: 'Peer' },
    ]);
  });

  it('rendering the parsed template reproduces its semantic content', () => {
    const parsed = parseTeam(template('team.md'));
    const { answers: prefill } = answersFromConfig({
      personaRaw: template('persona.md'),
      team: parsed,
      heartbeat: BASE,
      mcp: { servers: {} },
      mode: 'sim',
    });
    const reparsed = parseTeam(renderTeam(prefill.team!));
    expect(reparsed.people).toEqual(parsed.people);
  });

  it('empty roster renders a valid file (only the no-people warning)', () => {
    const { people, warnings } = parseTeam(renderTeam({ people: [] }));
    expect(people).toEqual([]);
    expect(warnings).toEqual(['TEAM.md defines no people']);
  });

  it('sanitizes field separators and newlines out of values', () => {
    const { people } = parseTeam(
      renderTeam({ people: [{ name: 'X', weight: 'HIGH', notes: 'a | b\nc' }] }),
    );
    expect(people[0]!.notes).toBe('a / b c');
  });
});

describe('renderHeartbeat ⇄ parseHeartbeat round-trip', () => {
  const schedule: ScheduleAnswers = {
    workingHours: { start: '09:00', end: '18:00' },
    quietHours: { start: '21:00', end: '07:30' },
    activeDays: [1, 2, 3, 4],
    tickIntervalMin: 15,
    morningBriefAt: '09:15',
    eveningBriefAt: '17:45',
  };

  it('round-trips schedule, sources, and directives answers', () => {
    const answers: OnboardingAnswers = {
      schedule,
      sources: {
        slack: { enabled: true, intervalMin: 5 },
        gmail: { enabled: false },
        gcal: { enabled: true },
        jira: { enabled: false, intervalMin: 240 },
        github: { enabled: true },
      },
      directives: {
        instructions: 'Only interrupt for urgent things.',
        thisWeek: 'Ship the Q3 plan.',
        checklist: [
          { every: 4, unit: 'h', text: 'check CI dashboards' },
          { every: 1, unit: 'd', text: 'review inbox zero' },
          { every: 30, unit: 'm', text: 'watch the deploy queue' },
        ],
        advanced: { surfacingThreshold: 8, maxProactivePerHour: 1, autoResolveTasks: false },
      },
    };
    const md = renderHeartbeat(answers, BASE, 'sim');
    const cfg = parseHeartbeat(md, 'sim');
    expect(cfg.warnings).toEqual([]);
    expect(cfg.workingHours).toEqual({ start: '09:00', end: '18:00' });
    expect(cfg.quietHours).toEqual({ start: '21:00', end: '07:30' });
    expect(cfg.activeDays).toEqual([1, 2, 3, 4]);
    expect(cfg.tickIntervalMin).toBe(15);
    expect(cfg.morningBriefAt).toBe('09:15');
    expect(cfg.eveningBriefAt).toBe('17:45');
    expect(cfg.sources.slack).toEqual({ enabled: true, intervalMin: 5 });
    expect(cfg.sources.gmail.enabled).toBe(false);
    expect(cfg.sources.jira).toEqual({ enabled: false, intervalMin: 240 });
    expect(cfg.instructions).toBe('Only interrupt for urgent things.');
    expect(cfg.thisWeek).toBe('Ship the Q3 plan.');
    expect(cfg.checklistTasks.map((t) => t.intervalMin)).toEqual([240, 1440, 30]);
    expect(cfg.checklistTasks.map((t) => t.prompt)).toEqual([
      'check CI dashboards',
      'review inbox zero',
      'watch the deploy queue',
    ]);
    expect(cfg.surfacingThreshold).toBe(8);
    expect(cfg.maxProactivePerHour).toBe(1);
    expect(cfg.autoResolveTasks).toBe(false);
  });

  it('carries through hand-tuned non-curated knobs verbatim', () => {
    const handTuned = parseHeartbeat(
      '## Behavior\nresolution_confidence_min: 0.95\nstale_after_days: 9\n',
      'sim',
    );
    const md = renderHeartbeat({ schedule }, handTuned, 'sim');
    const cfg = parseHeartbeat(md, 'sim');
    expect(cfg.resolutionConfidenceMin).toBe(0.95);
    expect(cfg.staleAfterDays).toBe(9);
    // and the schedule answers landed
    expect(cfg.tickIntervalMin).toBe(15);
  });

  it('rendering the parsed template reproduces its semantic content', () => {
    const parsed = parseHeartbeat(template('heartbeat.md'), 'sim');
    expect(parsed.warnings).toEqual([]);
    const rerendered = parseHeartbeat(renderHeartbeat({}, parsed, 'sim'), 'sim');
    expect(rerendered.warnings).toEqual([]);
    const strip = ({ warnings: _a, ...rest }: typeof parsed) => rest;
    expect(strip(rerendered)).toEqual(strip(parsed));
  });

  it('never emits something its own parser warns on, even with heading-shaped free text', () => {
    const md = renderHeartbeat(
      {
        directives: {
          instructions: '## Sources\nslack: off\npretend this is a heading attack',
          thisWeek: '# not a title',
          checklist: [],
          advanced: {},
        },
      },
      BASE,
      'sim',
    );
    const cfg = parseHeartbeat(md, 'sim');
    expect(cfg.warnings).toEqual([]);
    // the '## Sources' inside instructions must not truncate the section or turn slack off
    expect(cfg.sources.slack.enabled).toBe(true);
    expect(cfg.instructions).toContain('heading attack');
  });

  it('omits an explicit interval when it matches the mode default', () => {
    const md = renderHeartbeat(
      { sources: { slack: { enabled: true, intervalMin: 1 }, gmail: { enabled: true }, gcal: { enabled: true }, jira: { enabled: true }, github: { enabled: true } } },
      BASE,
      'sim',
    );
    expect(md).not.toContain('every 1m');
    expect(parseHeartbeat(md, 'sim').sources.slack.intervalMin).toBe(1);
  });
});

describe('renderMcp ⇄ parseMcpConfig round-trip', () => {
  it('round-trips servers with zero warnings', () => {
    const answers = {
      servers: {
        slack: {
          type: 'stdio' as const,
          command: 'npx',
          args: ['-y', '@acme/slack-mcp'],
          env: { SLACK_BOT_TOKEN: 'xoxb-test' },
          tools: { list_channels: 'read' as const, send_message: 'action' as const },
        },
        bare: { type: 'stdio' as const, command: 'mcp-bare', args: [], env: {}, tools: {} },
      },
    };
    const { config, warnings } = parseMcpConfig(renderMcp(answers));
    expect(warnings).toEqual([]);
    expect(config.servers.slack).toEqual(answers.servers.slack);
    expect(config.servers.bare).toEqual(answers.servers.bare);
  });
});

describe('personaAnswersFromRaw', () => {
  it('splits the sim template into sections, preserving the About heading', () => {
    const { answers, warnings } = personaAnswersFromRaw(template('persona.md'));
    expect(warnings).toEqual([]);
    if (answers.kind !== 'sections') throw new Error(`expected sections, got ${answers.kind}`);
    expect(answers.aboutHeading).toBe('About Maxo');
    expect(answers.identity).toContain('personal proactive assistant');
    expect(answers.about).toContain('Buenos Aires');
    // render → re-split is stable
    const again = personaAnswersFromRaw(renderPersona(answers));
    expect(again.answers).toEqual(answers);
  });

  it('handles the real-mode template (About-you variant)', () => {
    const { answers, warnings } = personaAnswersFromRaw(template('persona.real.md'));
    expect(warnings).toEqual([]);
    if (answers.kind !== 'sections') throw new Error(`expected sections, got ${answers.kind}`);
    expect(answers.aboutHeading).toBe('About you — fill this in');
    expect(answers.identity).toBe('');
  });

  it('degrades to raw when no template headings survive', () => {
    const raw = '# My weird persona\n\njust prose, no sections\n';
    const { answers, warnings } = personaAnswersFromRaw(raw);
    expect(answers).toEqual({ kind: 'raw', content: raw });
    expect(warnings).toHaveLength(1);
  });

  it('degrades to raw when unknown sections exist (nothing may be silently lost)', () => {
    const raw = '## Identity\n\nx\n\n## Secret extra section\n\nkeep me\n';
    const { answers, warnings } = personaAnswersFromRaw(raw);
    expect(answers.kind).toBe('raw');
    expect(warnings[0]).toContain('Secret extra section');
  });
});

describe('renderPersona (fields mode)', () => {
  it('assembles the template section structure with a labeled timezone line', () => {
    const md = renderPersona({
      kind: 'fields',
      name: 'Sam',
      role: 'Platform engineer at Initech',
      addressAs: 'Sam',
      timezone: 'Europe/Madrid (UTC+1)',
      tone: '',
      banned: '',
    });
    expect(md).toContain('## Identity');
    expect(md).toContain('## About Sam');
    expect(md).toContain('- Timezone: Europe/Madrid (UTC+1).');
    expect(md).toContain('## Voice & tone');
    expect(md).toContain('## Banned');
    // blank tone/banned fall back to the template defaults
    expect(md).toContain('never bury the lede');
    // and the result splits cleanly back into sections
    expect(personaAnswersFromRaw(md).answers.kind).toBe('sections');
  });
});

describe('answersFromConfig', () => {
  it('maps the sim templates to a full prefill with no warnings', () => {
    const { answers, warnings } = answersFromConfig({
      personaRaw: template('persona.md'),
      team: parseTeam(template('team.md')),
      heartbeat: parseHeartbeat(template('heartbeat.md'), 'sim'),
      mcp: parseMcpConfig(template('mcp.json')).config,
      mode: 'sim',
    });
    expect(warnings).toEqual([]);
    expect(answers.team!.people).toHaveLength(3);
    expect(answers.schedule!.workingHours).toEqual(HEARTBEAT_DEFAULTS.workingHours);
    expect(answers.sources!.slack).toEqual({ enabled: true }); // default interval → no override
    expect(answers.directives!.thisWeek).toBe(''); // '(nothing noted)' normalized away
    expect(answers.directives!.instructions).toContain('Bias hard toward silence');
    expect(answers.mcp).toEqual({ servers: {} });
  });

  it('flags parser-skipped content as prefill warnings', () => {
    const { warnings } = answersFromConfig({
      personaRaw: template('persona.md'),
      team: parseTeam('## People\n- ???\n'),
      heartbeat: parseHeartbeat('## Schedule\nworking_hours: whenever\n', 'sim'),
      mcp: { servers: {} },
      mode: 'sim',
    });
    expect(warnings.some((w) => w.startsWith('team.md:'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('heartbeat.md:'))).toBe(true);
  });
});
