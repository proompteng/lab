-- +goose Up
-- +goose NO TRANSACTION

-- Enforce unique source references for ideas.
ALTER TABLE codex_kb.ideas
  ADD CONSTRAINT ideas_source_unique UNIQUE (source_type, source_ref);

-- Ensure one task per idea/stage combination and replace the existing non-unique index.
DROP INDEX IF EXISTS codex_kb.idx_tasks_idea_stage;
ALTER TABLE codex_kb.tasks
  ADD CONSTRAINT tasks_idea_stage_unique UNIQUE (idea_id, stage);

-- Add delivery identifier to task runs for idempotent intake.
ALTER TABLE codex_kb.task_runs
  ADD COLUMN delivery_id TEXT;

UPDATE codex_kb.task_runs
SET delivery_id = gen_random_uuid()::text
WHERE delivery_id IS NULL;

ALTER TABLE codex_kb.task_runs
  ALTER COLUMN delivery_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_delivery ON codex_kb.task_runs (delivery_id);

ALTER TABLE codex_kb.task_runs
  ADD CONSTRAINT task_runs_delivery_unique UNIQUE USING INDEX idx_task_runs_delivery;

-- +goose Down
-- +goose NO TRANSACTION

ALTER TABLE codex_kb.task_runs
  DROP CONSTRAINT IF EXISTS task_runs_delivery_unique;

DROP INDEX IF EXISTS codex_kb.idx_task_runs_delivery;

ALTER TABLE codex_kb.task_runs
  DROP COLUMN IF EXISTS delivery_id;

ALTER TABLE codex_kb.tasks
  DROP CONSTRAINT IF EXISTS tasks_idea_stage_unique;

CREATE INDEX IF NOT EXISTS idx_tasks_idea_stage ON codex_kb.tasks (idea_id, stage);

ALTER TABLE codex_kb.ideas
  DROP CONSTRAINT IF EXISTS ideas_source_unique;
