---
name: sim-scenarios
description: Authoring and validating simulator scenarios for botty — the scenario JSON shape, event timing/threads/directions, the :5821 control API, and end-to-end validation on the isolated instance. Use when writing or editing a packages/sim/scenarios/*.json file, adding inject templates, scripting a specific funnel path (dedup, resolution sweep, calendar), or debugging why the agent isn't receiving sim events.
---

# Authoring sim scenarios

## File & shape

Scenarios live in `packages/sim/scenarios/<name>.json` (name must match
`[A-Za-z0-9_-]+`; override dir with `BOTTY_SIM_SCENARIOS_DIR`). Validated by
`ScenarioSchema` in `packages/shared/src/events.ts`; loader is
`packages/sim/src/scenarios.ts`. Reference example: `packages/sim/scenarios/workweek.json`.

```jsonc
{
  "name": "myscenario",                 // must equal the filename
  "description": "optional",
  "people": [ { "name": "Marian", "slackHandle": "@marian", "email": "marian@acme.example" } ],
  "events": [
    {
      "atMinute": 0,                    // scenario-clock minutes from load
      "source": "slack",                // slack | gmail | gcal | jira | github
      "kind": "dm",                     // slack: dm|mention|channel · gmail: email · gcal: event · jira: issue · github: pr|issue
      "actor": { "handle": "@marian", "displayName": "Marian Gutiérrez" },  // or { "email": ... }
      "direction": "inbound",           // optional; "outbound" = the USER's own message
      "text": "…",                      // gmail convention: "Subject: X\n\nBody"
      "threadRef": "T-1001",            // optional; same ref = same thread
      "meta": { }                       // optional, source-specific (see below)
    }
  ],
  "templates": [ /* optional InjectTemplate[] — see Inject templates */ ]
}
```

Semantics that matter (see `packages/sim/src/engine.ts`):

- **`atMinute`** — events release when the scenario clock reaches it; ties keep
  file order. `occurredAt` is computed as load-wall-time + atMinute.
- **`threadRef`** — groups events into one thread. The resolution sweep reads
  thread evidence, so a follow-up in the same threadRef can auto-close a task.
- **`direction: "outbound"`** — simulates the user's own reply (never
  task-extracted; prime resolution-sweep evidence). Default is inbound.
- **`meta.externalId`** — pins the event's externalId (default is
  `<scenario>-evt-<idx>`). Give two events the same externalId to script a
  DUPLICATE funnel outcome. It's stripped from meta before delivery.
- **gcal events** — set `meta.startAtMinute` (+ optional `meta.durationMin`,
  default 30); the engine absolutizes them to ISO `startAt`/`endAt` anchored at
  scenario load (or at sim-now for injects). Also useful: `attendees`, `location`.
- **jira/github meta** — freeform but workweek uses `key/status/url` and
  `repo/number/state/url`; match those.

## Inject templates

Top-level `templates` key (outside the frozen ScenarioSchema — parsed
separately in `scenarios.ts`) provides canned injects for the control panel.
Shape: `{ id, label, event: { source, kind, actor?, direction?, text, threadRef?, meta? } }`
(`packages/sim/src/templates.ts`). Scenario templates merge over
`DEFAULT_TEMPLATES` by id.

## Control API (sim port, e.g. :5821)

```sh
curl -s localhost:5821/control/state                    # clock, released, pending, available scenarios
curl -s -XPOST localhost:5821/control/scenario/load -H 'content-type: application/json' -d '{"name":"myscenario"}'
curl -s -XPOST localhost:5821/control/advance -d '{"minutes":30}' -H 'content-type: application/json'
curl -s -XPOST localhost:5821/control/scenario/play -d '{"speed":120}' -H 'content-type: application/json'   # sim-min per wall-min
curl -s -XPOST localhost:5821/control/scenario/pause
curl -s -XPOST localhost:5821/control/inject -H 'content-type: application/json' -d '{"source":"slack","kind":"dm","text":"hola","threadRef":"T-X"}'
curl -s -XPOST localhost:5821/control/reset
curl -s localhost:5821/control/templates
curl -s 'localhost:5821/slack/events?since=2026-07-07T00:00:00Z'   # what the agent's poller sees
```

`GET /` on the sim port serves a human control panel.

## Delivery: releasedAtMs vs the agent watermark

The agent stores a per-source wall-clock watermark (`ingest.lastCheck.<source>`
setting, advanced to the check's start time only on success —
`packages/agent/src/ingest/scheduler.ts`). The sim filters
`/<source>/events?since=` on each event's **release wall-clock instant**
(`releasedAtMs`), never on `occurredAt` — so delivery works no matter how the
sim clock skews from wall time. Consequences:

- Advancing/playing the clock releases due events "now"; the agent's **next
  poll** picks them up even though their `occurredAt` may be far in the past.
- Re-loading a scenario re-releases everything at now; already-processed events
  come back as DUPLICATE (externalId dedup downstream), which is safe.
- Nothing pushes: the agent polls on its heartbeat interval. Force a poll with
  `POST :5820/api/sources/<source>/check-now`.

## Validate a new scenario end-to-end

Always on the **isolated 5820/5821 instance** — see the `verify` skill for the
launch recipe (never touch 4820/4821). Then:

```sh
# 1. Schema check: load it (400 with a zod error if the shape is wrong)
curl -s -XPOST localhost:5821/control/scenario/load -H 'content-type: application/json' -d '{"name":"myscenario"}'
# 2. Release events and confirm the sim sees them
curl -s -XPOST localhost:5821/control/advance -d '{"minutes":60}' -H 'content-type: application/json'
curl -s localhost:5821/control/state | jq '{released: (.released|length), pending: (.pending|length)}'
# 3. Deliver to the agent and check the funnel
for s in slack gmail gcal jira github; do curl -s -XPOST localhost:5820/api/sources/$s/check-now; done
curl -s localhost:5820/api/raw-log | jq   # funnel outcomes per event
curl -s localhost:5820/api/tasks | jq     # extracted tasks
```

Unit tests for engine/loader: `npm test -w @botty/sim`.
