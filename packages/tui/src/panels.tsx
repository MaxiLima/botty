// Transcript blocks rendered by slash commands (and the welcome banner).
import React from 'react';
import { Box, Text } from 'ink';
import type {
  AiDecision,
  CostCategory,
  CostsReport,
  Interaction,
  Person,
  SourceCheckRow,
  Task,
  TickLogRow,
} from '@botty/shared';
import { COST_CATEGORIES, COST_CATEGORY_LABELS } from '@botty/shared';
import { COMMANDS, type PanelData } from './commands.js';
import { priorityColor, priorityLabel, shortDate, summarizeGates, timeAgo } from './format.js';
import { renderMarkdown } from './markdown.js';
import { MASCOT_LINES, TAGLINE } from './mascot.js';

export function fit(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, Math.max(0, n - 1))}…` : flat.padEnd(n);
}

function weightColor(w: Person['weight']): string | undefined {
  if (w === 'CRITICAL') return 'red';
  if (w === 'HIGH') return 'yellow';
  return undefined;
}

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1}>
      <Text bold color="magenta">
        {title}
      </Text>
      {children}
    </Box>
  );
}

function TasksBody({ tasks, width }: { tasks: Task[]; width: number }) {
  if (tasks.length === 0) return <Text dimColor>board is clear ✓</Text>;
  const descW = Math.max(20, width - 26);
  return (
    <>
      {tasks.map((t) => (
        <Text key={t.id}>
          <Text color={priorityColor(t.priority)} bold>
            {priorityLabel(t.priority)}
          </Text>
          <Text dimColor> {fit(t.dueDate ? shortDate(t.dueDate) : '—', 6)} </Text>
          <Text color="cyan">{fit(t.requesterName ?? t.requestedBy ?? '—', 10)}</Text>{' '}
          {fit(t.description, t.owner === 'them' ? descW - 10 : descW)}
          {t.owner === 'them' && <Text dimColor color="yellow"> ⇠ waiting</Text>}
        </Text>
      ))}
      <Text dimColor>{tasks.length} open — manage them in the web app or just tell botty</Text>
    </>
  );
}

function PeopleBody({ people, width }: { people: Person[]; width: number }) {
  if (people.length === 0) return <Text dimColor>nobody yet</Text>;
  return (
    <>
      {people.map((p) => (
        <Text key={p.id}>
          <Text bold>{fit(p.name, 16)}</Text>
          <Text color={weightColor(p.weight)}>{fit(p.weight, 9)}</Text>
          <Text dimColor>{fit(p.slackHandle ?? p.email ?? '', Math.max(10, width - 52))}</Text>
          <Text> {String(p.openTaskCount ?? 0).padStart(2)} open</Text>
          <Text dimColor> · {timeAgo(p.lastInteractionAt)}</Text>
          {p.mutedUntil && <Text color="yellow"> muted</Text>}
        </Text>
      ))}
      <Text dimColor>/people {'<name>'} for detail</Text>
    </>
  );
}

function PersonBody({
  person,
  interactions,
  tasks,
  width,
}: {
  person: Person;
  interactions: Interaction[];
  tasks: Task[];
  width: number;
}) {
  const open = tasks.filter((t) => t.status === 'open');
  return (
    <>
      <Text>
        <Text bold>{person.name}</Text>
        <Text color={weightColor(person.weight)}> {person.weight}</Text>
        <Text dimColor>
          {' '}
          · tier {person.tier} · {person.slackHandle ?? person.email ?? '—'}
          {person.cadence ? ` · ${person.cadence}` : ''}
        </Text>
        {person.mutedUntil && <Text color="yellow"> · muted until {shortDate(person.mutedUntil)}</Text>}
      </Text>
      {person.notes && <Text dimColor>{fit(person.notes, width)}</Text>}
      {open.length > 0 && <Text bold>open tasks</Text>}
      {open.map((t) => (
        <Text key={t.id}>
          {'  '}
          <Text color={priorityColor(t.priority)}>{priorityLabel(t.priority)}</Text>
          <Text dimColor> {fit(t.dueDate ? shortDate(t.dueDate) : '—', 6)} </Text>
          {fit(t.description, t.owner === 'them' ? width - 24 : width - 14)}
          {t.owner === 'them' && <Text dimColor color="yellow"> ⇠ waiting</Text>}
        </Text>
      ))}
      <Text bold>recent interactions</Text>
      {interactions.slice(0, 5).map((i) => (
        <Text key={i.id}>
          {'  '}
          <Text color={i.direction === 'outbound' ? 'green' : 'cyan'}>{i.direction === 'outbound' ? '→' : '←'}</Text>
          <Text dimColor> {fit(`${i.source}/${i.kind}`, 16)} </Text>
          {fit(i.snippet ?? '', width - 28)}
          <Text dimColor> {timeAgo(i.occurredAt)}</Text>
        </Text>
      ))}
      {interactions.length === 0 && <Text dimColor>  none recorded</Text>}
    </>
  );
}

function InspectorBody({
  decisions,
  ticks,
  checks,
  width,
}: {
  decisions: AiDecision[];
  ticks: TickLogRow[];
  checks: SourceCheckRow[];
  width: number;
}) {
  return (
    <>
      <Text bold>decisions</Text>
      {decisions.map((d) => (
        <Text key={d.id}>
          {'  '}
          {d.error ? <Text color="red">✗</Text> : <Text color="green">✓</Text>}{' '}
          <Text color="cyan">{fit(d.kind, 22)}</Text>
          <Text dimColor>
            {fit(d.model, Math.max(12, width - 50))} {String(d.latencyMs ?? 0).padStart(5)}ms {timeAgo(d.createdAt)}
          </Text>
        </Text>
      ))}
      {decisions.length === 0 && <Text dimColor>  none yet</Text>}
      <Text bold>ticks</Text>
      {ticks.map((t) => {
        const gates = summarizeGates(t.skippedJson);
        return (
          <Text key={t.id}>
            {'  '}
            {t.error ? <Text color="red">✗</Text> : <Text color="green">✓</Text>}{' '}
            <Text>{fit(t.trigger, 12)}</Text>
            <Text dimColor>
              {' '}
              {t.candidatesIn ?? 0} in → {t.candidatesAfterRules ?? 0} after rules
              {gates ? ` ${gates}` : ''} · {timeAgo(t.startedAt)}
            </Text>
          </Text>
        );
      })}
      {ticks.length === 0 && <Text dimColor>  none yet</Text>}
      <Text bold>source checks</Text>
      {checks.map((c) => (
        <Text key={c.id}>
          {'  '}
          {c.error ? <Text color="red">✗</Text> : <Text color="green">✓</Text>}{' '}
          <Text>{fit(c.source, 10)}</Text>
          <Text dimColor>
            {' '}
            {c.eventsNew}/{c.eventsFetched} new · {timeAgo(c.checkedAt)}
          </Text>
        </Text>
      ))}
      {checks.length === 0 && <Text dimColor>  none yet</Text>}
      <Text dimColor>full detail lives in the web app's Inspector</Text>
    </>
  );
}

const COST_CATEGORY_INK: Record<CostCategory, string | undefined> = {
  chat: 'magenta',
  intake: 'green',
  proactive: 'yellow',
  resolution: 'blue',
  briefing: 'cyan',
  other: undefined,
};

function fmtUsd(v: number): string {
  if (v >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toPrecision(2)}`; // $0.73, $0.50, $0.055
  if (v > 0) return `$${parseFloat(v.toPrecision(2))}`; // $0.0007
  return '$0.00';
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function CostsBody({ report, width }: { report: CostsReport; width: number }) {
  const { today, last7d, last30d, allTime } = report.windows;
  if (allTime.totals.calls === 0) {
    return <Text dimColor>no LLM usage recorded yet — costs will appear as botty works</Text>;
  }
  const w = last30d;
  const total = w.totals.costUsd;
  const categories = COST_CATEGORIES.map((c) => ({ c, t: w.byCategory[c] }))
    .filter((x): x is { c: CostCategory; t: NonNullable<typeof x.t> } => x.t !== undefined && x.t.calls > 0)
    .sort((a, b) => b.t.costUsd - a.t.costUsd);
  const meterW = 14;
  return (
    <>
      <Text>
        <Text dimColor>today </Text>
        <Text bold>{fmtUsd(today.totals.costUsd)}</Text>
        <Text dimColor> · 7d </Text>
        <Text bold>{fmtUsd(last7d.totals.costUsd)}</Text>
        <Text dimColor> · 30d </Text>
        <Text bold>{fmtUsd(last30d.totals.costUsd)}</Text>
        <Text dimColor> · all time </Text>
        <Text bold>{fmtUsd(allTime.totals.costUsd)}</Text>
      </Text>
      <Text bold>by activity — last 30 days</Text>
      {categories.map(({ c, t }) => {
        const share = total > 0 ? t.costUsd / total : 0;
        const filled = total > 0 ? Math.max(t.costUsd > 0 ? 1 : 0, Math.round(share * meterW)) : 0;
        return (
          <Text key={c}>
            {'  '}
            <Text color={COST_CATEGORY_INK[c]}>{fit(COST_CATEGORY_LABELS[c].toLowerCase(), 22)}</Text>
            <Text color={COST_CATEGORY_INK[c]}>{'▮'.repeat(filled)}</Text>
            <Text dimColor>{'·'.repeat(meterW - filled)}</Text>
            <Text> {fmtUsd(t.costUsd).padStart(9)}</Text>
            <Text dimColor>
              {' '}
              {`${fmtTokens(t.inputTokens)} in · ${fmtTokens(t.outputTokens)} out · ${t.calls} calls`}
            </Text>
          </Text>
        );
      })}
      {categories.length === 0 && <Text dimColor>  no calls in the last 30 days</Text>}
      <Text bold>by model — last 30 days</Text>
      {w.byModel.map((m) => (
        <Text key={m.model}>
          {'  '}
          <Text color="cyan">{fit(m.model, Math.min(26, Math.max(16, width - 46)))}</Text>
          <Text> {(m.priced ? fmtUsd(m.costUsd) : '—').padStart(9)}</Text>
          <Text dimColor>
            {' '}
            {`${fmtTokens(m.inputTokens)} in · ${fmtTokens(m.outputTokens)} out · ${m.calls} calls`}
            {m.priced ? '' : ' · no pricing'}
          </Text>
        </Text>
      ))}
      {w.byModel.length === 0 && <Text dimColor>  none</Text>}
      {w.totals.unpricedCalls > 0 && (
        <Text color="yellow">
          {w.totals.unpricedCalls} call{w.totals.unpricedCalls === 1 ? '' : 's'} counted at $0 (model
          without a pricing entry)
        </Text>
      )}
      <Text dimColor>estimated at API list prices — botty runs on your subscription, not billed</Text>
      <Text dimColor>daily chart & window switcher live in the web app's Costs page</Text>
    </>
  );
}

function HelpBody() {
  return (
    <>
      {COMMANDS.map((c) => (
        <Text key={c.name}>
          {'  '}
          <Text color="cyan">{fit(`/${c.name}${c.args ? ` ${c.args}` : ''}`, 34)}</Text>
          <Text dimColor>{c.description}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text dimColor>
        {'  '}Enter send · Esc interrupt / clear · ↑↓ Tab pick a command · Ctrl+C quit
      </Text>
      <Text dimColor>{'  '}anything without a leading / goes straight to botty</Text>
    </>
  );
}

export function Welcome({ panel }: { panel: Extract<PanelData, { type: 'welcome' }> }) {
  return (
    <Box borderStyle="round" borderColor="magenta" paddingX={2} paddingY={0} marginBottom={1}>
      <Box flexDirection="column" marginRight={3}>
        {MASCOT_LINES.map((l, i) => (
          <Text key={i} color="magenta">
            {l}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" justifyContent="center">
        <Text>
          <Text bold color="magenta">
            botty
          </Text>
          <Text dimColor> v{panel.version}</Text> — {TAGLINE}
        </Text>
        <Text dimColor>
          {panel.baseUrl} · {panel.mode} mode · {panel.taskCount} open task{panel.taskCount === 1 ? '' : 's'}
        </Text>
        <Text dimColor>
          type <Text color="cyan">/help</Text> for commands — or just say hi
        </Text>
        {!panel.onboarded && (
          <Text dimColor>
            first run — type <Text color="cyan">/onboarding</Text> to set things up
          </Text>
        )}
      </Box>
    </Box>
  );
}

export function Panel({ panel, columns }: { panel: PanelData; columns: number }) {
  const width = Math.max(40, columns - 8);
  switch (panel.type) {
    case 'welcome':
      return <Welcome panel={panel} />;
    case 'help':
      return (
        <Frame title="help">
          <HelpBody />
        </Frame>
      );
    case 'tasks':
      return (
        <Frame title={`tasks — ${panel.tasks.length} open`}>
          <TasksBody tasks={panel.tasks} width={width} />
        </Frame>
      );
    case 'people':
      return (
        <Frame title={`people — ${panel.people.length}`}>
          <PeopleBody people={panel.people} width={width} />
        </Frame>
      );
    case 'person':
      return (
        <Frame title={`person — ${panel.person.name}`}>
          <PersonBody {...panel} width={width} />
        </Frame>
      );
    case 'inspector':
      return (
        <Frame title="inspector">
          <InspectorBody {...panel} width={width} />
        </Frame>
      );
    case 'costs':
      return (
        <Frame title="costs">
          <CostsBody report={panel.report} width={width} />
        </Frame>
      );
    case 'config':
      return (
        <Frame title={`config — ${panel.name} (read-only here)`}>
          <Text>{renderMarkdown(panel.content, width)}</Text>
        </Frame>
      );
    case 'onboardingReview':
      return (
        <Frame title="setup review — files to be written">
          {panel.files.map((f, i) => (
            <Box key={f.name} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Text>
                <Text bold color="magenta">
                  {f.name}
                </Text>{' '}
                {f.changed ? <Text color="yellow">changed</Text> : <Text color="green">unchanged</Text>}
              </Text>
              {f.changed ? (
                <Text>{renderMarkdown('```\n' + f.content + '\n```', width)}</Text>
              ) : (
                <Text dimColor>· identical to the current file ·</Text>
              )}
            </Box>
          ))}
        </Frame>
      );
    case 'health':
      return (
        <Frame title="health">
          <Text>
            {panel.ok ? <Text color="green">● up</Text> : <Text color="red">● down</Text>}
            <Text dimColor>
              {' '}
              · v{panel.version} · {panel.mode} mode · {panel.baseUrl}
            </Text>
          </Text>
          <Text dimColor>db {fit(panel.dbPath, width - 3)}</Text>
        </Frame>
      );
  }
}
