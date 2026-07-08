# Simulator — @botty/sim

A standalone Express service (port 4821, `BOTTY_SIM_PORT`) that fakes all five sources so botty
can be developed, demoed, and tested without any real credentials. In-memory state seeded from
scenario files; a control API + minimal web panel inject events live.

## Source endpoints (consumed by the agent's sim drivers)

All return `{ events: SimEvent[] }` where `SimEvent` matches the agent's normalized
`SourceEvent` shape from `@botty/shared` (the sim imports the same zod schemas — contract
enforced at both ends). `since` filters on the event's wall-clock **release instant**
(`releasedAtMs`), never on `occurredAt` — the agent's `since` watermark is wall-clock time,
while `occurredAt` lives on the scenario timeline and can be far behind (paused clock) or
ahead (fast play) of wall time.

```
GET /slack/events?since=      dm | mention | channel messages
GET /gmail/events?since=      emails
GET /gcal/events?since=       calendar events (meta: {startAt, endAt, attendees[], location})
GET /jira/events?since=       assigned issues (meta: {key, status, url})
GET /github/events?since=     assigned PRs/issues (meta: {repo, number, state, url})
```

Only already-released events are returned (see scenario playback), each filtered on the
wall-clock moment it was released — inject or clock crossing `atMinute` (`engine.ts eventsFor`).

## Control API

```
GET  /control/state                  → { scenario, clock, released, pending, people }
POST /control/reset                  → clears state
POST /control/scenario/load          { name } → loads scenarios/<name>.json
POST /control/scenario/play          { speed?: number } → starts releasing events
                                       (speed 60 ⇒ 1 scenario-minute per real second)
POST /control/scenario/pause
POST /control/advance                { minutes } → jump the scenario clock forward
POST /control/inject                 SimEvent (occurredAt defaulted to now) → released immediately
GET  /control/templates              → canned inject templates (slack DM from X, urgent email, …)
```

## Scenario file format — `packages/sim/scenarios/*.json`

```jsonc
{
  "name": "workweek",
  "description": "A realistic Monday for Maxo",
  "people": [ { "name": "Marian", "slackHandle": "@marian", "email": "marian@acme.example" }, ... ],
  "events": [
    { "atMinute": 0,   "source": "slack", "kind": "dm",
      "actor": { "handle": "@marian" },
      "text": "Hey, can you review the fraud-rules PR before EOD? It's blocking the release.",
      "threadRef": "T-1001" },
    { "atMinute": 12,  "source": "gcal", "kind": "event",
      "text": "Sprint planning", "meta": { "startAtMinute": 75, "durationMin": 60,
      "attendees": ["marian@acme.example", "yo@maxolabs.io"] } },
    ...
  ]
}
```

`atMinute` is relative to scenario start; the engine converts to absolute `occurredAt` when
released. gcal `startAtMinute` likewise.

## Seed scenario: `workweek.json`

Must exercise every funnel path. ~40 events across a simulated day: 6 people (2 CRITICAL,
1 HIGH, 3 not-in-team), Tier-1 DMs with clear asks (→ EXTRACTED), social noise from Tier-1
("jaja buenísimo" → NO_SIGNAL), Tier-2 messages (→ INTERACTION_ONLY), a duplicate delivery
(→ DUPLICATE), borderline messages (heuristic passes, classifier should reject), 3 emails
(1 needs-action, 2 newsletters), 4 calendar events (one starting 70 min in with a Tier-1
attendee → meeting-prep), 3 Jira issues, 2 GitHub PRs, a "we decided to go with X" decision
message, and an "I'll send the doc tomorrow" commitment. Also `templates` for live injects.
The TEAM.md template in the agent package must list the same people so tiers resolve.

## Control panel

Single static page served at `/` (vanilla HTML+JS, no build step): scenario picker,
play/pause/speed, clock display, event timeline (released vs pending), inject form with
templates. Function over beauty — this is a dev tool.
