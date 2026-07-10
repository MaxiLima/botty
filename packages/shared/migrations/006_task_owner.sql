-- Task ownership (2026-07-09 live bug fix): extraction was creating tasks
-- owned by the user out of the OTHER person's own stated commitment (Diego's
-- "I'll send you the latency doc tomorrow" became a task telling the USER to
-- send the doc). 'me' = the user must act; 'them' = the other person's own
-- promise TO the user — a "waiting on <them>" reminder, not a to-do. See
-- docs/specs/ingestion.md (extraction step) and ingest/funnel.ts.
ALTER TABLE tasks ADD COLUMN owner TEXT NOT NULL DEFAULT 'me';
