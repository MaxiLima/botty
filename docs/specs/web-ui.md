# Web UI — @botty/web

React 18 + Vite + TypeScript. Built to `packages/web/dist`, served statically by the agent at
`/`. Dev mode: `vite dev` on 5173 proxying `/api` and `/ws` to 4820. No UI framework — hand-rolled
components with CSS (dark theme); state via plain hooks + a small WS store (no Redux).

Read the frontend-design guidance before building: dark-only, violet accent (#7C3AED family),
bg #0F0F11 / surface #161618, Inter is banned per house rules — pick a distinctive sans, keep it
consistent. Density over whitespace; this is a power tool.

## Shell

Left sidebar (200px): Chat · Tasks · People · Inspector · Config. Badge on Tasks (open count)
and on Chat (unseen notifications). WS connection status dot. All data types and API calls come
from `@botty/shared` (`api.ts` schemas) — no locally redefined shapes.

## Pages

### Chat
Single continuous thread. Renders `chat_turns` history (paginated "load earlier"), streaming
assistant turn from `chat.chunk` events, thinking/tool presence pill, markdown rendering
(headings, lists, code, bold/italic — a tiny renderer or `marked` + sanitize). Session seams
render as subtle "· new context ·" dividers. **Proactive notifications render in-thread as
cards**: message, score chip, and Done / Snooze 3d / Dismiss buttons (dismiss opens a reason
input) wired to `POST /api/tasks/:id/action`. Composer: multiline, Enter sends, Shift+Enter
newline, Stop button while streaming (`/api/chat/interrupt`), "fresh context" button
(`/api/chat/seal`).

### Tasks
Three columns: Open · Snoozed · Done (this week). Cards: description, requester, source icon,
priority, age, due date. Click ⇒ detail drawer: history timeline, past surfaces + responses,
action buttons. Live via `tasks.updated`.

### People
Table/list: name, weight/tier chip, cadence, last interaction, open task count, mute button.
Detail drawer: recent interactions, open tasks. Promotion candidates (frequent unknowns)
section at bottom.

### Inspector (the debugging heart — invest here)
Tabs:
- **Funnel**: raw_log events newest-first with funnel outcome chips (EXTRACTED / NO_SIGNAL /
  CLASSIFIED_OUT / INTERACTION_ONLY / DUPLICATE); click ⇒ full event JSON + linked ai_decisions
  (classifier/extractor prompt+output, expandable).
- **Ticks**: tick list (trigger, candidates in → after rules, actions count); click ⇒ rules-filter
  rejection log, judgment prompt + full reasoning + per-task scores.
- **Decisions**: raw ai_decisions browser filterable by kind, with prompt/output JSON viewers.
- **Sources**: source_check_log table + check-now buttons per source.

### Config
One editor per file (persona/team/heartbeat): textarea (monospace) + Save with validation
warnings surfaced; last-loaded timestamp; `config.changed` WS refreshes.

## WS store

One module: connects, dispatches events to per-page subscribers, exposes `useWsEvent(type, cb)`
and connection state; auto-reconnect with backoff, refetch-on-reconnect hooks per page.
