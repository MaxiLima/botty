import { COMMITMENT_SYSTEM_MARKER } from '../chat/commitments.js';
import type { Db } from '../db/index.js';
import type {
  ChatTurnRequest,
  ChatTurnResult,
  DecisionRecorder,
  LlmClient,
  ModelResolver,
  StructuredRequest,
} from './types.js';

/**
 * Heuristic signal regexes (mirrors the funnel's step-3 gate — see specs/ingestion.md).
 * The mock classifier says "worth extracting" iff any of these match.
 */
export const MOCK_SIGNAL_REGEXES: RegExp[] = [
  // task signals
  /can you/i,
  /\bplease\b/i,
  /\?/,
  /\bby (mon|tue|wed|thu|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  /blocked on/i,
  /waiting on/i,
  /remind me/i,
  /follow up/i,
  /\basap\b/i,
  /before the meeting/i,
  // decision signals
  /we decided/i,
  /going with/i,
  /agreed to/i,
  /\bapproved\b/i,
  /signed off/i,
  // commitment signals
  /\bi'?ll\b/i,
  /\bi will\b/i,
  /on my list/i,
  /\bi own\b/i,
];

/** Mirrors the response tracker's completion vocabulary (loop/response-tracker.ts). */
export const MOCK_COMPLETION_RE =
  /\b(done|finished|completed|shipped|resolved|closed|merged|sent|deployed|hecho|hecha|listo|lista|terminado|terminada)\b|ya\s+est[aá]/i;

/**
 * Convention: callers of `structured()` that want deterministic mock behavior should
 * include `TEXT: <message text>` and `ACTOR: <name>` lines in the prompt. Falls back
 * to treating the whole prompt as the text.
 */
function extractLine(prompt: string, label: string): string | undefined {
  const m = prompt.match(new RegExp(`^${label}:\\s*(.+)$`, 'mi'));
  return m?.[1]?.trim();
}

/** `!tool <name> <json-args>` — the mock chat's deterministic tool trigger. */
export const TOOL_TRIGGER_RE = /^!tool\s+([\w-]+)(?:\s+([\s\S]+))?$/;

/**
 * Commitment-pass extraction (chat/commitments.ts): the commitment system prompt
 * carries COMMITMENT_SYSTEM_MARKER so this mock can tell it apart from the
 * funnel's task/decision extractor, which shares the same `extraction` LlmTask.
 * Deterministic convention: scan the prompt for explicit
 * `[[commitment: <description> | <ISO due date>]]` markers; anything else (the
 * common case) yields an empty commitments array.
 */
const COMMITMENT_MARKER_RE = /\[\[commitment:\s*([^|]+?)\s*\|\s*([^\]]+?)\s*\]\]/gi;

function parseMockCommitments(prompt: string): { description: string; dueAt: string }[] {
  return [...prompt.matchAll(COMMITMENT_MARKER_RE)]
    .map((m) => ({ description: m[1]!.trim(), dueAt: m[2]!.trim() }))
    .filter((c) => c.description.length > 0 && !Number.isNaN(Date.parse(c.dueAt)));
}

/**
 * If the prompt is a `!tool` trigger, run the matching chat tool for real
 * (tool_use event + handler + result echo) and return the reply text.
 * Returns null when the prompt isn't a trigger.
 */
async function maybeRunToolTrigger(req: ChatTurnRequest): Promise<string | null> {
  const m = req.prompt.trim().match(TOOL_TRIGGER_RE);
  if (!m) return null;
  const name = m[1]!;
  const spec = req.tools?.find((t) => t.name === name);
  if (!spec) {
    return `[mock] unknown tool: ${name} (available: ${(req.tools ?? []).map((t) => t.name).join(', ') || 'none'})`;
  }
  let args: Record<string, unknown>;
  try {
    args = m[2] ? (JSON.parse(m[2]) as Record<string, unknown>) : {};
  } catch {
    return `[mock] bad tool args (not JSON): ${m[2]}`;
  }
  req.onEvent({ type: 'tool_use', name: spec.name, summary: spec.summarize(args) });
  const result = await spec.execute(args);
  return `[mock] ${name} → ${JSON.stringify(result)}`;
}

/** Deterministic canned LLM for tests and BOTTY_MOCK_LLM=1. */
export class MockLlmClient implements LlmClient {
  constructor(
    private readonly deps: {
      db: Db;
      modelFor: ModelResolver;
      record: DecisionRecorder;
    },
  ) {}

  async chatTurn(req: ChatTurnRequest): Promise<ChatTurnResult> {
    const model = this.deps.modelFor('chat');
    const n = req.attachments?.length ?? 0;
    const ack = n > 0 ? `(${n} image${n === 1 ? '' : 's'}) ` : '';
    // Deterministic tool trigger for e2e verification: `!tool <name> <json-args>`
    // emits a tool_use event, runs the REAL tool handler, and echoes the result JSON.
    const toolText = await maybeRunToolTrigger(req);
    const text = toolText ?? `[mock] ${ack}${req.prompt}`;
    req.onEvent({ type: 'thinking', on: true });
    req.onEvent({ type: 'thinking', on: false });
    // Stream in two chunks so the WS path is exercised.
    const mid = Math.ceil(text.length / 2);
    req.onEvent({ type: 'text', text: text.slice(0, mid) });
    req.onEvent({ type: 'text', text: text.slice(mid) });
    req.onEvent({ type: 'done' });
    const providerSessionId = `mock-${req.sessionKey}`;
    this.deps.db.setProviderSessionId(req.sessionKey, providerSessionId);
    this.deps.record({
      kind: 'chat_turn',
      input: { prompt: req.prompt },
      output: { text },
      model,
      latencyMs: 0,
      relatedRef: req.sessionKey,
    });
    return { text, providerSessionId, usage: { inputTokens: 0, outputTokens: 0 } };
  }

  async structured<T>(req: StructuredRequest<T>): Promise<T> {
    const model = this.deps.modelFor(req.task);
    const text = extractLine(req.prompt, 'TEXT') ?? req.prompt;
    const actor = extractLine(req.prompt, 'ACTOR');

    let candidate: unknown;
    switch (req.task) {
      case 'classification': {
        const worth = MOCK_SIGNAL_REGEXES.some((r) => r.test(text));
        candidate = {
          worthExtracting: worth,
          confidence: worth ? 0.9 : 0.1,
          reason: worth ? '[mock] heuristic signal matched' : '[mock] no signal',
        };
        break;
      }
      case 'extraction':
        // Same LlmTask, two call sites — the commitment pass carries a marker
        // in its system prompt (see chat/commitments.ts) since its output shape
        // ({ commitments }) differs entirely from the funnel's ({ tasks, ... }).
        candidate = req.system.includes(COMMITMENT_SYSTEM_MARKER)
          ? { commitments: parseMockCommitments(req.prompt) }
          : {
              tasks: [
                {
                  description: text.slice(0, 120),
                  ...(actor ? { requesterName: actor } : {}),
                },
              ],
              decisions: [],
              people: [],
            };
        break;
      case 'judgment':
        candidate = { tickReasoning: '[mock] skip everything', actions: [], skipped: [] };
        break;
      case 'resolution': {
        // Deterministic sweep behavior: resolved iff any thread EVENT: line
        // (buildResolutionPrompt convention) carries a completion phrase.
        const events = req.prompt.match(/^EVENT:.*$/gm) ?? [];
        const done = events.some((line) => MOCK_COMPLETION_RE.test(line));
        candidate = {
          resolved: done,
          confidence: done ? 0.9 : 0.1,
          reason: done ? '[mock] completion phrase in thread' : '[mock] no completion evidence',
        };
        break;
      }
      case 'briefing':
        candidate = { title: '[mock] Briefing', body: '[mock] Nothing to report.' };
        break;
      case 'seal':
        candidate = { title: '[mock] Session summary', body: '[mock] Nothing to report.' };
        break;
    }

    const value = req.schema.parse(candidate);
    this.deps.record({
      kind: req.task,
      input: { system: req.system, prompt: req.prompt },
      output: value,
      model,
      latencyMs: 0,
      relatedRef: req.relatedRef ?? null,
    });
    return value;
  }

  async interrupt(_sessionKey: string): Promise<void> {
    // nothing to interrupt
  }
}
