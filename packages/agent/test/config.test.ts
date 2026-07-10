import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HEARTBEAT_DEFAULTS } from '@botty/shared';
import { parseHeartbeat, parseTeam } from '../src/config/parse.js';
import { loadEnv } from '../src/env.js';
import { Db } from '../src/db/index.js';
import { createBus } from '../src/bus/index.js';
import { createConfig } from '../src/config/index.js';

describe('parseTeam', () => {
  it('parses the canonical bullet format', () => {
    const md = [
      '# TEAM',
      '',
      '## People',
      '',
      '- **Marian** — weight: CRITICAL | slack: @marian | email: marian@acme.example | cadence: daily | notes: Manager.',
      '- **Sofi** — weight: CRITICAL | slack: @sofi | email: sofi@acme.example',
      '- **Diego** — weight: HIGH | slack: @diego | email: diego@acme.example | cadence: weekly',
    ].join('\n');
    const { people, warnings } = parseTeam(md);
    expect(warnings).toEqual([]);
    expect(people).toHaveLength(3);
    expect(people[0]).toMatchObject({
      name: 'Marian',
      weight: 'CRITICAL',
      slackHandle: '@marian',
      email: 'marian@acme.example',
      cadence: 'daily',
      notes: 'Manager.',
    });
    expect(people[2]!.weight).toBe('HIGH');
  });

  it('is robust: no bold, plain dash, missing fields, bad weight, slack without @', () => {
    const md = ['## People', '- Ana - weight: banana | slack: ana', '- **Solo**'].join('\n');
    const { people, warnings } = parseTeam(md);
    expect(people).toHaveLength(2);
    expect(people[0]).toMatchObject({ name: 'Ana', weight: 'NORMAL', slackHandle: '@ana' });
    expect(people[1]).toMatchObject({ name: 'Solo', weight: 'NORMAL', email: null });
    expect(warnings.some((w) => w.includes('banana'))).toBe(true);
  });

  it('warns on empty/missing People section', () => {
    expect(parseTeam('# nothing here').warnings.length).toBeGreaterThan(0);
    expect(parseTeam('## People\n\n(no bullets)').people).toEqual([]);
  });
});

describe('parseHeartbeat', () => {
  it('returns HEARTBEAT_DEFAULTS for an empty file', () => {
    const cfg = parseHeartbeat('', 'sim');
    expect(cfg.tickIntervalMin).toBe(HEARTBEAT_DEFAULTS.tickIntervalMin);
    expect(cfg.quietHours).toEqual(HEARTBEAT_DEFAULTS.quietHours);
    expect(cfg.activeDays).toEqual([...HEARTBEAT_DEFAULTS.activeDays]);
    expect(cfg.surfacingThreshold).toBe(7);
    expect(cfg.sources.slack).toEqual({ enabled: true, intervalMin: 1 }); // sim default
    expect(parseHeartbeat('', 'real').sources.slack.intervalMin).toBe(10);
  });

  it('parses overrides from all sections', () => {
    const md = [
      '## Schedule',
      'tick_interval_min: 5',
      'quiet_hours: 23:00-07:30',
      'active_days: mon-wed,sat',
      'morning_brief_at: 09:15',
      '',
      '## Behavior',
      'surfacing_threshold: 9',
      'max_proactive_per_hour: 1',
      'auto_resolve_tasks: off',
      'resolution_sweep_interval_min: 30',
      '',
      '## Sources',
      'slack: on, every 15m',
      'jira: off',
      '',
      '## Instructions',
      'Only bother me for CRITICAL people.',
      '',
      '## This week',
      'Perf review season.',
    ].join('\n');
    const cfg = parseHeartbeat(md, 'sim');
    expect(cfg.tickIntervalMin).toBe(5);
    expect(cfg.quietHours).toEqual({ start: '23:00', end: '07:30' });
    expect(cfg.activeDays).toEqual([1, 2, 3, 6]);
    expect(cfg.morningBriefAt).toBe('09:15');
    expect(cfg.eveningBriefAt).toBe(HEARTBEAT_DEFAULTS.eveningBriefAt);
    expect(cfg.surfacingThreshold).toBe(9);
    expect(cfg.maxProactivePerHour).toBe(1);
    expect(cfg.autoResolveTasks).toBe(false);
    expect(cfg.resolutionSweepIntervalMin).toBe(30);
    expect(parseHeartbeat('', 'sim').autoResolveTasks).toBe(true); // default on
    expect(cfg.sources.slack).toEqual({ enabled: true, intervalMin: 15 });
    expect(cfg.sources.jira.enabled).toBe(false);
    expect(cfg.sources.gmail.enabled).toBe(true);
    expect(cfg.instructions).toBe('Only bother me for CRITICAL people.');
    expect(cfg.thisWeek).toBe('Perf review season.');
    expect(cfg.warnings).toEqual([]);
  });

  it('collects warnings for junk values without throwing', () => {
    const md = ['## Schedule', 'tick_interval_min: soon', 'quiet_hours: night', '## Sources', 'myspace: on'].join('\n');
    const cfg = parseHeartbeat(md, 'sim');
    expect(cfg.tickIntervalMin).toBe(HEARTBEAT_DEFAULTS.tickIntervalMin);
    expect(cfg.warnings.length).toBe(3);
  });
});

describe('config manager (template seeding + materialize + save)', () => {
  function makeEnv(mode?: 'sim' | 'real') {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botty-test-'));
    return loadEnv({ dataDir, dbPath: path.join(dataDir, 'data', 'botty.db'), mode });
  }

  it('seeds templates and materializes sim-scenario people with correct tiers', () => {
    const env = makeEnv();
    const db = new Db(':memory:');
    const bus = createBus();
    const config = createConfig(env, db, bus);
    config.materializePeople();

    const people = db.listPeople();
    const byName = Object.fromEntries(people.map((p) => [p.name, p]));
    expect(byName['Marian']).toMatchObject({ weight: 'CRITICAL', tier: 1, slackHandle: '@marian', email: 'marian@acme.example' });
    expect(byName['Sofi']).toMatchObject({ weight: 'CRITICAL', tier: 1, slackHandle: '@sofi', email: 'sofi@acme.example' });
    expect(byName['Diego']).toMatchObject({ weight: 'HIGH', tier: 1, slackHandle: '@diego', email: 'diego@acme.example' });
    expect(config.persona()).toContain('botty');
    fs.rmSync(env.dataDir, { recursive: true, force: true });
  });

  it('rematerializing demotes people removed from TEAM.md and follows renames', () => {
    const env = makeEnv();
    const db = new Db(':memory:');
    const bus = createBus();
    const config = createConfig(env, db, bus);
    config.materializePeople(); // sim template: Marian, Sofi, Diego — all tier 1

    // Diego removed; Sofi renamed to Sofia (same slack/email).
    const next = [
      '## People',
      '- **Marian** — weight: CRITICAL | slack: @marian | email: marian@acme.example',
      '- **Sofia** — weight: CRITICAL | slack: @sofi | email: sofi@acme.example',
    ].join('\n');
    config.save('team', next);

    const diego = db.getPersonByName('Diego')!;
    expect(diego.tier).toBe(2);
    expect(diego.weight).toBe('NORMAL');
    // rename updated the existing row — no duplicate, tier kept
    const sofia = db.getPersonByName('Sofia')!;
    expect(sofia.tier).toBe(1);
    expect(db.getPersonByName('Sofi')).toBeUndefined();
    expect(db.listPeople().filter((p) => p.email === 'sofi@acme.example')).toHaveLength(1);
    expect(db.getPersonByName('Marian')?.tier).toBe(1);
    fs.rmSync(env.dataDir, { recursive: true, force: true });
  });

  it('save() archives the previous version, hot-reloads, and broadcasts config.changed', () => {
    const env = makeEnv();
    const db = new Db(':memory:');
    const bus = createBus();
    const config = createConfig(env, db, bus);
    const events: string[] = [];
    bus.onBroadcast((e) => events.push(e.type));

    const next = '## People\n- **Nueva** — weight: CRITICAL | slack: @nueva\n';
    const { warnings } = config.save('team', next);
    expect(warnings).toEqual([]);
    expect(config.raw('team')).toBe(next);
    expect(config.team().people.map((p) => p.name)).toEqual(['Nueva']);
    expect(events).toContain('config.changed');
    // people rematerialized on team change
    expect(db.getPersonByName('Nueva')?.tier).toBe(1);
    // previous version snapshotted
    const archived = fs.readdirSync(env.configArchiveDir).filter((f) => f.startsWith('team-'));
    expect(archived.length).toBe(1);
    fs.rmSync(env.dataDir, { recursive: true, force: true });
  });

  // H3: a fresh real install must never inherit the fictional Acme/Marian/Sofi/Diego
  // team.md (or Maxo's persona.md) as if they were the actual user's data — those
  // fixtures exist only for the sim scenario.
  it('real mode seeds team.md/persona.md with zero Tier-1 people and a neutral persona', () => {
    const env = makeEnv('real');
    const db = new Db(':memory:');
    const bus = createBus();
    const config = createConfig(env, db, bus);
    config.materializePeople();

    expect(db.listPeople().filter((p) => p.tier === 1)).toHaveLength(0);
    expect(db.getPersonByName('Marian')).toBeUndefined();
    expect(db.getPersonByName('Sofi')).toBeUndefined();
    expect(db.getPersonByName('Diego')).toBeUndefined();
    // parse.ts must tolerate a People section with zero live bullets (no throw,
    // no crash on hot-reload) — the fictional names may appear only inside an
    // HTML comment / prose example, never as a parseable bullet.
    expect(config.team().people).toHaveLength(0);

    expect(config.persona()).not.toContain('Maxo');
    expect(config.persona()).not.toContain('Buenos Aires');
    expect(config.persona().toLowerCase()).toContain('fill this in');
    fs.rmSync(env.dataDir, { recursive: true, force: true });
  });

  it('sim mode (default) keeps seeding the Acme fixtures the sim scenario depends on', () => {
    const env = makeEnv('sim');
    const db = new Db(':memory:');
    const bus = createBus();
    const config = createConfig(env, db, bus);
    config.materializePeople();

    expect(db.listPeople().filter((p) => p.tier === 1).map((p) => p.name).sort()).toEqual([
      'Diego',
      'Marian',
      'Sofi',
    ]);
    expect(config.persona()).toContain('Maxo');
    fs.rmSync(env.dataDir, { recursive: true, force: true });
  });
});
