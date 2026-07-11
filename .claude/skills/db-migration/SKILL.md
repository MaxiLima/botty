---
name: db-migration
description: Checklist for adding a SQL migration to the frozen packages/shared schema — numbering, wiring, doc updates, typecheck, test. Use when asked to add/alter a table or column, or any task that touches packages/shared/migrations/*.sql.
---

# Adding a DB migration

`packages/shared` is frozen contracts — schema changes there are cross-cutting (every
package's typecheck can be affected). This is the exact sequence; don't skip the doc
update, it's the step that has gone stale three migrations running.

## 1. Read the current layout first

- Files live in `packages/shared/migrations/NNN_name.sql` — zero-padded 3-digit
  sequence number, underscore, short snake_case name (`001_initial.sql`,
  `004_commitments.sql`, `006_task_owner.sql`). Check `ls packages/shared/migrations`
  for the current highest number before naming your file — don't assume from the doc,
  it's been out of date before.
- No manifest/index to edit: `packages/agent/src/db/index.ts` `migrate()` discovers
  files by `readdirSync(migrationsDir).filter(/^\d+_.+\.sql$/).sort()` and applies any
  version not yet in `schema_migrations`, in filename order, each in its own
  transaction. **Registration = the file existing with the right name.** No import,
  no array to append to.
- `migrationsDir` is exported from `packages/shared/src/migrations.ts` (path only,
  resolved via `import.meta.url`) — not something you edit for a routine migration.

## 2. Write the migration file

- One statement set per file, plain SQL, forward-only (no down-migration mechanism
  exists — see the `owner` column migration for the house style: a comment block
  explaining *why*, dated, referencing the spec doc it relates to).
- `ALTER TABLE ... ADD COLUMN` for additive changes; new `CREATE TABLE` for new
  entities. Match existing conventions: `id TEXT PRIMARY KEY` (nanoid), timestamps as
  `TEXT` ISO-8601 UTC (`created_at`/`updated_at` where applicable), boolean-ish flags
  as `TEXT` enums with a comment listing the allowed values (see `people.weight`,
  `tasks.owner`).

## 3. Update the doc — docs/specs/data-model.md

This is the step that lapsed for migrations 004, 005, and 006 (the doc's "Current
set" line still said "001–003" and the table definitions didn't show `owner` or the
commitments/pending_actions tables). Update, in the same commit as the migration:
- The "Migrations" section's running list of applied migrations.
- The relevant `CREATE TABLE`/column block if you added or changed columns.
- The "Conventions" section if the migration introduces a new pattern worth
  documenting for future writers.

## 4. Typecheck

```sh
npm run typecheck
```

Run at the **root** — `packages/shared` changes ripple into every workspace that
imports its types (`Task`, `Person`, etc. in `packages/shared/src/types.ts` usually
need a matching update alongside a schema change).

## 5. Test

Add or extend a DB test under `packages/agent/test/` (`db.test.ts` for core
tables/columns, `db-commitments.test.ts` / `db-fts-unindexed.test.ts` for the
precedents on testing a specific migration's effect). Assert the new column/table
exists and round-trips through the `Db` class, not just that the SQL applies cleanly.

```sh
npm test -w @botty/agent -- db.test.ts   # or the specific file you extended
```

## Gotchas

- Migrations run automatically on `Db` open (including in tests and the isolated
  verify instance) — never migrate the live DB by hand or via a one-off script.
- Filename sort is lexicographic on the whole string after the number prefix is
  stripped by `parseInt`, but keep the zero-padded 3-digit width anyway (`007`, not
  `7`) so directory listings and diffs stay readable in order.
- If a migration must reshape a table SQLite can't `ALTER` in place (e.g. dropping a
  column pre-3.35, changing a `PRIMARY KEY`), follow the migration 003 precedent:
  a full rebuild (create new, copy, drop old, rename) inside one file, with a comment
  explaining what broke and why the rebuild was necessary.
