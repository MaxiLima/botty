CREATE VIRTUAL TABLE memory_fts USING fts5(
  kind,
  ref_id,
  content,
  tokenize = 'porter unicode61'
);
