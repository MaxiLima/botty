// Transcript blocks rendered by slash commands (and the welcome banner).
import React from 'react';
import { Box, Text } from 'ink';
import type { AiDecision, Interaction, Person, SourceCheckRow, Task, TickLogRow } from '@botty/shared';
import { COMMANDS, type PanelData } from './commands.js';
import { priorityColor, priorityLabel, shortDate, timeAgo } from './format.js';
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
          <Text color="cyan">{fit(t.requesterName ?? t.requestedBy ?? '—', 10)}</Text> {fit(t.description, descW)}
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
          {fit(t.description, width - 14)}
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
      {ticks.map((t) => (
        <Text key={t.id}>
          {'  '}
          {t.error ? <Text color="red">✗</Text> : <Text color="green">✓</Text>}{' '}
          <Text>{fit(t.trigger, 12)}</Text>
          <Text dimColor>
            {' '}
            {t.candidatesIn ?? 0} in → {t.candidatesAfterRules ?? 0} after rules · {timeAgo(t.startedAt)}
          </Text>
        </Text>
      ))}
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
    case 'config':
      return (
        <Frame title={`config — ${panel.name} (read-only here)`}>
          <Text>{renderMarkdown(panel.content, width)}</Text>
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
