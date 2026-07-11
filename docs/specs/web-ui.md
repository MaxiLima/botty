# Web UI — @botty/web

React 18 + Vite + TypeScript. Built to `packages/web/dist`, served statically by the agent at
`/`. Dev mode: `vite dev` on 5173 proxying `/api` and `/ws` to 4820. No UI framework — hand-rolled
components with CSS (dark theme); state via plain hooks + a small WS store (no Redux).

Read the frontend-design guidance before building: dark-only, violet accent (#7C3AED family),
bg #0F0F11 / surface #161618, Inter is banned per house rules — pick a distinctive sans, keep it
consistent. Density over whitespace; this is a power tool.

## Shell

Left sidebar (200px): Chat · Tasks · People · Inspector · Costs · Config. Badge on Tasks (open
count) and on Chat (unseen notifications). WS connection status dot. All data types and API calls
come from `@botty/shared` (`api.ts` schemas) — no locally redefined shapes.

## Pages

### Chat
Single continuous thread. Renders `chat_turns` history (paginated "load earlier"), streaming
assistant turn from `chat.chunk` events, thinking/tool presence pill, markdown rendering
(headings, lists, code, bold/italic — a tiny renderer or `marked` + sanitize). Session seams
render as subtle "· new context ·" dividers. **Proactive notifications render in-thread as
cards**: message, score chip, and Done / Snooze 3d / Dismiss buttons (dismiss opens a reason
input) wired to `POST /api/tasks/:id/action`. **Consent-gated MCP tool calls render as approval
cards** (`ApprovalCard` in `ChatPage.tsx`, driven by WS `action.pending`/`action.resolved` — see
`specs/mcp.md`): server/tool badge, one-line summary, expandable arguments (inline `<pre>` or a
`JsonViewer` for long payloads), and — while `status: 'pending'` — ✓ approve / ✕ dismiss buttons
wired to `POST /api/actions/:id/approve`/`dismiss`; once resolved the card instead shows an
✓ executed / ✗ failed outcome line (with a `resultJson` snippet) and the buttons disappear.
Composer: multiline, Enter sends, Shift+Enter newline, Stop button while streaming
(`/api/chat/interrupt`), "fresh context" button (`/api/chat/seal`).

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

### Costs
Renders `GET /api/costs` (`CostsReport` — see `specs/api.md` and `specs/loop.md`). A window picker
(today / last 7 days / last 30 days / all time) drives stat tiles for totals, a byCategory
breakdown (chat/intake/proactive/resolution/briefing/other, fixed category→color mapping) and a
byModel table (priced vs unpriced-calls flag), plus a 30-day stacked daily chart from `byDay`.
Refetches on WS reconnect and — lightly debounced (1.5s) — on every `decision.recorded` event,
since every LLM call broadcasts one.

### Config
One editor per file (persona/team/heartbeat): textarea (monospace) + Save with validation
warnings surfaced; last-loaded timestamp; `config.changed` WS refreshes. `GET /api/config` also
returns `issues.heartbeat`/`issues.mcp` (last-known-good warnings for content not currently being
served — see `specs/api.md`), but the Config page doesn't render them yet — only `PUT`'s per-save
`warnings` response is surfaced today. `mcp.json` is not edited here — it has no config-page tab in
v1 (see `specs/mcp.md`); edit it directly on disk and it hot-reloads the same way.

## WS store

One module: connects, dispatches events to per-page subscribers, exposes `useWsEvent(type, cb)`
and connection state; auto-reconnect with backoff, refetch-on-reconnect hooks per page.
