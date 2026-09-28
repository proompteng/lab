-- +goose Up
-- +goose StatementBegin
DROP INDEX IF EXISTS codex_kb.idx_reflections_run_type;
ALTER TABLE codex_kb.reflections
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD CONSTRAINT reflections_task_run_type_unique UNIQUE (task_run_id, reflection_type);
COMMENT ON INDEX codex_kb.idx_reflections_embedding IS 'Maintain with REINDEX (CONCURRENTLY) after updating IVFFlat lists/probes; see docs/facteur-autonomous-knowledge-base.md.';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE codex_kb.reflections
  DROP CONSTRAINT IF EXISTS reflections_task_run_type_unique,
  DROP COLUMN IF EXISTS updated_at;
CREATE INDEX IF NOT EXISTS idx_reflections_run_type ON codex_kb.reflections (task_run_id, reflection_type);
COMMENT ON INDEX codex_kb.idx_reflections_embedding IS NULL;
-- +goose StatementEnd
