-- memory_fts indexed the kind and ref_id columns, so an unqualified MATCH
-- over-matched: porter stems "tasks" -> "task", making any query containing
-- task/decision/chat/interaction hit every row of that kind, and nanoid
-- fragments matched via ref_id. Rebuild with those columns UNINDEXED so
-- only content is searchable (they stay stored and filterable/selectable).
CREATE VIRTUAL TABLE memory_fts_rebuild USING fts5(
  kind UNINDEXED,
  ref_id UNINDEXED,
  content,
  tokenize = 'porter unicode61'
);

INSERT INTO memory_fts_rebuild (kind, ref_id, content)
SELECT kind, ref_id, content FROM memory_fts;

DROP TABLE memory_fts;

ALTER TABLE memory_fts_rebuild RENAME TO memory_fts;
