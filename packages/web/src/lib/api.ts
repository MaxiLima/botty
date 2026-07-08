import type {
  AiDecision,
  ChatAttachment,
  CostsReport,
  ChatTurn,
  ConfigFileName,
  Interaction,
  Person,
  ProactiveLogRow,
  Project,
  RawLogRow,
  SessionMeta,
  SourceCheckRow,
  SourceId,
  Task,
  TaskHistory,
  TaskStatus,
  TickLogRow,
} from '@botty/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string | undefined;
  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function req<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body
  }
  if (!res.ok) {
    const err = (json ?? {}) as { error?: string; detail?: string };
    throw new ApiError(res.status, err.error ?? `${res.status} ${res.statusText}`, err.detail);
  }
  return json as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface ChatSendBody {
  text: string;
  quotedTurnId?: string;
  attachments?: ChatAttachment[];
}

export interface TaskActionBody {
  action: 'done' | 'snooze' | 'dismiss' | 'reopen' | 'priority';
  snoozeDays?: number;
  reason?: string;
  priority?: number;
}

export const api = {
  health: () => req<{ ok: boolean; version: string; mode: string; dbPath: string }>('GET', '/api/health'),

  // Chat
  chatHistory: (limit?: number, before?: string) =>
    req<{ turns: ChatTurn[]; sessions: SessionMeta[] }>('GET', `/api/chat/history${qs({ limit, before })}`),
  chatSend: (body: ChatSendBody) => req<{ turnId: string }>('POST', '/api/chat/message', body),
  chatInterrupt: () => req<{ ok: boolean }>('POST', '/api/chat/interrupt', {}),
  chatSeal: () => req<{ ok: boolean }>('POST', '/api/chat/seal', {}),

  // Tasks
  tasks: (status?: TaskStatus) => req<{ tasks: Task[] }>('GET', `/api/tasks${qs({ status })}`),
  task: (id: string) =>
    req<{ task: Task; history: TaskHistory[]; surfaces: ProactiveLogRow[] }>('GET', `/api/tasks/${id}`),
  taskAction: (id: string, body: TaskActionBody) => req<{ task: Task }>('POST', `/api/tasks/${id}/action`, body),

  // People & projects
  people: () => req<{ people: Person[] }>('GET', '/api/people'),
  person: (id: string) =>
    req<{ person: Person; interactions: Interaction[]; tasks: Task[] }>('GET', `/api/people/${id}`),
  mutePerson: (id: string, until: string | null) => req<{ person: Person }>('POST', `/api/people/${id}/mute`, { until }),
  projects: () => req<{ projects: Project[] }>('GET', '/api/projects'),

  // Inspector
  decisions: (opts: { kind?: string; limit?: number; before?: string } = {}) =>
    req<{ decisions: AiDecision[] }>('GET', `/api/decisions${qs(opts)}`),
  ticks: (limit?: number) => req<{ ticks: TickLogRow[] }>('GET', `/api/ticks${qs({ limit })}`),
  tick: (id: string) => req<{ tick: TickLogRow; judgment?: AiDecision }>('GET', `/api/ticks/${id}`),
  rawLog: (opts: { source?: string; limit?: number } = {}) =>
    req<{ events: RawLogRow[] }>('GET', `/api/raw-log${qs(opts)}`),
  sourceChecks: (limit?: number) => req<{ checks: SourceCheckRow[] }>('GET', `/api/source-checks${qs({ limit })}`),

  // Costs
  costs: () => req<{ report: CostsReport }>('GET', '/api/costs'),

  // Config
  config: () => req<{ files: { persona: string; team: string; heartbeat: string } }>('GET', '/api/config'),
  saveConfig: (name: ConfigFileName, content: string) =>
    req<{ ok: boolean; warnings: string[] }>('PUT', `/api/config/${name}`, { content }),

  // Control
  runLoopNow: () => req<{ tickId: string }>('POST', '/api/loop/run-now', {}),
  checkSourceNow: (source: SourceId) => req<{ checkId: string }>('POST', `/api/sources/${source}/check-now`, {}),
  settings: () => req<{ settings: Record<string, unknown> }>('GET', '/api/settings'),
  patchSettings: (patch: Record<string, unknown>) =>
    req<{ settings: Record<string, unknown> }>('PUT', '/api/settings', { patch }),
};
