-- H12 fix (2026-08-21): ai_decisions only recorded input_tokens/output_tokens,
-- so resumed chat turns — almost entirely cache reads — priced as if they were
-- full-rate input. The Agent SDK's result message also reports its own
-- total_cost_usd, which is authoritative when present and should be preferred
-- over our per-model USD/MTok estimate. All three columns are nullable:
-- existing rows have neither and must keep pricing exactly as they do today
-- (see packages/agent/src/server/costs.ts and db/index.ts costRollup()).
ALTER TABLE ai_decisions ADD COLUMN cache_read_input_tokens INTEGER;
ALTER TABLE ai_decisions ADD COLUMN cache_creation_input_tokens INTEGER;
ALTER TABLE ai_decisions ADD COLUMN total_cost_usd REAL;
