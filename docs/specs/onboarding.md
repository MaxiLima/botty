# Onboarding wizard — guided setup for web + TUI

**Status: implemented 2026-07-18** (shared schemas in `api.ts`, renderer in
`config/render.ts`, endpoints in `server/onboarding.ts`, web `pages/OnboardingPage/`, TUI
wizard mode). The sections below were updated to match the as-built behavior.

A step-by-step wizard that takes a fresh install from "templates silently copied" to a
personalized, running botty: persona, team roster, sources + poll cadence, MCP servers and
tool allowlists, schedule, initial directives, and (optionally) model routing. Runnable in
the **web app** (`/onboarding` route) and the **TUI** (`/onboarding` slash command), and
re-runnable any time from either client to revisit answers.

## Goals / non-goals

Goals:

- First-run: detect a never-onboarded install and offer the wizard prominently in both clients.
- Re-run: `/onboarding` (TUI) and a "Run setup again" entry (web Config page) reopen the wizard
  prefilled from the **current** config, not the templates.
- Every step skippable — Enter/Next with no input keeps the current value or default. A user
  who skips everything ends up exactly where today's template seeding leaves them.
- One implementation of the answers→files logic, server-side, next to the existing parsers.
- Nothing is written until the final **Review & apply** step. Abandoning the wizard at any
  earlier point writes nothing.

Non-goals (v1):

- No new config storage. The wizard is UX over the existing artifacts: the four
  `~/.botty/config/` files, the `llm.models` settings key, and one new `onboarding.*`
  bookkeeping key. Hand-editing files remains fully supported and equal in power.
- No OAuth/account-connection flows for sources. Real-mode source drivers are stubs today
  (see BACKLOG "Startup fail-fast when BOTTY_MODE=real"); the sources step configures
  on/off + intervals and stops there. When real drivers land, their credential steps slot
  into the sources step.
- No editing of individual behavior knobs beyond the curated "advanced" subset — the full
  list stays a heartbeat.md concern.

## Architecture

Both clients collect the same structured **answers object**; the agent renders and writes the
files. Clients never generate markdown/JSON themselves — that keeps one renderer, co-located
with the parsers in `packages/agent/src/config/`, so round-trip tests can assert
`parse(render(answers))` is lossless for the structured files.

```
web /onboarding page ─┐
                      ├─→ GET  /api/onboarding          (state + prefill + env checks)
TUI /onboarding mode ─┘    POST /api/onboarding/apply   (answers → files + settings, atomically-ish)
```

The answers schema (`OnboardingAnswers`) lives in `@botty/shared` `src/api.ts` alongside the
other REST contracts — it is the one cross-cutting addition (zod schema, both clients and the
agent import it; run root `npm run typecheck`).

## First-run detection & re-run

- Settings key `onboarding.completedAt` (ISO timestamp). Written by `POST /api/onboarding/apply`
  and **only** by it — it is not added to `SETTABLE_SETTINGS_KEYS`, so `PUT /api/settings`
  still rejects it.
- `GET /api/health` gains `onboarded: boolean` (key present). Cheap, and both clients already
  call health at boot.
- **Web**: if `!onboarded`, the shell shows a dismissible full-width banner linking to
  `/onboarding` (no forced redirect — the app must stay usable without it). The Config page
  gets a permanent "Run setup again" link.
- **TUI**: if `!onboarded`, the welcome panel adds one line: `first run — type /onboarding to
  set things up`. `/onboarding` is a new entry in `COMMANDS` (`packages/tui/src/commands.ts`)
  available always, not just on first run.
- Re-run prefills from live config (see prefill rules below) and on apply overwrites the same
  files — the existing archive-on-save snapshot (`config/index.ts`) is the undo story.

## API surface

```
GET  /api/onboarding
  → {
      onboarded: boolean,            // onboarding.completedAt present
      completedAt: string | null,
      checks: {                      // environment checks, computed server-side
        mode: 'sim' | 'real',
        llmAuth: boolean,            // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN visible to the agent process
        mockLlm: boolean,            // BOTTY_MOCK_LLM active
        notifier: boolean,           // ~/.botty/Botty.app exists (darwin only; null elsewhere)
        dataDir: string,
      },
      prefill: OnboardingAnswers,    // current config parsed back into answers
      prefillWarnings: string[],     // parts of current files that couldn't round-trip (see below)
    }

POST /api/onboarding/preview   { answers, steps }        // same body as apply; renders only,
  → { files: { [name]: { content, current, changed } }, settings? }   // writes nothing —
                                                          // feeds the Review step in both
                                                          // clients (one renderer, server-side)

POST /api/onboarding/apply     { answers: OnboardingAnswers, steps: OnboardingStepName[],
                                 mtimes? }                // mtimes echoed from GET for the
                                                          // staleness note (see Failure modes)
  → { ok: boolean, warnings: Record<string, string[]> }   // per-file parser warnings, same
                                                          // shape as PUT /api/config/:name
```

- `steps` lists which wizard steps the user actually visited/confirmed; **only those files are
  written**. A re-run where the user only walks the Schedule step must not touch persona.md.
- `apply` writes via the same code path as `PUT /api/config/:name` (validate → archive → write →
  hot-reload picks it up), then sets `onboarding.completedAt`. mcp.json gets the same
  archive-on-save treatment as `mcp-<ts>.json` (`ConfigManager.saveMcp` — new with the
  wizard; previously only the markdown trio was archived).
- Per-file warnings come back non-fatally: last-known-good semantics already protect the
  running agent, and by construction the renderer should never emit something its own parser
  warns on (round-trip test enforces this).
- `POST /api/onboarding/apply` is origin-guarded like every other mutating route.

No PUT-per-step, no draft persistence server-side: wizard state lives in the client until
apply. A killed TUI or closed tab loses in-progress answers — acceptable for v1.

## The steps

Seven steps. Each lists: what it asks, the default/prefill, and what it writes.

### 1. Welcome & environment checks (read-only)

Renders `checks` from `GET /api/onboarding` as a pass/warn list:

- LLM auth visible? (env vars are the only cheaply-checkable signal — the Agent SDK also
  resolves a logged-in Claude Code session, so absence renders as a warn linking README
  §LLM auth, not a hard fail)
- Mode: sim vs real, with one line on what that means; mock-LLM flagged if on.
- macOS notifier installed? If not: "run `npm run setup:notifier` for branded notifications".
- Data dir path, so the user knows where their data lives.

Nothing to answer; purely orienting. Writes nothing.

### 2. Persona → `persona.md`

persona.md is free-form prose injected verbatim into prompts, so this step is **guided
composition, not a form**: fields for the user's name, role/company, how botty should address
them, tone notes, banned behaviors, and **timezone** — assembled into the template's section
structure (`## Identity`, `## About …`, `## Voice & tone`, `## Banned`).

- Timezone gets its own explicit field and is written as a clearly-labeled line under
  `## About`. It is still prose (there is no structured timezone config in v1 — schedule
  times remain host-local; the line exists so the LLM stops guessing). If structured
  timezone config lands later, this field migrates there.
- **Prefill/re-run rule**: because persona.md is unstructured, re-runs show the *current file
  text per section* for editing rather than decomposed fields (the original `## About …`
  heading text is preserved via `aboutHeading`). If the file no longer matches the template's
  section headings — or contains sections the wizard doesn't know, which a section re-render
  would silently drop — the step degrades to a single full-file editor with a note
  (`prefillWarnings` carries this).

### 3. Team → `team.md`

Repeating group, one entry per person: name (required), weight (CRITICAL/HIGH/NORMAL —
explain the Tier-1 line: CRITICAL/HIGH = full task extraction), slack handle, email, cadence,
notes. Prefill: `parseTeam()` of the current file — this one round-trips losslessly.
Writes the `## People` bullet list in the exact shape `parseTeam` (`config/parse.ts`) reads.
Empty roster is valid (real-mode template ships empty) but the step says what that means:
interactions-only until people are added.

### 4. Sources & cadence → `heartbeat.md` `## Sources`

For each of the five sources (slack, gmail, gcal, jira, github): on/off toggle + optional
poll interval override, with the mode-appropriate default shown
(`SOURCE_INTERVALS_REAL`/`_SIM`, `constants.ts`). In real mode, sources whose drivers are
stubbed are labeled "driver not yet available — config saved for when it is".

### 5. MCP servers & tools → `mcp.json`

Repeating group per server: key, command, args, env vars (secret-masked inputs), then the
tool allowlist — tool name + `read`/`action`, with one inline paragraph explaining the
consent gate (`action` ⇒ queued for approval, never runs mid-turn; see `specs/mcp.md`).

- **Test connection** button/prompt per server: agent spawns the server, runs `tools/list`,
  and returns the advertised tool names — so the allowlist can be picked from a real list
  instead of typed blind. Endpoint: `POST /api/onboarding/mcp-probe { server: McpServerConfig }`
  → `{ ok, tools: string[], error? }`. Probe failures don't block saving (matches runtime
  behavior: unreachable servers still expose allowlisted tools generically).
- Env values: never logged, never included in `prefillWarnings`, masked in both UIs after
  entry; re-run prefill returns them (the client already may read `mcp.json`-equivalent data —
  gate: this endpoint is same-origin local like everything else). Archive copies contain
  secrets exactly as the live file does — same directory, same exposure.

### 6. Schedule & rhythm → `heartbeat.md` `## Schedule`

working_hours (with the hard-off explanation), quiet_hours, active_days, tick_interval_min,
morning_brief_at, evening_brief_at. Prefill from `parseHeartbeat()`; defaults from
`HEARTBEAT_DEFAULTS`. Validate HH:MM ranges client-side too (the parser already warns).

### 7. Directives & advanced

- **Standing instructions** (`## Instructions`): free-text, prefilled with the current text
  (template default is the bias-toward-silence paragraph).
- **This week** (`## This week`): free-text, optional.
- **Recurring checklist** (`## Tasks`): repeating group — interval (`N` + `m/h/d`) +
  instruction, rendered as `- every <N><u>: <text>` bullets.
- **Advanced (collapsed/optional)**: the curated behavior subset — surfacing_threshold,
  max_proactive_per_hour, min_gap_between_nudges_min, auto_resolve_tasks,
  infer_commitments, commitments_max_per_day — plus **model routing** (`llm.models`:
  dropdown per `LlmTask`, defaults from `DEFAULT_MODELS`). Everything else in `## Behavior`
  is out of scope for the wizard; the step links to the heartbeat editor for the full list.
  Model routing is the one answer that writes to settings, not a file; entries equal to the
  built-in default are dropped from the stored map so future default changes keep tracking.

### Review & apply

Shows, per file the user touched: a rendered preview (web: diff against current file; TUI:
the new file content with a `changed`/`unchanged` marker per file). Confirm ⇒ one
`POST /api/onboarding/apply`. Success screen notes everything is hot-reloaded (no restart)
and that previous versions are in `config/archive/`.

## Rendering & round-trip rules

- New module `packages/agent/src/config/render.ts`: `renderTeam`, `renderHeartbeat`,
  `renderMcp`, `renderPersona` (+ `answersFromConfig` for prefill). Tests assert
  `parseTeam(renderTeam(a))` and `parseHeartbeat(renderHeartbeat(a))` round-trip exactly,
  and that rendering the parsed **template** reproduces its semantic content.
- **Hand-edit preservation**: heartbeat.md re-render keeps the template's explanatory
  `<!-- -->` comment blocks (they're part of the canonical render), but **custom** comments
  or exotic formatting a user hand-added are lost on a wizard re-run that touches that file.
  This is a stated v1 trade-off; the archive snapshot is the recovery path, and the Review
  step's diff makes the loss visible before it happens. Same for team.md field ordering.
- Keys the parser knows but the wizard doesn't ask about (the non-curated `## Behavior`
  knobs) are **carried through verbatim** from the parsed current config into the render —
  a wizard run must never reset a hand-tuned `resolution_confidence_min` to default.

## Web UI

Route `/onboarding` (sidebar-less, full-width, same dark/violet system — see
`specs/web-ui.md` house rules). Step rail on the left, one step per screen, Back/Next/Skip,
final Review. Entry points: first-run banner + Config-page "Run setup again". After apply,
navigate to Chat. All components live in `packages/web/src/pages/OnboardingPage/`.

## TUI

`/onboarding` command (`commands.ts`) returns a new `action: 'onboarding'`; `App.tsx` enters
a **wizard mode** that owns the input line until exit (mirrors how transient modes already
work — the command menu precedent). Interaction grammar, one question at a time:

- Text prompt with prefill shown dim; Enter keeps it.
- Toggles/selects: arrow keys or `y`/`n`, Enter confirms.
- Repeating groups (people, servers, checklist): list view; `a`dd / `e`dit / `d`elete /
  Enter continues.
- `Esc` backs up one question; `Esc` at the first question prompts "abandon setup? y/n" —
  abandoning writes nothing.
- Each writing step opens with a confirm/skip gate (`y`/`n`) — only gated-in steps land in
  the apply `steps` array, which is how "every step skippable" works in a linear
  question flow.
- Review step prints per-file content in a dedicated `onboardingReview` panel (same
  `Frame` + markdown renderer as `/config`) with changed/unchanged markers — mcp.json env
  values masked — then an apply/abandon confirm.

The TUI stays otherwise read-only; this is a deliberate, contained exception (precedent
already under discussion in BACKLOG "TUI write actions (M9)").

## Failure modes

- **Agent unreachable mid-wizard**: answers are client-held; apply retries are safe
  (idempotent: same answers ⇒ same files).
- **Config changed on disk while wizard open** (hot reload fired): v1 ships the downgraded
  behavior — last write wins + archive. The apply response's warnings carry a staleness note
  when the file's mtime changed since prefill was served (the concurrent edit is in
  `config/archive/`), but apply never blocks on it.
- **Parser warnings on apply**: should be impossible via the renderer (tested), but if
  present they surface exactly like Config-page saves and last-known-good protects the
  running agent.
- **Sim vs real**: wizard works identically in both; step 1 labels the mode and step 4
  labels stubbed drivers. The sandbox/verify instances get the wizard for free (it's just
  the clients + API).

## Testing

- Unit: render/parse round-trips; `answersFromConfig` on both templates and on hand-mangled
  files (degraded-prefill paths); apply writes only `steps`-listed files; `onboarding.completedAt`
  not settable via `PUT /api/settings`.
- E2E (isolated instance per the `verify` skill): fresh `BOTTY_DATA_DIR` ⇒ health reports
  `onboarded: false`; run wizard via REST; files land, hot reload fires (`config.changed`),
  `onboarded: true`; re-run prefills the just-written answers byte-identically.
- TUI: the wizard is a pure state machine (`tui/src/onboarding.ts` — no ink imports);
  `test/onboarding.test.ts` drives it as plain reducers (happy path, gates/skip,
  Esc-back, abandon-writes-nothing, repeating groups, validation), matching the
  package's existing pure-function test style — there is no ink render harness.
