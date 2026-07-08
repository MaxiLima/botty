---
name: ship
description: Pre-ship checklist for botty — typecheck, tests, web build, audit, end-to-end verify on the isolated instance, backlog update, commit. Use when a change is done and about to be committed, when asked to "ship", "land", or "commit" work, or as the final phase of any multi-step feature/fix.
---

# Shipping a botty change

Run from the repo root, in order. Stop and fix at the first failure.

## 1. Static + tests (whole workspace)

```sh
npm run typecheck    # tsc --noEmit in every workspace
npm test             # vitest in every workspace with tests
```

If only one package changed, still run both workspace-wide — shared types leak
across packages.

## 2. Web build (when web or shared changed)

```sh
npm run build -w @botty/web
```

This writes `packages/web/dist`, which the **live 4820 agent serves directly** —
build once, deliberately, as part of shipping; don't rebuild mid-verification.

## 3. Audit

```sh
npm audit
```

New high/critical findings introduced by your change block the ship; pre-existing
ones get a BACKLOG.md note if not fixed now.

## 4. End-to-end verify — ISOLATED instance only

Follow the **verify** skill (`.claude/skills/verify/SKILL.md`): launch
sim+agent on **5820/5821** with a temp `BOTTY_DATA_DIR`, and exercise the paths
your change touches (web via puppeteer, TUI via tmux, agent via curl).
**Never** verify against 4820/4821 — those are the owner's live processes —
and kill by port (`lsof -ti tcp:5820 | xargs kill`), never `pkill tsx`.

## 5. Backlog

Update `BACKLOG.md`: strike/annotate items this change ships (with date, in the
style of the resolution-sweep entry), and add any new seams or follow-ups
discovered while building.

## 6. Commit

```sh
git status && git diff --stat   # confirm only intended files
```

One commit per logical change, imperative summary line describing behavior
(matching `git log` style, e.g. "TUI: fix 12 bugs found in multi-angle review").
Include the BACKLOG.md update in the same commit. Don't push unless asked.
