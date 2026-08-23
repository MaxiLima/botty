/**
 * botty e2e — the regression net (BACKLOG P1 "Automated e2e").
 *
 *   npm run e2e            # spawn sim + agent (mock LLM, temp dir, free ports), run every scenario, tear down
 *   npm run e2e -- --keep  # keep the temp data dir + logs for inspection
 *   npm run e2e -- --only funnel,chat   # run a subset (names below)
 *
 * Scenarios (each is a named step; a failing assertion fails the run but later steps still execute):
 *   boot      health → dbPath inside the temp dir, schedule gates collapsed by the fast heartbeat
 *   guards    non-local Origin / Host → 403, no-Origin local POST → 200
 *   funnel    workweek @120min → deterministic mock funnel outcome counts, task count, owner inversion, dedup
 *   chat      `!tool` triggers: capture_task, task_action done, set_reminder (+ exact-time delivery ≤ 20s)
 *   sweep     thread ask + outbound "done" reply → resolution sweep auto-closes + auto_resolve notification
 *   gates     tick survivors under the fast profile; quiet_hours / muted / user_active gates via config + REST
 *   timewarp  stop agent → +6h → restart → NEVER_SURFACED candidates appear under the default min-age
 *   backfill  backfill scenario → sources done, distilled decisions > 0, never tasks
 *   ws        every broadcast seen on /ws parses against WsEventSchema; expected event kinds were observed
 *
 * Never touches 4820/4821 (live), 5820/5821 (/verify) or 6820/6821 (sandbox): ports come from the OS.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import WebSocket from 'ws';
import { WsEventSchema } from '../../packages/shared/src/api.js';
import { SOURCES, getJson, postJson, sleep, startInstance, timewarp, until, type Instance } from './harness.js';

// ---------- tiny assertion/reporting layer ----------

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  failures: string[];
}
const results: StepResult[] = [];
let current: StepResult | null = null;

function check(cond: unknown, message: string): boolean {
  if (!current) throw new Error('check() outside a step');
  if (!cond) current.failures.push(message);
  return Boolean(cond);
}
/** Key-order-insensitive structural equality (objects are compared with sorted keys). */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val as Record<string, unknown>).sort().map((k) => [k, (val as Record<string, unknown>)[k]]))
      : val,
  );
}
function eq<T>(actual: T, expected: T, label: string): boolean {
  return check(canon(actual) === canon(expected), `${label}: expected ${canon(expected)}, got ${canon(actual)}`);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  if (only && !only.has(name)) return;
  current = { name, ok: true, ms: 0, failures: [] };
  const t0 = Date.now();
  try {
    await fn();
  } catch (err) {
    current.failures.push(`threw: ${(err as Error).stack ?? String(err)}`);
  }
  current.ms = Date.now() - t0;
  current.ok = current.failures.length === 0;
  results.push(current);
  const mark = current.ok ? '✓' : '✗';
  console.log(`${mark} ${name} (${current.ms}ms)`);
  for (const f of current.failures) console.log(`    - ${f}`);
  current = null;
}

// ---------- args ----------

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const onlyArg = argv.find((a) => a.startsWith('--only'));
const only = onlyArg
  ? new Set((onlyArg.includes('=') ? onlyArg.split('=')[1]! : argv[argv.indexOf(onlyArg) + 1] ?? '').split(',').filter(Boolean))
  : null;

// ---------- API shapes we touch (narrow, local) ----------

interface Task {
  id: string;
  description: string;
  status: string;
  priority: number;
  owner: 'me' | 'them';
  source: string;
  sourceRef: string | null;
  requesterName?: string | null;
  dueDate: string | null;
  snoozeUntil: string | null;
}
interface RawEvent {
  externalId: string;
  source: string;
  outcome: string | null;
  body: string;
}
interface Tick {
  id: string;
  candidatesIn: number;
  candidatesAfterRules: number;
  actionsJson: string;
  skippedJson: string;
  judgmentDecisionId: string | null;
  error: string | null;
}

const H = (inst: Instance) => ({
  tasks: async (status = 'open') => (await getJson<{ tasks: Task[] }>(`${inst.agentUrl}/api/tasks?status=${status}`)).tasks,
  rawLog: async () => (await getJson<{ events: RawEvent[] }>(`${inst.agentUrl}/api/raw-log?limit=500`)).events,
  outcomes: async () => {
    const counts: Record<string, number> = {};
    for (const e of await (await getJson<{ events: RawEvent[] }>(`${inst.agentUrl}/api/raw-log?limit=500`)).events) {
      counts[e.outcome ?? 'null'] = (counts[e.outcome ?? 'null'] ?? 0) + 1;
    }
    return counts;
  },
  checkAll: async () => {
    for (const s of SOURCES) await postJson(`${inst.agentUrl}/api/sources/${s}/check-now`);
  },
  /** check-now is async: wait until no raw event is still un-stamped and the check log is quiet. */
  settle: async () => {
    await sleep(500);
    await until(
      async () => {
        const events = await (await getJson<{ events: RawEvent[] }>(`${inst.agentUrl}/api/raw-log?limit=500`)).events;
        return events.every((e) => e.outcome !== null) ? true : null;
      },
      20_000,
      'funnel to stamp every raw event',
    );
  },
  tick: async () => {
    const { body } = await postJson<{ tickId: string }>(`${inst.agentUrl}/api/loop/run-now`);
    return (await getJson<{ tick: Tick }>(`${inst.agentUrl}/api/ticks/${body.tickId}`)).tick;
  },
  gates: (tick: Tick) => {
    const rules = (JSON.parse(tick.skippedJson) as { rules?: { taskId: string; gate: string }[] }).rules ?? [];
    const byGate: Record<string, number> = {};
    for (const r of rules) byGate[r.gate] = (byGate[r.gate] ?? 0) + 1;
    return { byGate, rules };
  },
  chat: (text: string) => postJson<{ turnId: string }>(`${inst.agentUrl}/api/chat/message`, { text }),
  lastAssistant: async () => {
    const { turns } = await getJson<{ turns: { role: string; content: string }[] }>(`${inst.agentUrl}/api/chat/history?limit=4`);
    return [...turns].reverse().find((t) => t.role === 'assistant')?.content ?? '';
  },
  heartbeatPath: path.join(inst.dataDir, 'config', 'heartbeat.md'),
  patchHeartbeat: async (from: string, to: string) => {
    const p = path.join(inst.dataDir, 'config', 'heartbeat.md');
    const s = fs.readFileSync(p, 'utf8');
    if (!s.includes(from)) throw new Error(`heartbeat.md has no "${from}"`);
    fs.writeFileSync(p, s.replace(from, to));
    // hot reload is debounced; wait until the served config reflects it
    await sleep(900);
  },
});

// ---------- WS capture ----------

function captureWs(inst: Instance, events: { type: string; payload: unknown }[] = [], invalid: string[] = []): { events: { type: string; payload: unknown }[]; invalid: string[]; close: () => void } {
  const ws = new WebSocket(`ws://127.0.0.1:${inst.agentPort}/ws`, { headers: { origin: inst.agentUrl } });
  ws.on('message', (data) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      invalid.push(`non-JSON frame: ${data.toString().slice(0, 120)}`);
      return;
    }
    const r = WsEventSchema.safeParse(parsed);
    if (!r.success) {
      invalid.push(`${(parsed as { type?: string })?.type ?? '?'}: ${r.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`);
    }
    const ev = parsed as { type: string; payload: unknown };
    events.push(ev);
  });
  ws.on('error', (err) => invalid.push(`ws error: ${err.message}`));
  return { events, invalid, close: () => ws.close() };
}

// ---------- main ----------

async function main(): Promise<number> {
  console.log('botty e2e — booting isolated sim + agent (mock LLM)…');
  const inst = await startInstance({ mock: true });
  console.log(`  agent ${inst.agentUrl} · sim ${inst.simUrl} · data ${inst.dataDir}`);
  const api = H(inst);
  let ws = captureWs(inst);
  const wsSeen = () => new Set(ws.events.map((e) => e.type));

  try {
    await step('boot', async () => {
      const health = await getJson<{ ok: boolean; mode: string; dbPath: string; schedule: { withinWorkingHours: boolean; quietHours: boolean } }>(`${inst.agentUrl}/api/health`);
      check(health.ok, 'health.ok');
      eq(health.mode, 'sim', 'mode');
      check(health.dbPath.startsWith(inst.dataDir), `dbPath ${health.dbPath} inside ${inst.dataDir}`);
      // fast heartbeat seeded before boot → gates collapsed
      eq(health.schedule.withinWorkingHours, true, 'fast profile: withinWorkingHours');
      eq(health.schedule.quietHours, false, 'fast profile: quietHours');
      const cfg = await getJson<{ issues: { heartbeat: unknown; mcp: unknown } }>(`${inst.agentUrl}/api/config`);
      eq(cfg.issues.heartbeat, null, 'heartbeat parses clean');
    });

    await step('guards', async () => {
      const evilOrigin = await postJson(`${inst.agentUrl}/api/loop/run-now`, undefined, { Origin: 'http://evil.example' });
      eq(evilOrigin.status, 403, 'POST with non-local Origin');
      // fetch() refuses to override Host — use a raw request for the DNS-rebinding guard
      const evilHostStatus = await new Promise<number>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: inst.agentPort, path: '/api/health', headers: { Host: 'evil.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on('error', reject);
      });
      eq(evilHostStatus, 403, 'GET with non-local Host');
      const noOrigin = await postJson(`${inst.agentUrl}/api/notifications/test`);
      eq(noOrigin.status, 200, 'local POST without Origin');
      const badSource = await postJson(`${inst.agentUrl}/api/sources/bogus/check-now`);
      eq(badSource.status, 400, 'unknown source → 400');
      const badLimit = await fetch(`${inst.agentUrl}/api/raw-log?limit=-1`);
      eq(badLimit.status, 400, 'negative limit → 400');
    });

    await step('funnel', async () => {
      const load = await postJson<{ ok: boolean; scenario: { eventCount: number } }>(`${inst.simUrl}/control/scenario/load`, { name: 'workweek' });
      check(load.body.ok, 'workweek loads');
      const adv = await postJson<{ ok: boolean }>(`${inst.simUrl}/control/advance`, { minutes: 120 });
      check(adv.body.ok, 'advance 120');
      const state = await getJson<{ released: unknown[]; pending: unknown[] }>(`${inst.simUrl}/control/state`);
      eq(state.released.length, 28, 'workweek events released at 120 min');
      await api.checkAll();
      await api.settle();
      const outcomes = await api.outcomes();
      // Deterministic under the mock LLM (classifier = heuristic regexes, extractor = one task per event).
      eq(outcomes, { CLASSIFIED_OUT: 1, DEDUPED: 1, EXTRACTED: 9, INTERACTION_ONLY: 6, NO_SIGNAL: 3, UPSERTED: 7 }, 'funnel outcome counts');
      const tasks = await api.tasks();
      eq(tasks.length, 13, 'open tasks after workweek@120');
      const bySource: Record<string, number> = {};
      for (const t of tasks) bySource[t.source] = (bySource[t.source] ?? 0) + 1;
      eq(bySource, { github: 1, jira: 3, slack: 9 }, 'tasks by source');
      // owner inversion: Diego's "I'll send you the latency doc tomorrow" is THEIR promise
      const diegoPromise = tasks.find((t) => t.sourceRef === 'T-1003');
      check(diegoPromise?.owner === 'them', `T-1003 owner=them (got ${diegoPromise?.owner})`);
      check(diegoPromise?.priority === 2, `owner=them defaults to P2 (got ${diegoPromise?.priority})`);
      // tier gate: Rodrigo/Caro/Fer (not in team.md) never become tasks
      check(!tasks.some((t) => /Rodrigo|Caro|Fer Acosta/.test(t.requesterName ?? '')), 'no tasks from Tier-2 senders');
      // cross-source dedup: Marian's slack ask about PR #482 lands first (min 0); the github
      // review-request for the same PR (min 60) is recorded as DEDUPED instead of a second task
      const raw = await api.rawLog();
      const deduped = raw.find((e) => e.outcome === 'DEDUPED');
      check(deduped?.source === 'github' && /482/.test(deduped.body), `DEDUPED is the github PR#482 event (got ${deduped?.source} ${deduped?.externalId})`);
      check(tasks.some((t) => t.sourceRef === 'T-1001'), 'the slack ask (T-1001) is the surviving task');
      // people: team + discovered
      const people = (await getJson<{ people: { name: string; tier: number; source: string }[] }>(`${inst.agentUrl}/api/people`)).people;
      eq(people.filter((p) => p.source === 'team_md').length, 3, 'team.md people materialized');
      check(people.some((p) => p.source === 'discovered' && p.tier === 2), 'discovered tier-2 people exist');
      // calendar events upserted
      const cal = raw.filter((e) => e.source === 'gcal');
      check(cal.length >= 1 && cal.every((e) => e.outcome === 'UPSERTED'), 'gcal events UPSERTED');
    });

    await step('chat', async () => {
      // capture_task
      const r1 = await api.chat('!tool capture_task {"description":"E2E: write the Q3 postmortem","priority":1,"dueDate":"2030-01-02","requestedBy":"Marian"}');
      eq(r1.status, 200, 'chat POST');
      const captured = await until(async () => (await api.tasks()).find((t) => t.description.startsWith('E2E: write')), 5000, 'captured task');
      eq(captured.priority, 1, 'captured priority');
      eq(captured.dueDate, '2030-01-02', 'captured dueDate');
      eq(captured.requesterName ?? null, 'Marian', 'captured requester resolved to team member');
      check(/capture_task →/.test(await api.lastAssistant()), 'assistant echoes tool result');
      // task_action done
      await api.chat(`!tool task_action {"taskId":"${captured.id}","action":"done"}`);
      const done = await until(async () => (await api.tasks('done')).find((t) => t.id === captured.id), 5000, 'task done');
      eq(done.status, 'done', 'task_action done');
      // unknown tool
      await api.chat('!tool nope {}');
      check(/unknown tool: nope/.test(await api.lastAssistant()), 'unknown tool reported');
      // set_reminder → exact-time delivery (scheduler polls every 15s, no time gates)
      const dueAt = new Date(Date.now() + 2000).toISOString();
      await api.chat(`!tool set_reminder {"description":"E2E ping","dueAt":"${dueAt}"}`);
      check(/reminderId/.test(await api.lastAssistant()), 'set_reminder returned an id');
      const delivered = await until(
        async () => ws.events.find((e) => e.type === 'notification' && (e.payload as { kind: string; message: string }).kind === 'reminder' && /E2E ping/.test((e.payload as { message: string }).message)),
        25_000,
        'reminder notification on WS',
      );
      check(Boolean(delivered), 'reminder delivered');
      // validation: past dueAt is refused by the tool
      await api.chat('!tool set_reminder {"description":"past","dueAt":"2001-01-01T00:00:00Z"}');
      check(/must be in the future|error/.test(await api.lastAssistant()), 'past dueAt rejected');
    });

    await step('sweep', async () => {
      const ask = await postJson<{ ok: boolean }>(`${inst.simUrl}/control/inject`, {
        source: 'slack',
        kind: 'dm',
        actor: { handle: '@marian', displayName: 'Marian' },
        text: 'Can you send me the KYC risk matrix before the meeting? please',
        threadRef: 'T-E2E-SWEEP',
      });
      check(ask.body.ok, 'inject ask');
      await postJson(`${inst.agentUrl}/api/sources/slack/check-now`);
      const task = await until(async () => (await api.tasks()).find((t) => t.sourceRef === 'T-E2E-SWEEP'), 8000, 'ask becomes a task');
      // sweep with no evidence: not closed
      const s1 = await postJson<{ result: { closed: { taskId: string }[] } }>(`${inst.agentUrl}/api/loop/sweep-now`);
      check(!s1.body.result.closed.some((c) => c.taskId === task.id), 'no auto-close without completion evidence');
      // my own outbound "done" reply in the thread
      await postJson(`${inst.simUrl}/control/inject`, {
        source: 'slack',
        kind: 'dm',
        actor: { handle: '@me', displayName: 'Me' },
        direction: 'outbound',
        text: 'done — sent it over',
        threadRef: 'T-E2E-SWEEP',
      });
      await postJson(`${inst.agentUrl}/api/sources/slack/check-now`);
      await api.settle();
      const outbound = (await api.rawLog()).find((e) => /sent it over/.test(e.body));
      eq(outbound?.outcome, 'INTERACTION_ONLY', 'outbound reply is never task-extracted');
      const s2 = await postJson<{ result: { closed: { taskId: string; proactiveLogId: string }[] } }>(`${inst.agentUrl}/api/loop/sweep-now`);
      check(s2.body.result.closed.some((c) => c.taskId === task.id), `sweep auto-closed the task (closed=${JSON.stringify(s2.body.result.closed.map((c) => c.taskId))})`);
      const after = (await api.tasks('done')).find((t) => t.id === task.id);
      eq(after?.status, 'done', 'task status done after sweep');
      check(ws.events.some((e) => e.type === 'notification' && (e.payload as { kind: string }).kind === 'auto_resolve'), 'auto_resolve notification broadcast');
    });

    await step('gates', async () => {
      // fast profile: min-age 0, gates off → every open task is a candidate and survives the rules filter
      const t1 = await api.tick();
      check(t1.candidatesIn > 0, `candidatesIn > 0 (got ${t1.candidatesIn})`);
      eq(t1.candidatesAfterRules, t1.candidatesIn, 'all candidates survive the rules filter under the fast profile');
      check(t1.judgmentDecisionId !== null, 'judgment ran (decision recorded)');
      eq(JSON.parse(t1.actionsJson), [], 'mock judgment skips everything');
      // quiet hours (hot reload). NOTE: api.tick() is a user-triggered run-now,
      // which deliberately WAIVES the quiet-hours and user-active gates — a
      // "check now" is an explicit request, not an unprompted interruption
      // (report §3 MEDIUM: run-now used to silently reject every candidate).
      // The scheduled path is still hard-gated at the tick level; that's unit
      // tested in test/loop/{tick,rules-filter}.test.ts, not reachable here.
      await api.patchHeartbeat('quiet_hours: 00:00-00:00', 'quiet_hours: 00:00-23:59');
      const t2 = await api.tick();
      const g2 = api.gates(t2);
      eq(t2.candidatesAfterRules, t2.candidatesIn, 'quiet hours: run-now keeps its candidates');
      eq(g2.byGate.quiet_hours ?? 0, 0, `run-now waives the quiet_hours gate (got ${JSON.stringify(g2.byGate)})`);
      check(t2.judgmentDecisionId !== null, 'run-now still reaches judgment inside quiet hours');
      await api.patchHeartbeat('quiet_hours: 00:00-23:59', 'quiet_hours: 00:00-00:00');
      // muted requester → that person's tasks rejected by `muted`
      const people = (await getJson<{ people: { id: string; name: string }[] }>(`${inst.agentUrl}/api/people`)).people;
      const diego = people.find((p) => p.name === 'Diego')!;
      await postJson(`${inst.agentUrl}/api/people/${diego.id}/mute`, { until: new Date(Date.now() + 3_600_000).toISOString() });
      const t3 = await api.tick();
      const g3 = api.gates(t3);
      const diegoTasks = (await api.tasks()).filter((t) => t.requesterName === 'Diego').length;
      eq(g3.byGate.muted ?? 0, diegoTasks, `muted gate rejects exactly Diego's ${diegoTasks} tasks`);
      await postJson(`${inst.agentUrl}/api/people/${diego.id}/mute`, { until: null });
      // chat-active gate — same story as quiet hours: waived for run-now.
      await api.patchHeartbeat('chat_active_gate_min: 0', 'chat_active_gate_min: 2');
      await api.chat('hola');
      const t4 = await api.tick();
      eq(t4.candidatesAfterRules, t4.candidatesIn, 'user chatting: run-now keeps its candidates');
      eq(api.gates(t4).byGate.user_active ?? 0, 0, 'run-now waives the user_active gate');
      await api.patchHeartbeat('chat_active_gate_min: 2', 'chat_active_gate_min: 0');
      // snoozed tasks are not candidates at all
      const victim = (await api.tasks()).find((t) => t.sourceRef === 'T-1004')!;
      await postJson(`${inst.agentUrl}/api/tasks/${victim.id}/action`, { action: 'snooze', snoozeDays: 1 });
      const t5 = await api.tick();
      check(!api.gates(t5).rules.some((r) => r.taskId === victim.id) && t5.candidatesIn === t4.candidatesIn - 1, 'snoozed task dropped from candidates');
      await postJson(`${inst.agentUrl}/api/tasks/${victim.id}/action`, { action: 'reopen' });
      // meeting prep: a gcal event in 30 min with a Tier-1 attendee synthesizes a prep task
      await postJson(`${inst.simUrl}/control/inject`, {
        source: 'gcal',
        kind: 'event',
        actor: { email: 'marian@acme.example', displayName: 'Marian' },
        text: 'E2E war room',
        // absolute times: `startAtMinute` would anchor at the scenario clock (paused at +120 min), not wall now
        meta: {
          startAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          endAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          attendees: ['marian@acme.example'],
        },
      });
      await postJson(`${inst.agentUrl}/api/sources/gcal/check-now`);
      await api.settle();
      await api.tick();
      const prep = (await api.tasks()).find((t) => t.sourceRef?.startsWith('meeting_prep:') && /E2E war room/.test(t.description));
      check(Boolean(prep), 'meeting-prep task synthesized for the Tier-1 meeting');
    });

    await step('timewarp', async () => {
      // Restore the default min-age so fresh tasks are NOT candidates, then age them 6h.
      await api.patchHeartbeat('never_surfaced_min_age_hours: 0', 'never_surfaced_min_age_hours: 4');
      const before = await api.tick();
      eq(before.candidatesIn, (await api.tasks()).filter((t) => t.dueDate !== null).length, 'fresh tasks are not candidates (only due-dated ones)');
      ws.close();
      await inst.stopAgent();
      const out = timewarp(inst, ['--hours', '6']);
      check(/advanced time by 6h/.test(out), `timewarp output: ${out}`);
      await inst.restartAgent();
      ws = captureWs(inst, ws.events, ws.invalid);
      const after = await api.tick();
      check(after.candidatesIn > before.candidatesIn, `aged tasks become NEVER_SURFACED candidates (${before.candidatesIn} → ${after.candidatesIn})`);
      // the chat history survived the restart and shifted with the clock
      const { turns } = await getJson<{ turns: { role: string }[] }>(`${inst.agentUrl}/api/chat/history?limit=3`);
      check(turns.length > 0, 'chat history persisted across restart');
      await api.patchHeartbeat('never_surfaced_min_age_hours: 4', 'never_surfaced_min_age_hours: 0');
    });

    await step('backfill', async () => {
      const load = await postJson<{ ok: boolean; scenario: { historyCount: number } }>(`${inst.simUrl}/control/scenario/load`, { name: 'backfill' });
      check(load.body.ok && load.body.scenario.historyCount > 0, 'backfill scenario has history');
      const tasksBefore = (await api.tasks()).length;
      const start = await postJson<{ started: boolean }>(`${inst.agentUrl}/api/backfill/start`, { sources: ['slack', 'gmail', 'gcal'], days: 30 });
      check(start.body.started, 'backfill started');
      const state = await until(
        async () => {
          const s = (await getJson<{ state: { status: string; sources: Record<string, { done: boolean; fetched: number; error: string | null }>; distill: { decisionsCreated: number; done: boolean } } }>(`${inst.agentUrl}/api/backfill`)).state;
          return s.status === 'done' ? s : null;
        },
        30_000,
        'backfill to finish',
      );
      check(Object.values(state.sources).every((s) => s.done && !s.error), `all sources done without error (${JSON.stringify(state.sources)})`);
      check(Object.values(state.sources).reduce((n, s) => n + s.fetched, 0) === load.body.scenario.historyCount, 'fetched every history event');
      check(state.distill.decisionsCreated > 0, 'distillation created decisions');
      eq((await api.tasks()).length, tasksBefore, 'backfill never creates tasks');
      check(ws.events.some((e) => e.type === 'backfill.progress'), 'backfill.progress broadcast');
    });

    await step('ws', async () => {
      eq(ws.invalid, [], 'every WS frame parses against WsEventSchema');
      for (const kind of ['tasks.updated', 'source.checked', 'decision.recorded', 'chat.chunk', 'chat.done', 'notification', 'config.changed', 'tick.completed']) {
        check(wsSeen().has(kind), `saw WS event ${kind}`);
      }
    });
  } finally {
    ws.close();
    await inst.teardown(keep);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(', ')}` : ''}`);
  if (keep) console.log(`data dir kept at ${inst.dataDir} (logs in ${inst.dataDir}/logs)`);
  return failed.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('e2e: fatal', err);
    process.exit(2);
  },
);
