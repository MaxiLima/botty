import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nanoid } from 'nanoid';
import {
  BriefingOutputSchema,
  HEARTBEAT_DEFAULTS,
  type ChatAttachment,
  type ChatTurn,
  type SessionMeta,
} from '@botty/shared';
import type { Bus } from '../bus/index.js';
import { nowIso, type Db } from '../db/index.js';
import { TOOL_TRIGGER_RE } from '../llm/mock.js';
import type { ChatToolSpec, ChatTurnAttachment, LlmClient } from '../llm/types.js';
import type { Memory } from '../memory/index.js';
import type { McpChatToolsProvider } from '../mcp/tools.js';
import { extractCommitments } from './commitments.js';
import { createChatTools } from './tools.js';

export interface ChatMessageOptions {
  /** Inline images (validated by ChatMessageRequestSchema at the route). */
  attachments?: ChatAttachment[];
  /** WhatsApp-style reply: id of the chat turn being quoted. Unknown ids are ignored. */
  quotedTurnId?: string;
}

/** Resolved on-disk attachment, served by GET /api/chat/attachments/:id. */
export interface StoredAttachment {
  filePath: string;
  mimeType: string;
}

export interface Chat {
  /**
   * Persist the user turn and kick off the assistant response (streams over the bus
   * as chat.chunk / chat.thinking / chat.done WS events). Returns immediately with
   * the assistant turn id; `done` resolves when the turn completes (null on error).
   */
  handleUserMessage(
    text: string,
    opts?: ChatMessageOptions,
  ): Promise<{ turnId: string; done: Promise<ChatTurn | null> }>;
  /** Look up a stored attachment by id (null if unknown/malformed). */
  getAttachment(id: string): StoredAttachment | null;
  /** Seal the active session now (fresh-context button). */
  seal(): Promise<void>;
  /** Interrupt the in-flight assistant turn, if any. */
  interrupt(): Promise<void>;
}

/** Turn-row meta entry — binary lives on disk, chat history payloads stay small. */
interface AttachmentMeta {
  id: string;
  mimeType: string;
  name?: string;
  ref: string;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Clip lengths for quoted-reply context: turn meta preview / LLM prompt block. */
const QUOTED_PREVIEW_CHARS = 160;
const QUOTED_PROMPT_CHARS = 300;

/** dbPath is <dataDir>/data/botty.db → attachments live at <dataDir>/attachments. */
function defaultAttachmentsDir(dbPath: string): string {
  if (dbPath === ':memory:') return path.join(os.tmpdir(), 'botty-attachments');
  return path.join(path.dirname(path.dirname(dbPath)), 'attachments');
}

const SEAL_SUMMARY_SYSTEM =
  'You are summarizing a chat session between botty (a personal assistant) and its user for ' +
  'long-term memory. Produce a compact briefing: what was discussed, decisions made, tasks ' +
  'mentioned, and any facts worth remembering. Title = one line; body = a few tight bullets.';

export function createChat(deps: {
  db: Db;
  bus: Bus;
  llm: LlmClient;
  memory: Memory;
  /** Where attachment binaries are written; defaults to <dataDir>/attachments (derived from db path). */
  attachmentsDir?: string;
  /**
   * Heartbeat knobs (session_idle_seal_min, infer_commitments); absent →
   * HEARTBEAT_DEFAULTS. Read per-call so hot reload applies.
   */
  config?: { heartbeat(): { sessionIdleSealMin: number; inferCommitments: boolean } };
  /**
   * External MCP tools (mcp.json), re-derived per turn so a hot mcp.json
   * reload takes effect without a restart. Absent → chat runs with only the
   * four built-ins (tests, or an mcp-less setup).
   */
  mcpTools?: McpChatToolsProvider;
}): Chat {
  const { db, bus, llm, memory } = deps;
  const attachmentsDir = deps.attachmentsDir ?? defaultAttachmentsDir(db.path);
  // Model-callable chat tools (capture_task, task_action, memory_search, session_search).
  const chatTools = createChatTools({ db, memory, bus });
  const idleSealMs = (): number =>
    (deps.config?.heartbeat().sessionIdleSealMin ?? HEARTBEAT_DEFAULTS.sessionIdleSealMin) * 60_000;
  const inferCommitmentsEnabled = (): boolean =>
    deps.config?.heartbeat().inferCommitments ?? HEARTBEAT_DEFAULTS.inferCommitments;
  let activeSessionId: string | null = null;

  /** Write each attachment to <attachmentsDir>/<nanoid>.<ext>; return the meta entries. */
  function saveAttachments(attachments: ChatAttachment[]): AttachmentMeta[] {
    fs.mkdirSync(attachmentsDir, { recursive: true });
    return attachments.map((a) => {
      const id = nanoid();
      const ext = EXT_BY_MIME[a.mimeType] ?? 'bin';
      fs.writeFileSync(path.join(attachmentsDir, `${id}.${ext}`), Buffer.from(a.dataBase64, 'base64'));
      return {
        id,
        mimeType: a.mimeType,
        ...(a.name ? { name: a.name } : {}),
        ref: `/api/chat/attachments/${id}`,
      };
    });
  }

  // Assistant turns run strictly one at a time: concurrent sends would otherwise
  // clobber the SDK's per-session active handle (breaking interrupt) and both
  // resume the same provider session id, forking the conversation history.
  let turnQueue: Promise<unknown> = Promise.resolve();
  function queueTurn<T>(fn: () => Promise<T>): Promise<T> {
    const run = turnQueue.then(fn);
    turnQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** LLM-summarize an already-sealed session into its summary column. */
  async function summarizeSession(session: SessionMeta): Promise<void> {
    const turns = db.turnsForSession(session.id);
    if (turns.length === 0) return;
    let summary: string;
    try {
      const transcript = turns
        .map((t) => `${t.role === 'user' ? 'User' : 'Botty'}: ${t.content}`)
        .join('\n')
        .slice(0, 12_000);
      const out = await llm.structured({
        task: 'seal',
        system: SEAL_SUMMARY_SYSTEM,
        prompt: `Summarize this session:\n\n${transcript}`,
        schema: BriefingOutputSchema,
        relatedRef: session.id,
      });
      summary = `${out.title}\n${out.body}`;
    } catch {
      // Sealing must never block; fall back to a raw snippet.
      const firstUser = turns.find((t) => t.role === 'user');
      summary = `(unsummarized) ${firstUser?.content.slice(0, 200) ?? `${turns.length} turns`}`;
    }
    db.sealSession(session.id, summary);
  }

  function sealSession(session: SessionMeta): void {
    // Flip status first — the single-active-session invariant must never wait on an LLM.
    // Summary is deferred through the turn queue, same as the idle-seal path in
    // ensureSession below, so callers (explicit /api/chat/seal, idle timeout) never
    // block on a `structured` LLM call.
    db.sealSession(session.id, null);
    queueTurn(() => summarizeSession(session)).catch(() => {});
  }

  /** Get the active session, sealing it first (summary fills in async) if it idled out. */
  async function ensureSession(now: string): Promise<SessionMeta> {
    const active = db.activeSession();
    if (active) {
      const idleMs = Date.parse(now) - Date.parse(active.lastActiveAt);
      if (idleMs <= idleSealMs()) return active;
      // Everything from the activeSession() read to createSession() below is
      // synchronous, so a concurrent send can't double-seal or create a second
      // active session. sealSession() defers the LLM summary via the turn queue —
      // it lands before the next assistant turn builds its system prompt — instead
      // of blocking the message POST for the duration of a summarization call.
      sealSession(active);
    }
    return db.createSession();
  }

  async function runAssistant(
    sessionId: string,
    turnId: string,
    input: { text: string; prompt: string; userTurnId: string; attachments?: ChatTurnAttachment[] },
  ): Promise<ChatTurn | null> {
    try {
      // Recall runs before the user turn is FTS-indexed — otherwise the just-sent
      // message is always its own top hit and burns a recall slot every turn.
      const systemPrompt = memory.buildChatSystemPrompt(input.text);
      db.ftsIndex('chat', input.userTurnId, input.text);
      // External MCP tools are re-derived every turn (not cached at startup like
      // chatTools) so a hot mcp.json reload takes effect immediately.
      const externalTools: ChatToolSpec[] = deps.mcpTools ? await deps.mcpTools(input.userTurnId) : [];
      const result = await llm.chatTurn({
        sessionKey: sessionId,
        prompt: input.prompt,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        systemPrompt,
        tools: [...chatTools, ...externalTools],
        onEvent: (e) => {
          if (e.type === 'text') {
            bus.broadcast({ type: 'chat.chunk', payload: { turnId, delta: e.text } });
          } else if (e.type === 'thinking') {
            bus.broadcast({ type: 'chat.thinking', payload: { turnId, on: e.on } });
          } else if (e.type === 'tool_use') {
            bus.broadcast({ type: 'chat.toolUse', payload: { turnId, name: e.name, summary: e.summary } });
          }
        },
      });
      const turn = db.insertChatTurn({
        id: turnId,
        sessionId,
        role: 'assistant',
        content: result.text,
        meta: { usage: result.usage },
      });
      db.ftsIndex('chat', turn.id, result.text);
      db.touchSession(sessionId);
      bus.broadcast({ type: 'chat.done', payload: { turnId, turn } });
      return turn;
    } catch (err) {
      bus.broadcast({ type: 'chat.error', payload: { turnId, error: (err as Error).message } });
      return null;
    }
  }

  return {
    async handleUserMessage(text, opts) {
      const now = nowIso();
      const session = await ensureSession(now);
      activeSessionId = session.id;

      // Quoted reply: look the turn up; unknown ids are silently ignored.
      const quoted = opts?.quotedTurnId ? db.getChatTurn(opts.quotedTurnId) : undefined;
      const attachmentMeta = opts?.attachments?.length ? saveAttachments(opts.attachments) : [];
      const meta: Record<string, unknown> = {};
      if (attachmentMeta.length > 0) meta.attachments = attachmentMeta;
      if (quoted) {
        meta.quotedTurnId = quoted.id;
        meta.quotedPreview = quoted.content.slice(0, QUOTED_PREVIEW_CHARS);
      }

      const userTurn = db.insertChatTurn({
        sessionId: session.id,
        role: 'user',
        content: text,
        meta: Object.keys(meta).length > 0 ? meta : null,
      });
      // FTS indexing happens in runAssistant, after the recall query has run.
      db.touchSession(session.id, now);
      bus.emit('chat.userMessage', { text, at: now });

      const prompt = quoted
        ? `[Replying to earlier message: "${quoted.content.slice(0, QUOTED_PROMPT_CHARS)}"]\n\n${text}`
        : text;
      const attachments = opts?.attachments?.map((a) => ({
        mimeType: a.mimeType,
        dataBase64: a.dataBase64,
      }));

      const turnId = nanoid();
      const done = queueTurn(() =>
        runAssistant(session.id, turnId, { text, prompt, userTurnId: userTurn.id, attachments }),
      );
      // Inferred commitments (feature #2): hidden post-turn extraction over the
      // user's own message. Queued right behind the assistant turn (same turn
      // queue sealSession's summarizeSession uses) so it runs deferred and never
      // blocks the response stream — its own promise is deliberately not
      // returned to the caller. Cost control: at most one extraction call per
      // user turn, skipped on empty turns and on the mock chat's `!tool`
      // trigger (see llm/mock.ts).
      if (inferCommitmentsEnabled() && text.trim() && !TOOL_TRIGGER_RE.test(text.trim())) {
        queueTurn(() => extractCommitments({ db, llm }, { text, sourceTurnId: userTurn.id, now })).catch(
          () => {},
        );
      }
      return { turnId, done };
    },

    getAttachment(id) {
      // nanoid alphabet — also forecloses path traversal.
      if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
      let entries: string[];
      try {
        entries = fs.readdirSync(attachmentsDir);
      } catch {
        return null; // dir not created yet → nothing stored
      }
      const file = entries.find((f) => f.startsWith(`${id}.`));
      if (!file) return null;
      const ext = file.slice(id.length + 1).toLowerCase();
      return {
        filePath: path.resolve(attachmentsDir, file),
        mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream',
      };
    },

    async seal() {
      const active = db.activeSession();
      if (active) sealSession(active);
      activeSessionId = null;
    },

    async interrupt() {
      const sessionId = activeSessionId ?? db.activeSession()?.id;
      if (sessionId) await llm.interrupt(sessionId);
    },
  };
}
