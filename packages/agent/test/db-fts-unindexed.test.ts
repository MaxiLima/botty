import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrationsDir } from '@botty/shared/migrations-dir';
import { describe, expect, it } from 'vitest';
import { Db } from '../src/db/index.js';

describe('memory_fts UNINDEXED columns (migration 003)', () => {
  it('does not match rows via the kind column', () => {
    const db = new Db(':memory:');
    db.ftsIndex('task', 'tsk-1', 'ship the payments dashboard');
    db.ftsIndex('decision', 'dec-1', 'use sqlite for storage');

    // "tasks" porter-stems to "task" and previously matched the kind column of every task row.
    expect(db.ftsSearch('what tasks do I have', 5)).toEqual([]);
    expect(db.ftsSearch('decision', 5)).toEqual([]);

    // content is still searchable
    expect(db.ftsSearch('payments', 5).map((h) => h.refId)).toEqual(['tsk-1']);
  });

  it('does not match rows via the ref_id column', () => {
    const db = new Db(':memory:');
    db.ftsIndex('chat', 'V1StGXR8Z5', 'we discussed the deploy window');
    expect(db.ftsSearch('V1StGXR8Z5', 5)).toEqual([]);
  });

  it('rebuilds existing rows when migrating a pre-003 database', () => {
    const raw = new Database(':memory:');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    const apply = (file: string) => raw.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));

    for (const file of files.filter((f) => Number.parseInt(f, 10) < 3)) apply(file);
    raw
      .prepare('INSERT INTO memory_fts (kind, ref_id, content) VALUES (?, ?, ?)')
      .run('task', 'tsk-1', 'ship the payments dashboard');
    // sanity: the old schema over-matches on the kind column
    const count = (match: string) =>
      (raw.prepare('SELECT count(*) AS c FROM memory_fts WHERE memory_fts MATCH ?').get(match) as { c: number }).c;
    expect(count('"tasks"')).toBe(1);

    const migration3 = files.find((f) => Number.parseInt(f, 10) === 3);
    expect(migration3).toBeDefined();
    apply(migration3!);

    // row preserved with its metadata, content matchable, kind no longer matchable
    expect(count('"tasks"')).toBe(0);
    expect(count('"payments"')).toBe(1);
    expect(raw.prepare('SELECT kind, ref_id FROM memory_fts').all()).toEqual([{ kind: 'task', ref_id: 'tsk-1' }]);
  });
});
