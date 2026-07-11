import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { ChatAttachment, ChatTurn, PendingAction } from '@botty/shared';
import { api } from '../lib/api.js';
import { Markdown } from '../lib/markdown.js';
import { clock, tryParseJson } from '../lib/format.js';
import { useOnReconnect, useWsEvent } from '../lib/ws.js';
import { JsonViewer } from '../components/JsonViewer.js';
import {
  applyResolvedAction,
  markNotificationsSeen,
  resolveNotification,
  useNotifications,
  usePendingActions,
  type NotificationItem,
} from '../lib/stores.js';
import {
  attachmentDataUrl,
  isSupportedImageType,
  MAX_ATTACHMENTS,
  metaAttachments,
  metaAttachmentSrc,
  prepareImage,
} from '../lib/images.js';
import '../styles/chat.css';

const PAGE_SIZE = 60;
const QUOTE_PREVIEW_CHARS = 120;
/** Foreign-turn adoption only needs the recent tail, not a full page. */
const TAIL_LIMIT = 20;
/** Coalesce back-to-back adoption triggers (chunk/thinking/toolUse for a burst
 * of foreign turns) into a single history refetch. */
const TAIL_DEBOUNCE_MS = 150;

interface PendingTurn {
  turnId: string;
  text: string;
  thinking: boolean;
  tool: string | null;
}

/** A turn that died mid-stream — keep the partial text the user watched. */
interface FailedTurn {
  id: string;
  at: number;
  text: string;
  error: string;
}

interface QuoteState {
  id: string;
  who: 'you' | 'botty';
  text: string;
}

type ThreadItem =
  | { kind: 'turn'; at: number; turn: ChatTurn }
  | { kind: 'seam'; at: number; id: string }
  | { kind: 'notification'; at: number; n: NotificationItem }
  | { kind: 'action'; at: number; a: PendingAction }
  | { kind: 'failure'; at: number; f: FailedTurn };

function truncateOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export function ChatPage() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [failures, setFailures] = useState<FailedTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [localSeams, setLocalSeams] = useState<number[]>([]);
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [images, setImages] = useState<ChatAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const notifications = useNotifications();
  const pendingActions = usePendingActions();

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);
  /** Turns already finished (done/error) — replies can outrun the POST response. */
  const finishedRef = useRef(new Set<string>());
  /** Mirror for event handlers that need the current pending without a stale closure. */
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  /** True while our own POST /chat/message is in flight — its own local turn is
   * already optimistic, so stream events for it don't need a tail refetch. */
  const sendingRef = useRef(false);
  /** Last turnId we already triggered a tail refetch for — avoids a refetch per chunk. */
  const adoptedRef = useRef<string | null>(null);
  const tailDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api.chatHistory(PAGE_SIZE);
      setTurns(res.turns);
      setHasMore(res.turns.length >= PAGE_SIZE);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Pull in the tail without disturbing any earlier pages the user has scrolled
  // to load — merges only turns we don't already know about (dedupe by id).
  const refreshTail = useCallback(async () => {
    try {
      const res = await api.chatHistory(TAIL_LIMIT);
      setTurns((prev) => {
        const known = new Set(prev.map((t) => t.id));
        const fresh = res.turns.filter((t) => !known.has(t.id));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
    } catch {
      // best-effort — the stream events already carry the reply; a failed
      // adoption refetch just means the triggering user turn stays missing.
    }
  }, []);

  const scheduleTailRefetch = useCallback(() => {
    if (tailDebounceRef.current) return;
    tailDebounceRef.current = setTimeout(() => {
      tailDebounceRef.current = null;
      void refreshTail();
    }, TAIL_DEBOUNCE_MS);
  }, [refreshTail]);

  /** A stream event for a turn we didn't start — another client (e.g. the TUI)
   * sent a message. Its user turn never landed here optimistically, so refetch
   * the tail to pull it in; skip if it's our own in-flight send or already known. */
  const adopt = useCallback(
    (turnId: string) => {
      if (adoptedRef.current === turnId) return;
      if (sendingRef.current) return;
      if (pendingRef.current?.turnId === turnId) return;
      if (finishedRef.current.has(turnId)) return;
      adoptedRef.current = turnId;
      scheduleTailRefetch();
    },
    [scheduleTailRefetch],
  );

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(
    () => () => {
      if (tailDebounceRef.current) clearTimeout(tailDebounceRef.current);
    },
    [],
  );

  useOnReconnect(() => {
    setPending(null);
    adoptedRef.current = null;
    if (tailDebounceRef.current) {
      clearTimeout(tailDebounceRef.current);
      tailDebounceRef.current = null;
    }
    void loadHistory();
  });

  // Viewing the chat clears the sidebar badge.
  useEffect(() => {
    markNotificationsSeen();
  }, [notifications.length]);

  // Stream events can outrun the POST response for our own send (or belong to
  // another client entirely) — with no pending yet, adopt the turn instead of
  // dropping the chunk, unless it already finished.
  useWsEvent('chat.chunk', (p) => {
    adopt(p.turnId);
    setPending((prev) => {
      if (prev) return prev.turnId === p.turnId ? { ...prev, text: prev.text + p.delta, thinking: false } : prev;
      if (finishedRef.current.has(p.turnId)) return prev;
      return { turnId: p.turnId, text: p.delta, thinking: false, tool: null };
    });
  });
  useWsEvent('chat.thinking', (p) => {
    adopt(p.turnId);
    setPending((prev) => {
      if (prev) return prev.turnId === p.turnId ? { ...prev, thinking: p.on } : prev;
      if (finishedRef.current.has(p.turnId)) return prev;
      return { turnId: p.turnId, text: '', thinking: p.on, tool: null };
    });
  });
  useWsEvent('chat.toolUse', (p) => {
    adopt(p.turnId);
    const tool = p.summary ? `${p.name} — ${p.summary}` : p.name;
    setPending((prev) => {
      if (prev) return prev.turnId === p.turnId ? { ...prev, tool } : prev;
      if (finishedRef.current.has(p.turnId)) return prev;
      return { turnId: p.turnId, text: '', thinking: false, tool };
    });
  });
  useWsEvent('chat.done', (p) => {
    finishedRef.current.add(p.turnId);
    setPending((prev) => (prev && prev.turnId !== p.turnId ? prev : null));
    setTurns((prev) => (prev.some((t) => t.id === p.turn.id) ? prev : [...prev, p.turn]));
  });
  useWsEvent('chat.error', (p) => {
    finishedRef.current.add(p.turnId);
    // pendingRef, not `pending`: a chunk and its error can land in one batch,
    // and the closure would still see the pre-chunk state.
    const prev = pendingRef.current;
    const text = prev && prev.turnId === p.turnId ? prev.text : '';
    setFailures((list) =>
      list.some((f) => f.id === p.turnId) ? list : [...list, { id: p.turnId, at: Date.now(), text, error: p.error }],
    );
    // Clear pending so the composer unlocks — the agent never sends a
    // chat.done after chat.error, and Stop is a no-op with no active run.
    setPending((cur) => (cur && cur.turnId !== p.turnId ? cur : null));
  });

  const thread = useMemo<ThreadItem[]>(() => {
    const items: ThreadItem[] = [];
    let prevSession: string | null = null;
    for (const turn of turns) {
      const at = new Date(turn.createdAt).getTime() || 0;
      if (prevSession !== null && turn.sessionId !== prevSession) {
        items.push({ kind: 'seam', at, id: `seam-${turn.id}` });
      }
      prevSession = turn.sessionId;
      items.push({ kind: 'turn', at, turn });
    }
    for (const n of notifications) {
      items.push({ kind: 'notification', at: new Date(n.receivedAt).getTime() || Date.now(), n });
    }
    for (const a of pendingActions) {
      items.push({ kind: 'action', at: new Date(a.createdAt).getTime() || Date.now(), a });
    }
    for (const f of failures) {
      items.push({ kind: 'failure', at: f.at, f });
    }
    for (const at of localSeams) {
      items.push({ kind: 'seam', at, id: `seam-local-${at}` });
    }
    return items.sort((a, b) => a.at - b.at);
  }, [turns, notifications, pendingActions, failures, localSeams]);

  const turnsById = useMemo(() => new Map(turns.map((t) => [t.id, t])), [turns]);
  const findTurn = useCallback((id: string) => turnsById.get(id), [turnsById]);

  // Autoscroll while the user is near the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [thread, pending?.text, pending?.thinking, pending?.tool]);

  // Esc closes the lightbox.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const loadEarlier = async () => {
    const oldest = turns[0];
    if (!oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const res = await api.chatHistory(PAGE_SIZE, oldest.createdAt, oldest.id);
      setHasMore(res.turns.length >= PAGE_SIZE);
      setTurns((prev) => {
        const known = new Set(prev.map((t) => t.id));
        return [...res.turns.filter((t) => !known.has(t.id)), ...prev];
      });
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const startReply = useCallback((q: QuoteState) => {
    setQuote(q);
    composerRef.current?.focus();
  }, []);

  const addImages = async (files: File[]) => {
    setSendError(null);
    for (const file of files) {
      try {
        const img = await prepareImage(file);
        setImages((prev) => {
          if (prev.length >= MAX_ATTACHMENTS) {
            setSendError(`max ${MAX_ATTACHMENTS} images per message`);
            return prev;
          }
          return [...prev, img];
        });
      } catch (err) {
        setSendError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && isSupportedImageType(it.type))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    void addImages(files);
  };

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    setDragOver(true);
  };

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => isSupportedImageType(f.type));
    if (files.length > 0) void addImages(files);
  };

  const send = async () => {
    const text = draft.trim();
    const attachments = images;
    const quoted = quote;
    if ((!text && attachments.length === 0) || pending) return;
    let outText = text || '(image)';
    setSendError(null);
    setDraft('');
    setImages([]);
    setQuote(null);
    const now = new Date().toISOString();
    // The agent resolves quotedTurnId against chat_turns only — notification
    // ids and optimistic local-* ids are unknown to it and would be silently
    // dropped. For those, embed the snippet in the text so the context lands.
    const quotedIsReal = quoted !== null && !quoted.id.startsWith('local-') && turnsById.has(quoted.id);
    const meta: Record<string, unknown> = {};
    if (quoted) {
      if (quotedIsReal) {
        meta.quotedTurnId = quoted.id;
        meta.quotedPreview = truncateOneLine(quoted.text, QUOTE_PREVIEW_CHARS);
      } else {
        outText = `[Replying to earlier message: "${truncateOneLine(quoted.text, QUOTE_PREVIEW_CHARS)}"]\n\n${outText}`;
      }
    }
    if (attachments.length > 0) meta.attachments = attachments;
    const localTurn: ChatTurn = {
      id: `local-${Date.now()}`,
      sessionId: turns[turns.length - 1]?.sessionId ?? 'local',
      role: 'user',
      content: outText,
      meta: Object.keys(meta).length > 0 ? meta : null,
      createdAt: now,
    };
    setTurns((prev) => [...prev, localTurn]);
    stickToBottom.current = true;
    // Only ids finishing during this send's POST window matter to the guard.
    finishedRef.current.clear();
    sendingRef.current = true;
    try {
      const { turnId } = await api.chatSend({
        text: outText,
        quotedTurnId: quoted && quotedIsReal ? quoted.id : undefined,
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      // Stream events may have raced ahead of the POST response — keep them,
      // and never resurrect a turn that already finished while we waited.
      setPending((prev) =>
        prev && prev.turnId === turnId
          ? prev
          : finishedRef.current.has(turnId)
            ? prev
            : { turnId, text: '', thinking: true, tool: null },
      );
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
      setDraft(text);
      setImages(attachments);
      setQuote(quoted);
      setTurns((prev) => prev.filter((t) => t.id !== localTurn.id));
    } finally {
      sendingRef.current = false;
    }
  };

  const stop = async () => {
    try {
      await api.chatInterrupt();
    } catch {
      // agent will emit chat.error / chat.done regardless
    }
  };

  const freshContext = async () => {
    try {
      await api.chatSeal();
      setLocalSeams((prev) => [...prev, Date.now()]);
      composerRef.current?.focus();
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  };

  const onComposerKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const canSend = Boolean(draft.trim()) || images.length > 0;

  return (
    <div className="chat-page">
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-thread">
          {hasMore && (
            <button className="load-earlier" onClick={() => void loadEarlier()} disabled={loadingEarlier}>
              {loadingEarlier ? 'loading…' : '↑ load earlier'}
            </button>
          )}
          {thread.map((item) => {
            if (item.kind === 'seam') return <SessionSeam key={item.id} />;
            if (item.kind === 'failure') return <FailedRow key={`f-${item.f.id}`} f={item.f} />;
            if (item.kind === 'notification')
              return <NudgeRow key={`n-${item.n.id}`} n={item.n} onReply={startReply} />;
            if (item.kind === 'action') return <ApprovalCard key={`a-${item.a.id}`} a={item.a} />;
            return (
              <TurnRow
                key={item.turn.id}
                turn={item.turn}
                findTurn={findTurn}
                onReply={startReply}
                onOpenImage={setLightbox}
              />
            );
          })}
          {pending && <PendingRow pending={pending} />}
          {thread.length === 0 && !pending && (
            <div className="chat-empty">
              <div className="chat-empty-mark">◍</div>
              <p>No conversation yet. Say something — botty remembers.</p>
            </div>
          )}
        </div>
      </div>

      <div
        className={`composer ${dragOver ? 'drag-over' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {sendError && <div className="composer-error">{sendError}</div>}
        {quote && (
          <div className="composer-quote">
            <div className="composer-quote-body">
              <span className="composer-quote-who">{quote.who}</span>
              <span className="composer-quote-text">{truncateOneLine(quote.text, QUOTE_PREVIEW_CHARS)}</span>
            </div>
            <button className="composer-quote-x" title="clear quote" onClick={() => setQuote(null)}>
              ✕
            </button>
          </div>
        )}
        {images.length > 0 && (
          <div className="attach-chips">
            {images.map((img, i) => (
              <div className="attach-chip" key={`${img.name ?? 'img'}-${i}`}>
                <img src={attachmentDataUrl(img)} alt={img.name ?? `image ${i + 1}`} />
                <button
                  className="attach-chip-x"
                  title="remove image"
                  onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
          <textarea
            ref={composerRef}
            className="composer-input"
            placeholder="Message botty — Enter to send, Shift+Enter for newline, paste/drop images"
            value={draft}
            rows={Math.min(8, Math.max(1, draft.split('\n').length))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onComposerKey}
            onPaste={onPaste}
            autoFocus
          />
          <div className="composer-actions">
            {pending ? (
              <button className="btn btn-stop" onClick={() => void stop()} title="Interrupt the streaming reply">
                ■ Stop
              </button>
            ) : (
              <button className="btn btn-send" onClick={() => void send()} disabled={!canSend}>
                Send ⏎
              </button>
            )}
            <button
              className="btn btn-ghost"
              onClick={() => void freshContext()}
              title="Seal the current session and start with fresh context"
            >
              ✦ fresh context
            </button>
          </div>
        </div>
      </div>

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="attachment full size" />
        </div>
      )}
    </div>
  );
}

function SessionSeam() {
  return (
    <div className="session-seam" role="separator">
      <span>· new context ·</span>
    </div>
  );
}

function QuotedSnippet({ who, text }: { who: string | null; text: string }) {
  return (
    <div className="quoted">
      {who && <span className="quoted-who">{who}</span>}
      <span className="quoted-text">{truncateOneLine(text, QUOTE_PREVIEW_CHARS)}</span>
    </div>
  );
}

function TurnRow({
  turn,
  findTurn,
  onReply,
  onOpenImage,
}: {
  turn: ChatTurn;
  findTurn: (id: string) => ChatTurn | undefined;
  onReply: (q: QuoteState) => void;
  onOpenImage: (src: string) => void;
}) {
  const meta = turn.meta ?? {};
  const quotedId = typeof meta['quotedTurnId'] === 'string' ? meta['quotedTurnId'] : null;
  const quotedPreview = typeof meta['quotedPreview'] === 'string' ? meta['quotedPreview'] : null;
  const source = quotedId ? findTurn(quotedId) : undefined;
  const quoted = source
    ? { who: source.role === 'user' ? 'you' : 'botty', text: source.content }
    : quotedPreview
      ? { who: null, text: quotedPreview }
      : null;
  const attachments = turn.role === 'user' ? metaAttachments(turn.meta) : [];

  return (
    <div className={`turn turn-${turn.role}`}>
      <div className="turn-gutter">
        <span className="turn-who">{turn.role === 'user' ? 'you' : 'botty'}</span>
        <span className="turn-time" title={turn.createdAt}>
          {clock(turn.createdAt)}
        </span>
      </div>
      <div className="turn-body">
        {quoted && <QuotedSnippet who={quoted.who} text={quoted.text} />}
        {attachments.length > 0 && (
          <div className="turn-attachments">
            {attachments.map((a, i) => {
              const src = metaAttachmentSrc(a);
              if (!src) return null;
              return (
                <button
                  key={`${turn.id}-att-${i}`}
                  className="turn-img-btn"
                  title="view full size"
                  onClick={() => onOpenImage(src)}
                >
                  <img className="turn-img" src={src} alt={a.name ?? `attachment ${i + 1}`} />
                </button>
              );
            })}
          </div>
        )}
        {turn.role === 'assistant' ? <Markdown source={turn.content} /> : <p className="user-text">{turn.content}</p>}
      </div>
      <button
        className="turn-reply"
        title="reply"
        onClick={() =>
          onReply({ id: turn.id, who: turn.role === 'user' ? 'you' : 'botty', text: turn.content })
        }
      >
        ↩ reply
      </button>
    </div>
  );
}

function PendingRow({ pending }: { pending: PendingTurn }) {
  return (
    <div className="turn turn-assistant turn-pending">
      <div className="turn-gutter">
        <span className="turn-who">botty</span>
        <span className="turn-time">now</span>
      </div>
      <div className="turn-body">
        {pending.text && <Markdown source={pending.text} />}
        <div className="presence-row">
          {pending.thinking && (
            <span className="presence-pill">
              <span className="pulse" /> thinking
            </span>
          )}
          {pending.tool && (
            <span className="presence-pill presence-tool">
              <span className="pulse" /> {pending.tool}
            </span>
          )}
          {!pending.thinking && !pending.tool && <span className="stream-caret">▍</span>}
        </div>
      </div>
    </div>
  );
}

/** A reply that died mid-stream: the partial text the user watched, plus the error. */
function FailedRow({ f }: { f: FailedTurn }) {
  return (
    <div className="turn turn-assistant">
      <div className="turn-gutter">
        <span className="turn-who">botty</span>
        <span className="turn-time">{clock(new Date(f.at).toISOString())}</span>
      </div>
      <div className="turn-body">
        {f.text && <Markdown source={f.text} />}
        <div className="turn-error">✗ {f.error}</div>
      </div>
    </div>
  );
}

/**
 * A proactive notification rendered as a plain assistant message — botty
 * talking, not a widget. Kind + score live in the action row's tooltip.
 */
function NudgeRow({ n, onReply }: { n: NotificationItem; onReply: (q: QuoteState) => void }) {
  const [busy, setBusy] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tooltip = `${n.kind}${n.score != null ? ` · ${n.score}/10` : ''}`;

  const act = async (
    resolved: NonNullable<NotificationItem['resolved']>,
    body: Parameters<typeof api.taskAction>[1],
  ) => {
    if (!n.taskId) return;
    setBusy(true);
    setError(null);
    try {
      await api.taskAction(n.taskId, body);
      resolveNotification(n.id, resolved);
      setDismissing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmDismiss = () => void act('dismissed', { action: 'dismiss', reason: reason.trim() || undefined });

  return (
    <div className="turn turn-assistant turn-nudge">
      <div className="turn-gutter">
        <span className="turn-who">botty</span>
        <span className="turn-time" title={n.receivedAt}>
          {clock(n.receivedAt)}
        </span>
      </div>
      <div className="turn-body">
        <Markdown source={n.message} />
        {n.taskId && !n.resolved && n.kind === 'auto_resolve' && (
          <div className="nudge-actions" title={tooltip}>
            <button
              className="nudge-act"
              disabled={busy}
              onClick={() => void act('reopened', { action: 'reopen' })}
            >
              ↩ reopen
            </button>
          </div>
        )}
        {n.taskId && !n.resolved && n.kind !== 'auto_resolve' && !dismissing && (
          <div className="nudge-actions" title={tooltip}>
            <button className="nudge-act" disabled={busy} onClick={() => void act('done', { action: 'done' })}>
              ✓ done
            </button>
            <span className="nudge-sep">·</span>
            <button
              className="nudge-act"
              disabled={busy}
              onClick={() => void act('snoozed', { action: 'snooze', snoozeDays: 3 })}
            >
              ⏰ snooze 3d
            </button>
            <span className="nudge-sep">·</span>
            <button className="nudge-act" disabled={busy} onClick={() => setDismissing(true)}>
              ✕ dismiss
            </button>
          </div>
        )}
        {n.taskId && !n.resolved && dismissing && (
          <div className="nudge-dismiss" title={tooltip}>
            <input
              className="nudge-reason"
              placeholder="why dismiss? (recorded)"
              value={reason}
              autoFocus
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) confirmDismiss();
                if (e.key === 'Escape') setDismissing(false);
              }}
            />
            <button className="nudge-act" disabled={busy} onClick={confirmDismiss}>
              confirm
            </button>
            <span className="nudge-sep">·</span>
            <button className="nudge-act" disabled={busy} onClick={() => setDismissing(false)}>
              cancel
            </button>
          </div>
        )}
        {n.resolved && (
          <div className="nudge-state" title={tooltip}>
            {n.resolved === 'done' ? 'done ✓' : n.resolved}
          </div>
        )}
        {error && <div className="turn-error">✗ {error}</div>}
      </div>
      <button
        className="turn-reply"
        title="reply"
        onClick={() => onReply({ id: n.id, who: 'botty', text: n.message })}
      >
        ↩ reply
      </button>
    </div>
  );
}

/** Short human-readable snippet from a result/error JSON blob, for the resolved outcome line. */
function jsonSnippet(raw: string | null, max = 200): string {
  if (!raw) return '';
  const value = tryParseJson(raw);
  const text =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'error' in (value as Record<string, unknown>)
        ? String((value as Record<string, unknown>).error)
        : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A pending or resolved consent-gated external tool call — the model
 * proposed it (e.g. slack · send_message) but nothing ran until the user
 * approves. Distinct styling from nudges: this is a permission gate, not a
 * proactive FYI.
 */
function ApprovalCard({ a }: { a: PendingAction }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const argsPretty = useMemo(() => {
    const value = tryParseJson(a.argsJson);
    try {
      return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    } catch {
      return a.argsJson;
    }
  }, [a.argsJson]);
  const argsLong = argsPretty.length > 160 || argsPretty.split('\n').length > 4;

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const { action } = await api.approveAction(a.id);
      applyResolvedAction(action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    setError(null);
    try {
      const { action } = await api.dismissAction(a.id);
      applyResolvedAction(action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`turn turn-assistant turn-approval turn-approval-${a.status}`}>
      <div className="turn-gutter">
        <span className="turn-who">botty</span>
        <span className="turn-time" title={a.createdAt}>
          {clock(a.createdAt)}
        </span>
      </div>
      <div className="turn-body">
        <div className="approval-head">
          <span className="approval-badge">⚠ approval needed</span>
          <span className="approval-target">
            {a.server} · {a.tool}
          </span>
        </div>
        <p className="approval-summary">{a.summary}</p>
        {argsLong ? (
          <JsonViewer data={argsPretty} label="arguments" />
        ) : (
          <pre className="approval-args-inline">{argsPretty}</pre>
        )}
        {a.status === 'pending' && (
          <div className="approval-actions">
            <button className="btn btn-approve" disabled={busy} onClick={() => void approve()}>
              {busy ? '…' : '✓ approve'}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void dismiss()}>
              {busy ? '…' : '✕ dismiss'}
            </button>
          </div>
        )}
        {a.status === 'executed' && (
          <div className="approval-outcome approval-outcome-ok">
            ✓ executed{a.resultJson ? ` — ${jsonSnippet(a.resultJson)}` : ''}
          </div>
        )}
        {a.status === 'failed' && (
          <div className="approval-outcome approval-outcome-error">
            ✗ failed{a.resultJson ? ` — ${jsonSnippet(a.resultJson)}` : ''}
          </div>
        )}
        {a.status === 'dismissed' && <div className="approval-outcome approval-outcome-muted">dismissed</div>}
        {a.status === 'expired' && <div className="approval-outcome approval-outcome-muted">expired</div>}
        {error && <div className="turn-error">✗ {error}</div>}
      </div>
    </div>
  );
}
