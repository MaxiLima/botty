---
name: botty-doctor
description: Diagnose botty misbehavior and turn the finding into a sanitized GitHub issue on MaxiLima/botty. Use whenever the user reports the app doing something wrong or unexpected ("botty didn't nudge me about X", "why did it classify/skip/duplicate...", "notifications stopped", "the agent feels broken"), asks to troubleshoot/diagnose the running instance, or says "file a finding", "report this", "create an issue for this". Covers the whole pipeline — ingestion, classification/extraction, proactive loop, judgment, notifications, chat, config.
---

# botty-doctor — diagnose the running app, file the finding

Diagnose against the instance the user is actually running (default: the **live**
agent on `http://127.0.0.1:4820`), then file a sanitized issue so the fix can happen
later on the personal setup. The issue must be **self-contained**: the live DB won't
be available when the fix is written, so everything needed to reproduce has to be in
the issue body — as fiction (see Sanitize).

## Ground rules on the live instance

Read-only, always. `GET` requests to `:4820/api/*` are fine; never `POST` anything
that mutates or triggers work on 4820 (`/loop/run-now`, `/sources/*/check-now`,
`PUT /config`, timewarp), never kill/restart it, never rebuild `packages/web/dist`.
If DB access is needed beyond what the API exposes, open read-only:
`sqlite3 "file:$HOME/.botty/data/botty.db?mode=ro"`.

## Diagnosis flow

1. **Baseline**: `GET /api/health` — capture `version`, `mode`, `dbPath`, `schedule`.
   A `schedule` outside working hours or in quiet hours is a hard off switch and
   explains most "botty went silent" reports on its own.
2. **Locate the failure stage.** Every inbound event flows
   raw_log → classification → extraction/task → proactive loop (rules gates →
   judgment) → notification. Find the last stage that behaved correctly:

   Calendar events are the exception: they bypass classification/extraction
   (upsert → `calendar_events` → meeting-prep synthesis inside the loop).

   | Symptom | Look at |
   |---|---|
   | Event never seen | `GET /api/source-checks` (poll errors), `GET /api/raw-log?source=…` (source ids: `slack`, `gmail`, `gcal`, `jira`, `github`) |
   | Seen but no task | Inspector Funnel outcome chip; `GET /api/decisions?kind=classification` then `extraction` |
   | Task exists, never surfaced | `GET /api/ticks` → expand the tick: rules-gate rejections (cooldown, caps, snooze, mute) vs judgment skip |
   | Calendar event never nudged | `calendar_events.start_at` vs the lead window (`meeting_prep_lead_min`, default 60; candidates only from `start_at >= now`), Tier-1 attendee gate, `meeting_prep:` tasks. On sim instances also compare sim vs wall clock: `GET :<sim-port>/control/state` — skew mis-dates injected events |
   | Judgment skipped wrongly | `GET /api/ticks/:id` — read the judgment reasoning; threshold is 7, biased to silence, so confirm it's actually wrong |
   | Surfaced but not seen | notification delivery (macOS notifier deactivation → lands silently in side panel), `proactive_log` |
   | Duplicates | `raw_log` external_id — a re-sent event with a fresh external_id is a genuine new event, not a dedup bug |
   | Wrong chat behavior | `GET /api/decisions?kind=chat_turn`; check `persona.md` / `team.md` hot-reload state via `GET /api/config` |
3. **Pull the evidence**: the specific `ai_decisions` rows (`GET /api/decisions?kind=…`),
   tick ids, raw_log ids. Every AI decision is recorded — never guess why the agent
   did something when you can read its reasoning.
4. **Reproduce if cheap** (optional but gold): translate the trigger into a sim
   scenario with fictional data and replay it on the sandbox (`sandbox` /
   `sim-scenarios` skills, ports 6820/6821). A confirmed repro recipe in the issue
   makes the later fix session trivial. If the instance under diagnosis *is* the
   sandbox, don't inject into it mid-investigation — that contaminates the
   evidence; use a throwaway isolated instance instead (`verify` skill,
   5820/5821, temp `BOTTY_DATA_DIR`) or settle for a repro sketch.

## Sanitize — non-negotiable

This runs in the MELI work environment; the repo's fixture policy is **fictional
Acme personas and `.example` domains only** (the repo was purged and recreated over
this once — don't re-leak). GitHub issues are outside the machine, so:

- Never paste raw `input_json`/`output_json`, message bodies, subjects, or channel
  names from a real instance into the issue.
- Rewrite the trigger as fiction: real people → Acme personas (Ana Reyes, Sam Ortiz…),
  real domains → `acme.example`, real message content → a minimal invented equivalent
  that preserves the *structure* that matters (source, direction, thread shape,
  timing, the phrase pattern that confused the model).
- Safe to include verbatim: ids (decision/tick/raw_log), timestamps, `kind` values,
  model names, latencies, token counts, error messages **after** checking they quote
  no content, config *keys* (not values that name real people).
- Before filing, re-read the draft once with only this question: "does any string
  here identify a real person, company, or message?"

## File the issue

Write the draft to the scratchpad, show it to the user, and only file after they
approve — an issue is published the moment it's created.

```sh
gh issue create --repo MaxiLima/botty --label bug,finding \
  --title "<stage>: <one-line symptom>" --body-file <draft.md>
```

Title prefix = pipeline stage (`ingestion:`, `classification:`, `extraction:`,
`proactive:`, `judgment:`, `notification:`, `chat:`, `config:`). Body template:

```markdown
## Symptom
What the user observed, when, in which mode.

## Environment
version + mode from /api/health · commit of the running working tree if known.

## Diagnosis
Stage-by-stage: what was checked, what each surface showed (sanitized).
Last correct stage → first broken stage.

## Evidence
Decision/tick/raw_log ids, timestamps, error text (scrubbed).

## Repro sketch
Fictional sim-scenario outline (or confirmed sandbox repro) that triggers it.

## Suspected cause / fix direction
Best hypothesis, files likely involved.
```

Use `--label bug,finding` for defects; swap `bug` for `enhancement` when the finding
is a behavior gap rather than breakage. `finding` always — it's how the personal
setup filters doctor-filed issues.
