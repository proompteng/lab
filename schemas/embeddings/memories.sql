-- Schema for storing Codex execution memories and related semantic data.
-- Assumes PostgreSQL with the pgvector extension enabled (vector dimension configurable per model).

CREATE SCHEMA IF NOT EXISTS memories;

-- Enables pgvector so we can persist vector embeddings.
CREATE EXTENSION IF NOT EXISTS vector;

-- Main table for Codex memories.
CREATE TABLE IF NOT EXISTS memories.entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- optional linkage to a task log or execution run if you have one.
  execution_id UUID NULL,

  -- Human-readable provenance data.
  task_name TEXT NOT NULL,
  task_description TEXT,
  repository_ref TEXT NOT NULL DEFAULT 'main', -- branch/commit/tag
  repository_commit TEXT,
  repository_path TEXT,

  -- Semantic payloads.
  summary TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  source TEXT NOT NULL,

  -- Vector embedding column. Adjust dimension to match the LLM/encoder (default 1536 for text-embedding-3-small).
  embedding vector(1536) NOT NULL,
  encoder_model TEXT NOT NULL,
  encoder_version TEXT,

  -- Around the time this memory was last used in reasoning.
  last_accessed_at TIMESTAMPTZ,
  next_review_at TIMESTAMPTZ
);

-- Keep a lightweight log of memory lifecycle events.
CREATE TABLE IF NOT EXISTS memories.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES memories.entries(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'updated', 'retrieved', 'merged', 'archived')),
  event_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes to speed up namespace lookups and vector searches.
CREATE INDEX IF NOT EXISTS memories_entries_task_name_idx ON memories.entries (task_name);
CREATE INDEX IF NOT EXISTS memories_entries_tags_idx ON memories.entries USING GIN (tags);
CREATE INDEX IF NOT EXISTS memories_entries_metadata_idx ON memories.entries USING GIN (metadata JSONB_PATH_OPS);
CREATE INDEX IF NOT EXISTS memories_entries_encoder_idx ON memories.entries (encoder_model, encoder_version);

-- pgvector index for fast nearest-neighbor lookups.
CREATE INDEX IF NOT EXISTS memories_entries_embedding_idx ON memories.entries
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
