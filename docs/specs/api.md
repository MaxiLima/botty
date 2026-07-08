# Agent ↔ Web API contract

Served by `@botty/agent` on `http://localhost:4820`. All request/response bodies and WS events
are zod schemas in `packages/shared/src/api.ts` — the web app imports the same schemas. JSON is
camelCase everywhere.

## REST

```
GET  /api/health                → { ok, version, mode, dbPath }

# Chat
GET  /api/chat/history?limit=&before=   → { turns: ChatTurn[], sessions: SessionMeta[] }
POST /api/chat/message          { text, attachments? (image blocks, max 4), quotedTurnId? }
                                → { turnId }             (response streams over WS)
GET  /api/chat/attachments/:id  → attachment binary (Content-Type = stored mime)
POST /api/chat/interrupt        {} → { ok }
POST /api/chat/seal             {} → { ok }              (fresh-context button)

# Tasks
GET  /api/tasks?status=         → { tasks: Task[] }      (Task includes requesterName, projectName)
GET  /api/tasks/:id             → { task, history: TaskHistory[], surfaces: ProactiveLogRow[] }
POST /api/tasks/:id/action      { action: 'done'|'snooze'|'dismiss'|'reopen'|'priority',
                                  snoozeDays?, reason?, priority? } → { task }

# People & projects
GET  /api/people                → { people: Person[] }   (with openTaskCount, lastInteractionAt)
GET  /api/people/:id            → { person, interactions: Interaction[], tasks: Task[] }
POST /api/people/:id/mute       { until } → { person }
GET  /api/projects              → { projects: Project[] }

# Inspector
GET  /api/decisions?kind=&limit=&before= → { decisions: AiDecision[] }   (input/output JSON included)
GET  /api/ticks?limit=          → { ticks: TickLogRow[] }
GET  /api/ticks/:id             → { tick, judgment?: AiDecision }
GET  /api/raw-log?source=&limit= → { events: RawLogRow[] }   (rows carry optional `outcome` — funnel verdict from body.meta.funnelOutcome)
GET  /api/source-checks?limit=  → { checks: SourceCheckRow[] }

# Config
GET  /api/config                → { files: { persona, team, heartbeat } }   (raw markdown)
PUT  /api/config/:name          { content } → { ok, warnings: string[] }    (name ∈ persona|team|heartbeat)

# Control
POST /api/loop/run-now          {} → { tickId }
POST /api/loop/sweep-now        {} → { result }          (resolution sweep, bypasses working hours)
POST /api/sources/:source/check-now {} → { checkId }
POST /api/notifications/test    {} → { ok, id }          (canned WS card + macOS banner)
GET  /api/settings              → { settings }           PUT /api/settings { patch } → { settings }
```

Errors: non-2xx with `{ error: string, detail?: string }`.

Access: the server binds 127.0.0.1 and is unauthenticated (single local user by design), but
loopback alone doesn't stop browsers — `server/guards.ts` rejects requests whose Host header
isn't loopback (DNS-rebinding guard) and WS upgrades with a non-local Origin (absent Origin,
e.g. TUI/curl, is allowed).

## WebSocket — `ws://localhost:4820/ws`

Server→client events, envelope `{ type: string, payload: object }`:

| type | payload | when |
|---|---|---|
| `chat.chunk` | `{ turnId, delta }` | streaming assistant text |
| `chat.thinking` | `{ turnId, on: boolean }` | presence indicator |
| `chat.toolUse` | `{ turnId, name, summary }` | SDK tool activity |
| `chat.done` | `{ turnId, turn: ChatTurn }` | turn complete |
| `chat.error` | `{ turnId, error }` | |
| `tasks.updated` | `{ tasks: Task[] }` | any task write (full refreshed open board) |
| `notification` | `{ id, taskId?, kind, message, score? }` | proactive surface / briefing |
| `tick.completed` | `{ tick: TickLogRow }` | after each loop tick |
| `source.checked` | `{ check: SourceCheckRow }` | after each source poll |
| `decision.recorded` | `{ decision: AiDecisionSummary }` | ai_decisions insert (summary, not full JSON) |
| `config.changed` | `{ name }` | hot reload fired |

Client→server messages: none (all client actions go over REST). On WS connect the server pushes a
`tasks.updated` snapshot. Reconnect: client retries with backoff; missed events are recovered by
refetching REST state (no replay buffer in v1).
