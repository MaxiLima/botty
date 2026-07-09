import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEARTBEAT_DEFAULTS } from '@botty/shared';
import { checklistTaskId, parseHeartbeat } from '../../src/config/parse.js';
import { templatesDir } from '../../src/env.js';

/** Promoted knobs (2026-07-09 investigation): every former HEARTBEAT_DEFAULTS-only
 * value is now readable from '## Behavior', with per-field warning-on-invalid. */

const behavior = (...lines: string[]) => ['## Behavior', ...lines].join('\n');

describe('parseHeartbeat — promoted behavior knobs', () => {
  const numericKnobs: {
    key: string;
    value: string;
    field: keyof ReturnType<typeof parseHeartbeat>;
    expected: number;
  }[] = [
    { key: 'max_snoozes_per_tick', value: '3', field: 'maxSnoozesPerTick', expected: 3 },
    { key: 'response_window_hours', value: '12', field: 'responseWindowHours', expected: 12 },
    { key: 'chat_active_gate_min', value: '5', field: 'chatActiveGateMin', expected: 5 },
    { key: 'session_idle_seal_min', value: '45', field: 'sessionIdleSealMin', expected: 45 },
    { key: 'meeting_prep_lead_min', value: '90', field: 'meetingPrepLeadMin', expected: 90 },
    { key: 'due_soon_days', value: '4', field: 'dueSoonDays', expected: 4 },
    { key: 'never_surfaced_min_age_hours', value: '1', field: 'neverSurfacedMinAgeHours', expected: 1 },
    { key: 'stale_after_days', value: '9', field: 'staleAfterDays', expected: 9 },
    { key: 'max_resolution_checks_per_sweep', value: '2', field: 'maxResolutionChecksPerSweep', expected: 2 },
    { key: 'resolution_check_cooldown_min', value: '20', field: 'resolutionCheckCooldownMin', expected: 20 },
    { key: 'commitment_min_age_min', value: '45', field: 'commitmentMinAgeMin', expected: 45 },
    { key: 'commitments_max_per_day', value: '5', field: 'commitmentsMaxPerDay', expected: 5 },
  ];

  it.each(numericKnobs)('parses $key', ({ key, value, field, expected }) => {
    const cfg = parseHeartbeat(behavior(`${key}: ${value}`), 'sim');
    expect(cfg[field]).toBe(expected);
    expect(cfg.warnings).toEqual([]);
  });

  it.each(numericKnobs)('$key: junk value warns and keeps the default', ({ key, field }) => {
    const cfg = parseHeartbeat(behavior(`${key}: banana`), 'sim');
    expect(cfg[field]).toBe(HEARTBEAT_DEFAULTS[field as keyof typeof HEARTBEAT_DEFAULTS]);
    expect(cfg.warnings.some((w) => w.includes(key))).toBe(true);
  });

  it('defaults every new knob from HEARTBEAT_DEFAULTS on an empty file', () => {
    const cfg = parseHeartbeat('', 'sim');
    expect(cfg.maxSnoozesPerTick).toBe(HEARTBEAT_DEFAULTS.maxSnoozesPerTick);
    expect(cfg.responseWindowHours).toBe(HEARTBEAT_DEFAULTS.responseWindowHours);
    expect(cfg.chatActiveGateMin).toBe(HEARTBEAT_DEFAULTS.chatActiveGateMin);
    expect(cfg.sessionIdleSealMin).toBe(HEARTBEAT_DEFAULTS.sessionIdleSealMin);
    expect(cfg.surfaceCooldownHours).toEqual(HEARTBEAT_DEFAULTS.surfaceCooldownHours);
    expect(cfg.meetingPrepLeadMin).toBe(HEARTBEAT_DEFAULTS.meetingPrepLeadMin);
    expect(cfg.dueSoonDays).toBe(HEARTBEAT_DEFAULTS.dueSoonDays);
    expect(cfg.neverSurfacedMinAgeHours).toBe(HEARTBEAT_DEFAULTS.neverSurfacedMinAgeHours);
    expect(cfg.staleAfterDays).toBe(HEARTBEAT_DEFAULTS.staleAfterDays);
    expect(cfg.maxResolutionChecksPerSweep).toBe(HEARTBEAT_DEFAULTS.maxResolutionChecksPerSweep);
    expect(cfg.resolutionCheckCooldownMin).toBe(HEARTBEAT_DEFAULTS.resolutionCheckCooldownMin);
    expect(cfg.resolutionConfidenceMin).toBe(HEARTBEAT_DEFAULTS.resolutionConfidenceMin);
    expect(cfg.inferCommitments).toBe(HEARTBEAT_DEFAULTS.inferCommitments);
    expect(cfg.commitmentMinAgeMin).toBe(HEARTBEAT_DEFAULTS.commitmentMinAgeMin);
    expect(cfg.commitmentsMaxPerDay).toBe(HEARTBEAT_DEFAULTS.commitmentsMaxPerDay);
    expect(cfg.checklistTasks).toEqual([]);
    expect(cfg.warnings).toEqual([]);
  });

  it('parses infer_commitments on/off and warns on unclear values', () => {
    expect(parseHeartbeat(behavior('infer_commitments: off'), 'sim').inferCommitments).toBe(false);
    expect(parseHeartbeat(behavior('infer_commitments: on'), 'sim').inferCommitments).toBe(true);
    const cfg = parseHeartbeat(behavior('infer_commitments: maybe'), 'sim');
    expect(cfg.inferCommitments).toBe(HEARTBEAT_DEFAULTS.inferCommitments);
    expect(cfg.warnings.some((w) => w.includes('infer_commitments'))).toBe(true);
  });

  it('parses surface_cooldown_hours as 1st/2nd/3rd+ hour triple', () => {
    const cfg = parseHeartbeat(behavior('surface_cooldown_hours: 24/48/72'), 'sim');
    expect(cfg.surfaceCooldownHours).toEqual({ 1: 24, 2: 48, 3: 72 });
    expect(cfg.warnings).toEqual([]);
  });

  it('surface_cooldown_hours: malformed value warns and keeps the default', () => {
    for (const bad of ['24-48-72', '24/48', 'fast']) {
      const cfg = parseHeartbeat(behavior(`surface_cooldown_hours: ${bad}`), 'sim');
      expect(cfg.surfaceCooldownHours).toEqual(HEARTBEAT_DEFAULTS.surfaceCooldownHours);
      expect(cfg.warnings.some((w) => w.includes('surface_cooldown_hours'))).toBe(true);
    }
  });

  it('parses resolution_confidence_min in 0-1 and rejects out-of-range', () => {
    expect(parseHeartbeat(behavior('resolution_confidence_min: 0.6'), 'sim').resolutionConfidenceMin).toBe(0.6);
    for (const bad of ['1.5', '-0.1', 'high']) {
      const cfg = parseHeartbeat(behavior(`resolution_confidence_min: ${bad}`), 'sim');
      expect(cfg.resolutionConfidenceMin).toBe(HEARTBEAT_DEFAULTS.resolutionConfidenceMin);
      expect(cfg.warnings.some((w) => w.includes('resolution_confidence_min'))).toBe(true);
    }
  });

  it('the shipped heartbeat.md template parses without warnings (both modes)', () => {
    const md = fs.readFileSync(path.join(templatesDir, 'heartbeat.md'), 'utf8');
    expect(parseHeartbeat(md, 'sim').warnings).toEqual([]);
    expect(parseHeartbeat(md, 'real').warnings).toEqual([]);
  });
});

describe("parseHeartbeat — '## Tasks' checklist section", () => {
  it('parses bullets with m/h/d intervals into stable-id checklist tasks', () => {
    const md = [
      '## Tasks',
      '- every 4h: check whether the CI dashboard has red builds',
      '- every 1d: remind me to review my inbox zero state',
      '- every 30m: glance at the pager',
    ].join('\n');
    const cfg = parseHeartbeat(md, 'sim');
    expect(cfg.warnings).toEqual([]);
    expect(cfg.checklistTasks).toHaveLength(3);
    expect(cfg.checklistTasks.map((t) => t.intervalMin)).toEqual([240, 1440, 30]);
    expect(cfg.checklistTasks[0]).toMatchObject({
      id: checklistTaskId('check whether the CI dashboard has red builds'),
      prompt: 'check whether the CI dashboard has red builds',
    });
    // ids are content-derived: re-parsing (or reordering) keeps them stable
    const again = parseHeartbeat(md, 'sim');
    expect(again.checklistTasks.map((t) => t.id)).toEqual(cfg.checklistTasks.map((t) => t.id));
  });

  it('warns on unparseable bullets and keeps the rest', () => {
    const md = ['## Tasks', '- whenever: bogus item', '- every 2h: real item'].join('\n');
    const cfg = parseHeartbeat(md, 'sim');
    expect(cfg.checklistTasks).toHaveLength(1);
    expect(cfg.checklistTasks[0]!.prompt).toBe('real item');
    expect(cfg.warnings.some((w) => w.includes('Unparseable checklist task'))).toBe(true);
  });

  it('warns on zero intervals and duplicate prompts; ignores prose/comments', () => {
    const md = [
      '## Tasks',
      '',
      '<!-- explanatory comment',
      '`- every 4h: an example inside a comment`',
      'more prose -->',
      '- every 0h: never runs',
      '- every 6h: same thing',
      '- every 12h: same thing',
    ].join('\n');
    const cfg = parseHeartbeat(md, 'sim');
    expect(cfg.checklistTasks).toHaveLength(1);
    expect(cfg.checklistTasks[0]!.intervalMin).toBe(360);
    expect(cfg.warnings.some((w) => w.includes('positive'))).toBe(true);
    expect(cfg.warnings.some((w) => w.includes('Duplicate checklist task'))).toBe(true);
  });

  it('a file without the section has no checklist tasks and no warnings', () => {
    const cfg = parseHeartbeat('## Behavior\nsurfacing_threshold: 7\n', 'sim');
    expect(cfg.checklistTasks).toEqual([]);
    expect(cfg.warnings).toEqual([]);
  });
});
