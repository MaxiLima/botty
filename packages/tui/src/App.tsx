// Explicit React import — see the note in index.tsx (classic JSX transform).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import type { ChatTurn, PendingActionStatus } from '@botty/shared';
import { createApi } from './api.js';
import { filterCommands, parseSlash, resolveCommand, type Command, type PanelData } from './commands.js';
import type { TuiConfig } from './config.js';
import { clock } from './format.js';
import { renderMarkdown } from './markdown.js';
import { face } from './mascot.js';
import { Panel } from './panels.js';
import {
  applyChunk,
  applyThinking,
  applyToolUse,
  formatApprovalPendingLine,
  formatApprovalResolvedLine,
  newPending,
  takeUnseen,
  type PendingTurn,
} from './transcript.js';
import { startWs, useOnReconnect, useWsEvent, useWsStatus } from './ws.js';

type ItemBody =
  | { kind: 'turn'; turn: ChatTurn }
  | { kind: 'error'; text: string }
  | { kind: 'info'; text: string }
  | { kind: 'seam' }
  | { kind: 'cmd'; text: string }
  | { kind: 'nudge'; message: string; nkind: string; score: number | null }
  /** A reply that errored mid-stream — keep the partial text the user saw. */
  | { kind: 'partial'; text: string; error: string }
  /** A consent-gated external tool call the model proposed — approve/dismiss only in the web app. */
  | { kind: 'approvalPending'; text: string }
  | { kind: 'approvalResolved'; text: string; status: PendingActionStatus }
  | { kind: 'panel'; panel: PanelData };

type Item = ItemBody & { key: string };

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MAX_TOOL_LINES = 8;
const MENU_ROWS = 6;
/** Event-driven refetches only need the recent tail; boot/reconnect use the full page. */
const TAIL_LIMIT = 20;
/** Long streams: live region shows only the tail (the full reply lands in the transcript). */
const MAX_STREAM_LINES = 12;
const APPROVAL_RESOLVED_COLOR: Record<PendingActionStatus, string> = {
  pending: 'yellow',
  executed: 'green',
  failed: 'red',
  dismissed: 'gray',
  expired: 'gray',
};

export function App({ config }: { config: TuiConfig }) {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [taskCount, setTaskCount] = useState<number | null>(null);
  /** ids of currently-pending approvals, for the statusline count — set (not a bare number) so resolves reconcile cleanly regardless of arrival order. */
  const [approvalIds, setApprovalIds] = useState<Set<string>>(new Set());
  const [busyCmd, setBusyCmd] = useState<string | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const wsStatus = useWsStatus();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  const apiRef = useRef(createApi(config.baseUrl));
  const api = apiRef.current;
  const seenRef = useRef(new Set<string>());
  const seqRef = useRef(0);
  const lastSessionRef = useRef<string | null>(null);
  /** Last turnId we already refetched history for — avoids a refetch per chunk. */
  const adoptedRef = useRef<string | null>(null);
  /** Turns already finished (done/error) — replies can outrun the POST response. */
  const finishedRef = useRef(new Set<string>());
  /** True while our own POST /chat/message is in flight — its refetch covers the echo. */
  const sendingRef = useRef(false);
  /** Mirror for event handlers that need the current pending without a stale closure. */
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const menu = draft.startsWith('/') ? filterCommands(draft) : [];
  const menuOpen = menu.length > 0;
  const selected = Math.min(menuIndex, Math.max(0, menu.length - 1));

  const pushItem = useCallback((item: ItemBody) => {
    const key = `x-${seqRef.current++}`;
    setItems((prev) => [...prev, { ...item, key }]);
  }, []);

  const appendTurns = useCallback((turns: ChatTurn[]) => {
    const fresh = takeUnseen(seenRef.current, turns);
    if (fresh.length === 0) return;
    const next: Item[] = [];
    for (const turn of fresh) {
      if (lastSessionRef.current !== null && turn.sessionId !== lastSessionRef.current) {
        next.push({ kind: 'seam', key: `seam-${turn.id}` });
      }
      lastSessionRef.current = turn.sessionId;
      next.push({ kind: 'turn', key: turn.id, turn });
    }
    setItems((prev) => [...prev, ...next]);
  }, []);

  const refreshHistory = useCallback(
    async (limit: number = config.historyLimit) => {
      try {
        const res = await api.chatHistory(limit);
        appendTurns(res.turns);
        setSendError(null);
      } catch (err) {
        setSendError(err instanceof Error ? err.message : String(err));
      }
    },
    [api, appendTurns, config.historyLimit],
  );

  const bootOkRef = useRef(false);

  const refreshApprovals = useCallback(async () => {
    try {
      const { actions } = await api.actions('pending');
      setApprovalIds(new Set(actions.map((a) => a.id)));
    } catch {
      // agent unreachable — leave the count stale
    }
  }, [api]);

  // Banner (agent info + open-task count) plus history — one parallel round trip.
  const loadInitial = useCallback(async () => {
    try {
      const [h, t, hist] = await Promise.all([api.health(), api.tasks('open'), api.chatHistory(config.historyLimit)]);
      setTaskCount(t.tasks.length);
      pushItem({
        kind: 'panel',
        panel: { type: 'welcome', version: h.version, mode: h.mode, baseUrl: config.baseUrl, taskCount: t.tasks.length },
      });
      appendTurns(hist.turns);
      bootOkRef.current = true;
      void refreshApprovals();
    } catch {
      pushItem({ kind: 'error', text: `can't reach the agent at ${config.baseUrl} — is it running?` });
    }
  }, [api, appendTurns, config.baseUrl, config.historyLimit, pushItem, refreshApprovals]);

  useEffect(() => {
    startWs(config.wsUrl);
    void loadInitial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useOnReconnect((first) => {
    if (first) {
      // First-ever open only needs work when the TUI was launched before the
      // agent was up — the failed boot left no banner and no history.
      if (!bootOkRef.current) void loadInitial();
      return;
    }
    setPending(null);
    pushItem({ kind: 'info', text: 'reconnected — refreshed history' });
    void refreshHistory();
    void refreshApprovals();
  });

  /** A stream for a turn we didn't start → another client sent a message; pull it in. */
  const adopt = useCallback(
    (turnId: string) => {
      if (adoptedRef.current === turnId) return;
      adoptedRef.current = turnId;
      // Our own send's refetch covers the echo — skip the redundant round trip
      // when the first chunk merely raced ahead of the POST response.
      if (sendingRef.current) return;
      void refreshHistory(TAIL_LIMIT);
    },
    [refreshHistory],
  );

  useWsEvent('chat.chunk', (p) => {
    adopt(p.turnId);
    setPending((prev) => applyChunk(prev, p.turnId, p.delta));
  });
  useWsEvent('chat.thinking', (p) => {
    adopt(p.turnId);
    setPending((prev) => applyThinking(prev, p.turnId, p.on));
  });
  useWsEvent('chat.toolUse', (p) => {
    adopt(p.turnId);
    setPending((prev) => applyToolUse(prev, p.turnId, p.name, p.summary));
  });
  useWsEvent('chat.done', (p) => {
    finishedRef.current.add(p.turnId);
    // The turn is in the DB before chat.done is broadcast, so a refetch keeps
    // the transcript ordered (user turn before reply) even on instant replies;
    // the direct append is only a fallback if the refetch fails.
    void refreshHistory(TAIL_LIMIT).finally(() => {
      appendTurns([p.turn]);
      setPending((prev) => (prev && prev.turnId !== p.turnId ? prev : null));
    });
  });
  useWsEvent('chat.error', (p) => {
    finishedRef.current.add(p.turnId);
    // pendingRef, not `pending`: a chunk and its error can land in one batch,
    // and the closure would still see the pre-chunk state.
    const prev = pendingRef.current;
    if (prev && prev.turnId === p.turnId && prev.text) {
      // Keep the partial reply the user watched stream — don't vaporize it.
      pushItem({ kind: 'partial', text: prev.text, error: p.error });
    } else {
      pushItem({ kind: 'error', text: p.error });
    }
    setPending((cur) => (cur && cur.turnId !== p.turnId ? cur : null));
  });
  // tasks.updated is always a full board snapshot (see WsEventSchema in
  // shared/src/api.ts) — count opens, mirroring the web app's store.
  useWsEvent('tasks.updated', (p) => setTaskCount(p.tasks.filter((t) => t.status === 'open').length));
  useWsEvent('notification', (p) => {
    pushItem({ kind: 'nudge', message: p.message, nkind: p.kind, score: p.score });
  });
  // Consent-gated external tool calls: TUI is display-only — approving/dismissing
  // stays in the web app (see the ⧗ notice line's copy).
  useWsEvent('action.pending', (p) => {
    pushItem({ kind: 'approvalPending', text: formatApprovalPendingLine(p.action.summary) });
    setApprovalIds((prev) => (prev.has(p.action.id) ? prev : new Set(prev).add(p.action.id)));
  });
  useWsEvent('action.resolved', (p) => {
    pushItem({
      kind: 'approvalResolved',
      text: formatApprovalResolvedLine(p.action.status, p.action.summary),
      status: p.action.status,
    });
    setApprovalIds((prev) => {
      if (!prev.has(p.action.id)) return prev;
      const next = new Set(prev);
      next.delete(p.action.id);
      return next;
    });
  });

  // Streaming stopwatch for the statusline — keyed per turn so an adopted
  // stream that replaces pending without a null gap restarts the clock.
  useEffect(() => {
    if (!pending) return;
    setElapsed(0);
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.turnId]);

  const send = useCallback(
    async (text: string) => {
      // sendingRef also guards double Enter delivered in one stdin chunk —
      // both submits would otherwise run before pending is set.
      if (!text || pending || sendingRef.current) return;
      setSendError(null);
      setDraft('');
      sendingRef.current = true;
      // Only ids finishing during this send's POST window matter to the guard.
      finishedRef.current.clear();
      try {
        const { turnId } = await api.chatSend({ text });
        adoptedRef.current = turnId;
        // Stream events may have raced ahead of the POST response — keep them,
        // and never resurrect a turn that already finished while we waited.
        setPending((prev) =>
          prev && prev.turnId === turnId ? prev : finishedRef.current.has(turnId) ? prev : newPending(turnId, true),
        );
        void refreshHistory(TAIL_LIMIT); // echo our user turn (persisted before the route returns)
      } catch (err) {
        setSendError(err instanceof Error ? err.message : String(err));
        setDraft(text);
      } finally {
        sendingRef.current = false;
      }
    },
    [api, pending, refreshHistory],
  );

  const runCommand = useCallback(
    async (cmd: Command, arg: string) => {
      setDraft('');
      pushItem({ kind: 'cmd', text: `/${cmd.name}${arg ? ` ${arg}` : ''}` });
      if (arg && !cmd.args) {
        pushItem({
          kind: 'error',
          text: `/${cmd.name} takes no argument — to chat text starting with "/", begin with a space`,
        });
        return;
      }
      setBusyCmd(cmd.name);
      try {
        const res = await cmd.run(api, arg, config.baseUrl);
        if (res.panel) pushItem({ kind: 'panel', panel: res.panel });
        if (res.info) pushItem({ kind: 'info', text: res.info });
        if (res.error) pushItem({ kind: 'error', text: res.error });
        // Seals show as an info line; the seam itself is drawn from the data
        // when the next turn arrives with a fresh sessionId.
        if (res.action === 'seal') pushItem({ kind: 'info', text: 'context sealed — next message starts fresh' });
        if (res.action === 'quit') exit();
      } catch (err) {
        pushItem({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      } finally {
        setBusyCmd(null);
      }
    },
    [api, config.baseUrl, exit, pushItem],
  );

  const submit = useCallback(
    (value: string) => {
      const text = value.trim();
      if (!text) return;
      // Only an unindented "/" is a command — a leading space escapes to chat.
      if (!value.startsWith('/')) {
        void send(text);
        return;
      }
      const parsed = parseSlash(text);
      const cmd = menu.length > 0 ? menu[selected] : resolveCommand(parsed?.name ?? '');
      if (!cmd) {
        setDraft('');
        pushItem({
          kind: 'error',
          text: `unknown command ${text.split(/\s/)[0]} — /help lists them; start with a space to send it as chat`,
        });
        return;
      }
      void runCommand(cmd, parsed?.arg ?? '');
    },
    [menu, pushItem, runCommand, selected, send],
  );

  useInput((_input, key) => {
    if (menuOpen && key.upArrow) setMenuIndex((i) => (i + menu.length - 1) % menu.length);
    else if (menuOpen && key.downArrow) setMenuIndex((i) => (i + 1) % menu.length);
    else if (menuOpen && key.tab) setDraft(`/${menu[selected]?.name ?? ''} `);
    else if (key.escape) {
      // Interrupting the stream wins (and keeps the draft); Esc clears the
      // draft only when nothing is streaming.
      if (pending) void api.chatInterrupt().catch(() => undefined);
      else if (draft) setDraft('');
    }
  });

  const status = [
    `${face(wsStatus)} botty`,
    config.baseUrl.replace(/^https?:\/\//, ''),
    `ws ${wsStatus}`,
    taskCount !== null ? `${taskCount} task${taskCount === 1 ? '' : 's'}` : null,
    approvalIds.size > 0 ? `⧗ ${approvalIds.size} approval${approvalIds.size === 1 ? '' : 's'}` : null,
    busyCmd ? `✳ /${busyCmd}…` : pending ? `✳ ${elapsed}s · esc interrupts` : '/help',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Box flexDirection="column">
      <Static items={items}>
        {(item) => <TranscriptItem key={item.key} item={item} columns={columns} />}
      </Static>
      {pending && <PendingView pending={pending} />}
      {sendError && <Text color="red">✗ {sendError}</Text>}
      <Box borderStyle="round" borderColor={pending ? 'yellow' : 'gray'} paddingX={1}>
        <Text color="magenta" bold>
          ›{' '}
        </Text>
        <TextInput
          value={draft}
          onChange={(v) => {
            setDraft(v);
            setMenuIndex(0);
          }}
          onSubmit={submit}
          placeholder={pending ? 'streaming — Esc to interrupt' : 'message botty, or / for commands'}
        />
      </Box>
      {menuOpen && (
        <Box flexDirection="column" paddingLeft={2}>
          {(() => {
            // Window slides with the selection so the highlighted row is
            // always visible — Enter must never run a hidden command.
            const start = Math.max(0, Math.min(selected - MENU_ROWS + 1, menu.length - MENU_ROWS));
            return menu.slice(start, start + MENU_ROWS).map((c, i) => {
              const isSel = start + i === selected;
              return (
                <Text key={c.name} color={isSel ? 'magenta' : undefined} dimColor={!isSel}>
                  {isSel ? '▸ ' : '  '}
                  {`/${c.name}${c.args ? ` ${c.args}` : ''}`.padEnd(34)}
                  {c.description}
                </Text>
              );
            });
          })()}
          {menu.length > MENU_ROWS && <Text dimColor>  ↑↓ {menu.length} commands</Text>}
        </Box>
      )}
      <Box paddingLeft={1}>
        <Text dimColor>{status}</Text>
      </Box>
    </Box>
  );
}

function TranscriptItem({ item, columns }: { item: Item; columns: number }) {
  switch (item.kind) {
    case 'error':
      return (
        <Box marginBottom={1}>
          <Text color="red">✗ {item.text}</Text>
        </Box>
      );
    case 'info':
      return (
        <Box marginBottom={1}>
          <Text dimColor>· {item.text} ·</Text>
        </Box>
      );
    case 'seam':
      return (
        <Box marginBottom={1}>
          <Text dimColor>{'─'.repeat(Math.max(10, Math.min(columns - 4, 40)))} new context ─────</Text>
        </Box>
      );
    case 'cmd':
      return (
        <Box>
          <Text dimColor>❯ {item.text}</Text>
        </Box>
      );
    case 'panel':
      return <Panel panel={item.panel} columns={columns} />;
    case 'partial':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="magenta" bold>
            botty <Text dimColor>(incomplete)</Text>
          </Text>
          <Box marginLeft={2} flexDirection="column">
            <Text>{renderMarkdown(item.text, columns - 4)}</Text>
            <Text color="red">✗ {item.error}</Text>
          </Box>
        </Box>
      );
    case 'nudge':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="magenta" bold>
            botty <Text color="yellow">✦</Text> <Text dimColor>nudge</Text>
          </Text>
          <Box marginLeft={2} flexDirection="column">
            <Text>{renderMarkdown(item.message, columns - 2)}</Text>
            <Text dimColor>
              {item.nkind}
              {item.score != null ? ` · ${item.score}/10` : ''} — act on it in the web app or just reply here
            </Text>
          </Box>
        </Box>
      );
    case 'approvalPending':
      return (
        <Box marginBottom={1}>
          <Text color="yellow">{item.text}</Text>
        </Box>
      );
    case 'approvalResolved':
      return (
        <Box marginBottom={1}>
          <Text color={APPROVAL_RESOLVED_COLOR[item.status]}>{item.text}</Text>
        </Box>
      );
    case 'turn': {
      const { turn } = item;
      const isUser = turn.role === 'user';
      const quoted = typeof turn.meta?.['quotedPreview'] === 'string' ? (turn.meta['quotedPreview'] as string) : null;
      const attachments = Array.isArray(turn.meta?.['attachments']) ? turn.meta['attachments'].length : 0;
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={isUser ? 'cyan' : 'magenta'} bold>
            {isUser ? 'you' : 'botty'} <Text dimColor>{clock(turn.createdAt)}</Text>
          </Text>
          <Box marginLeft={2} flexDirection="column">
            {quoted && <Text dimColor>↩ {quoted}</Text>}
            {attachments > 0 && (
              <Text dimColor>
                ⧉ {attachments} image{attachments === 1 ? '' : 's'} (view in the web app)
              </Text>
            )}
            <Text>{isUser ? turn.content : renderMarkdown(turn.content, columns - 4)}</Text>
          </Box>
        </Box>
      );
    }
  }
}

function PendingView({ pending }: { pending: PendingTurn }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!pending.thinking) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 100);
    return () => clearInterval(t);
  }, [pending.thinking]);

  const tools = pending.tools.slice(-MAX_TOOL_LINES);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="magenta" bold>
        botty <Text dimColor>now</Text>
      </Text>
      <Box marginLeft={2} flexDirection="column">
        {pending.tools.length > tools.length && (
          <Text dimColor>⚙ … {pending.tools.length - tools.length} earlier tool calls</Text>
        )}
        {tools.map((t, i) => (
          <Text key={`${i}-${t}`} dimColor>
            ⚙ {t}
          </Text>
        ))}
        {pending.text ? (
          <StreamTail text={pending.text} />
        ) : null}
        {pending.thinking && <Text dimColor>{SPINNER[frame]} thinking…</Text>}
      </Box>
    </Box>
  );
}

/**
 * Long streams: rewriting the whole growing block every chunk is O(n²) in
 * terminal output (and Ink can't erase past the screen height) — show the
 * tail; the full reply lands in the transcript on chat.done.
 */
function StreamTail({ text }: { text: string }) {
  const lines = text.split('\n');
  const tail = lines.slice(-MAX_STREAM_LINES);
  return (
    <>
      {lines.length > MAX_STREAM_LINES && <Text dimColor>… {lines.length - MAX_STREAM_LINES} lines above …</Text>}
      <Text>
        {tail.join('\n')}
        <Text dimColor>▍</Text>
      </Text>
    </>
  );
}
