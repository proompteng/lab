-- +goose Up
-- +goose NO TRANSACTION
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

CREATE SCHEMA IF NOT EXISTS codex_kb AUTHORIZATION facteur;

CREATE TABLE IF NOT EXISTS codex_kb.runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_slug TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  workflow TEXT NOT NULL,
  run_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE codex_kb.runs OWNER TO facteur;

CREATE TABLE IF NOT EXISTS codex_kb.entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES codex_kb.runs(id) ON DELETE CASCADE,
  step_label TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  artifact_stage TEXT NOT NULL,
  embedding public.vector(1536),
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE codex_kb.entries OWNER TO facteur;

CREATE INDEX IF NOT EXISTS codex_kb_entries_embedding_idx
  ON codex_kb.entries
  USING ivfflat (embedding public.vector_cosine_ops)
  WITH (lists = 100);

GRANT USAGE ON SCHEMA codex_kb TO facteur;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA codex_kb TO facteur;
ALTER DEFAULT PRIVILEGES IN SCHEMA codex_kb
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO facteur;

-- +goose Down
-- +goose NO TRANSACTION
ALTER DEFAULT PRIVILEGES IN SCHEMA codex_kb
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM facteur;
REVOKE SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA codex_kb FROM facteur;
REVOKE USAGE ON SCHEMA codex_kb FROM facteur;
DROP INDEX IF EXISTS codex_kb_entries_embedding_idx;
DROP TABLE IF EXISTS codex_kb.entries;
DROP TABLE IF EXISTS codex_kb.runs;
DROP SCHEMA IF EXISTS codex_kb;
DROP EXTENSION IF EXISTS vector;
DROP EXTENSION IF EXISTS pgcrypto;
