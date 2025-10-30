-- +goose Up
-- +goose NO TRANSACTION

CREATE SCHEMA IF NOT EXISTS codex_kb AUTHORIZATION facteur;

GRANT USAGE ON SCHEMA codex_kb TO facteur;
ALTER DEFAULT PRIVILEGES IN SCHEMA codex_kb
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO facteur;

CREATE TABLE IF NOT EXISTS codex_kb.ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  priority SMALLINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  risk_flags JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS codex_kb.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idea_id UUID NOT NULL REFERENCES codex_kb.ideas(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  state TEXT NOT NULL,
  assignee TEXT,
  sla_deadline TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_idea_stage ON codex_kb.tasks (idea_id, stage);
CREATE INDEX IF NOT EXISTS idx_tasks_state_updated ON codex_kb.tasks (state, updated_at DESC);

CREATE TABLE IF NOT EXISTS codex_kb.task_dependencies (
  task_id UUID NOT NULL REFERENCES codex_kb.tasks(id) ON DELETE CASCADE,
  depends_on_task_id UUID NOT NULL REFERENCES codex_kb.tasks(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'hard',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, depends_on_task_id)
);

CREATE TABLE IF NOT EXISTS codex_kb.task_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES codex_kb.tasks(id) ON DELETE CASCADE,
  external_run_id TEXT,
  status TEXT NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  input_ref TEXT,
  output_ref TEXT,
  retry_count SMALLINT NOT NULL DEFAULT 0,
  error_code TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_runs_task_created ON codex_kb.task_runs (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_runs_status_updated ON codex_kb.task_runs (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS codex_kb.task_runs_history (
  archived_run_id UUID PRIMARY KEY,
  task_id UUID NOT NULL REFERENCES codex_kb.tasks(id) ON DELETE CASCADE,
  snapshot JSONB NOT NULL,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retention_class TEXT NOT NULL DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS codex_kb.run_events (
  id BIGSERIAL PRIMARY KEY,
  task_run_id UUID NOT NULL REFERENCES codex_kb.task_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  emitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_run_events_run_emitted ON codex_kb.run_events (task_run_id, emitted_at);
CREATE INDEX IF NOT EXISTS idx_run_events_emitted ON codex_kb.run_events (emitted_at);

CREATE TABLE IF NOT EXISTS codex_kb.artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_run_id UUID NOT NULL REFERENCES codex_kb.task_runs(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  uri TEXT NOT NULL,
  checksum TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_uri ON codex_kb.artifacts (uri);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_type ON codex_kb.artifacts (task_run_id, artifact_type);

CREATE TABLE IF NOT EXISTS codex_kb.reflections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_run_id UUID NOT NULL REFERENCES codex_kb.task_runs(id) ON DELETE CASCADE,
  author TEXT,
  reflection_type TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding vector(1536),
  embedding_version TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reflections_run_type ON codex_kb.reflections (task_run_id, reflection_type);
CREATE INDEX IF NOT EXISTS idx_reflections_embedding ON codex_kb.reflections USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE TABLE IF NOT EXISTS codex_kb.policy_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idea_id UUID NOT NULL REFERENCES codex_kb.ideas(id) ON DELETE CASCADE,
  task_run_id UUID REFERENCES codex_kb.task_runs(id) ON DELETE SET NULL,
  policy_key TEXT NOT NULL,
  status TEXT NOT NULL,
  evidence_uri TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_policy_checks_idea_policy_created
  ON codex_kb.policy_checks (idea_id, policy_key, created_at DESC);

CREATE TABLE IF NOT EXISTS codex_kb.run_metrics (
  task_run_id UUID PRIMARY KEY REFERENCES codex_kb.task_runs(id) ON DELETE CASCADE,
  queue_latency_ms BIGINT,
  runtime_ms BIGINT,
  retry_latency_ms BIGINT,
  resource_usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_run_metrics_runtime ON codex_kb.run_metrics (runtime_ms);
CREATE INDEX IF NOT EXISTS idx_run_metrics_queue ON codex_kb.run_metrics (queue_latency_ms);

-- +goose Down
-- +goose NO TRANSACTION
ALTER DEFAULT PRIVILEGES IN SCHEMA codex_kb
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM facteur;
REVOKE USAGE ON SCHEMA codex_kb FROM facteur;
DROP TABLE IF EXISTS codex_kb.run_metrics;
DROP TABLE IF EXISTS codex_kb.policy_checks;
DROP TABLE IF EXISTS codex_kb.reflections;
DROP TABLE IF EXISTS codex_kb.artifacts;
DROP TABLE IF EXISTS codex_kb.run_events;
DROP TABLE IF EXISTS codex_kb.task_runs_history;
DROP TABLE IF EXISTS codex_kb.task_runs;
DROP TABLE IF EXISTS codex_kb.task_dependencies;
DROP TABLE IF EXISTS codex_kb.tasks;
DROP TABLE IF EXISTS codex_kb.ideas;
DROP SCHEMA IF EXISTS codex_kb;
