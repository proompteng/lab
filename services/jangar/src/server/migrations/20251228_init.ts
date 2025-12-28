import { sql, type Kysely } from 'kysely'

import type { Database } from '../db'

const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 1024

const isHostedOpenAiBaseUrl = (rawBaseUrl: string) => {
  try {
    return new URL(rawBaseUrl).hostname === 'api.openai.com'
  } catch {
    return rawBaseUrl.includes('api.openai.com')
  }
}

const loadEmbeddingDimension = (fallback: number) => {
  const dimension = Number.parseInt(process.env.OPENAI_EMBEDDING_DIMENSION ?? String(fallback), 10)
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new Error('OPENAI_EMBEDDING_DIMENSION must be a positive integer')
  }
  return dimension
}

const resolveEmbeddingDimension = () => {
  const apiBaseUrl = process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_API_BASE ?? DEFAULT_OPENAI_API_BASE_URL
  const hosted = isHostedOpenAiBaseUrl(apiBaseUrl)
  const fallback = hosted ? DEFAULT_OPENAI_EMBEDDING_DIMENSION : DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION
  return loadEmbeddingDimension(fallback)
}

export const up = async (db: Kysely<Database>) => {
  const embeddingDimension = resolveEmbeddingDimension()

  await sql`CREATE SCHEMA IF NOT EXISTS atlas;`.execute(db)
  await sql`CREATE SCHEMA IF NOT EXISTS memories;`.execute(db)
  await sql`CREATE SCHEMA IF NOT EXISTS codex_judge;`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.repositories')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      default_ref TEXT NOT NULL DEFAULT 'main',
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (name)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.file_keys')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      repository_id UUID NOT NULL REFERENCES atlas.repositories(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (repository_id, path)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.file_versions')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      file_key_id UUID NOT NULL REFERENCES atlas.file_keys(id) ON DELETE CASCADE,
      repository_ref TEXT NOT NULL DEFAULT 'main',
      repository_commit TEXT,
      content_hash TEXT NOT NULL DEFAULT '',
      language TEXT,
      byte_size INT,
      line_count INT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      source_timestamp TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (repository_commit IS NULL OR repository_commit <> ''),
      UNIQUE (file_key_id, repository_ref, repository_commit, content_hash)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.file_chunks')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
      chunk_index INT NOT NULL,
      start_line INT,
      end_line INT,
      content TEXT,
      token_count INT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (file_version_id, chunk_index)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.enrichments')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
      chunk_id UUID REFERENCES atlas.file_chunks(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (file_version_id, chunk_id, kind, source)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.embeddings')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      enrichment_id UUID NOT NULL REFERENCES atlas.enrichments(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimension INT NOT NULL,
      embedding vector(${sql.raw(String(embeddingDimension))}) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (enrichment_id, model, dimension)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.tree_sitter_facts')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
      node_type TEXT NOT NULL,
      match_text TEXT NOT NULL,
      start_line INT,
      end_line INT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (file_version_id, node_type, match_text, start_line, end_line)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.symbols')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      repository_id UUID NOT NULL REFERENCES atlas.repositories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (repository_id, normalized_name, kind, signature)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.symbol_defs')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol_id UUID NOT NULL REFERENCES atlas.symbols(id) ON DELETE CASCADE,
      file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
      start_line INT,
      end_line INT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (symbol_id, file_version_id, start_line, end_line)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.symbol_refs')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      symbol_id UUID NOT NULL REFERENCES atlas.symbols(id) ON DELETE CASCADE,
      file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
      start_line INT,
      end_line INT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (symbol_id, file_version_id, start_line, end_line)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.file_edges')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
      to_file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (from_file_version_id, to_file_version_id, kind)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.github_events')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      repository_id UUID REFERENCES atlas.repositories(id) ON DELETE SET NULL,
      delivery_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      repository TEXT NOT NULL,
      installation_id TEXT,
      sender_login TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::JSONB,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ,
      UNIQUE (delivery_id)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.ingestions')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES atlas.github_events(id) ON DELETE CASCADE,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      UNIQUE (event_id, workflow_id)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.event_files')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES atlas.github_events(id) ON DELETE CASCADE,
      file_key_id UUID NOT NULL REFERENCES atlas.file_keys(id) ON DELETE CASCADE,
      change_type TEXT NOT NULL,
      UNIQUE (event_id, file_key_id)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.ingestion_targets')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ingestion_id UUID NOT NULL REFERENCES atlas.ingestions(id) ON DELETE CASCADE,
      file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      UNIQUE (ingestion_id, file_version_id, kind)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('memories.entries')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      execution_id UUID NULL,
      task_name TEXT NOT NULL,
      task_description TEXT,
      repository_ref TEXT NOT NULL DEFAULT 'main',
      repository_commit TEXT,
      repository_path TEXT,
      content TEXT NOT NULL,
      summary TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
      source TEXT NOT NULL,
      embedding vector(${sql.raw(String(embeddingDimension))}) NOT NULL,
      encoder_model TEXT NOT NULL,
      encoder_version TEXT,
      last_accessed_at TIMESTAMPTZ,
      next_review_at TIMESTAMPTZ
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('codex_judge.runs')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      repository TEXT NOT NULL,
      issue_number BIGINT NOT NULL,
      branch TEXT NOT NULL,
      attempt INT NOT NULL,
      workflow_name TEXT NOT NULL,
      workflow_uid TEXT,
      workflow_namespace TEXT,
      stage TEXT,
      status TEXT NOT NULL,
      phase TEXT,
      prompt TEXT,
      next_prompt TEXT,
      commit_sha TEXT,
      pr_number INT,
      pr_url TEXT,
      ci_status TEXT,
      ci_url TEXT,
      review_status TEXT,
      review_summary JSONB NOT NULL DEFAULT '{}'::JSONB,
      notify_payload JSONB,
      run_complete_payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('codex_judge.artifacts')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES codex_judge.runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key TEXT NOT NULL,
      bucket TEXT,
      url TEXT,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('codex_judge.evaluations')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES codex_judge.runs(id) ON DELETE CASCADE,
      decision TEXT NOT NULL,
      confidence DOUBLE PRECISION,
      reasons JSONB NOT NULL DEFAULT '{}'::JSONB,
      missing_items JSONB NOT NULL DEFAULT '{}'::JSONB,
      suggested_fixes JSONB NOT NULL DEFAULT '{}'::JSONB,
      next_prompt TEXT,
      prompt_tuning JSONB NOT NULL DEFAULT '{}'::JSONB,
      system_suggestions JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('codex_judge.prompt_tuning')} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id UUID NOT NULL REFERENCES codex_judge.runs(id) ON DELETE CASCADE,
      pr_url TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS torghut_symbols (
      symbol TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT true,
      asset_class TEXT NOT NULL DEFAULT 'equity',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS codex_judge_runs_workflow_uid_idx
    ON ${sql.ref('codex_judge.runs')} (workflow_uid)
    WHERE workflow_uid IS NOT NULL;
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS codex_judge_runs_workflow_name_idx
    ON ${sql.ref('codex_judge.runs')} (workflow_name, workflow_namespace);
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS codex_judge_artifacts_run_name_idx
    ON ${sql.ref('codex_judge.artifacts')} (run_id, name);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_file_keys_path_idx
    ON ${sql.ref('atlas.file_keys')} (path text_pattern_ops);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_file_versions_ref_idx
    ON ${sql.ref('atlas.file_versions')} (repository_ref, repository_commit);
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS atlas_file_versions_hash_null_commit_idx
    ON ${sql.ref('atlas.file_versions')} (file_key_id, repository_ref, content_hash)
    WHERE repository_commit IS NULL;
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_file_versions_metadata_idx
    ON ${sql.ref('atlas.file_versions')} USING GIN (metadata JSONB_PATH_OPS);
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS atlas_enrichments_file_kind_source_null_chunk_idx
    ON ${sql.ref('atlas.enrichments')} (file_version_id, kind, source)
    WHERE chunk_id IS NULL;
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_enrichments_kind_idx
    ON ${sql.ref('atlas.enrichments')} (kind);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_enrichments_tags_idx
    ON ${sql.ref('atlas.enrichments')} USING GIN (tags);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_enrichments_metadata_idx
    ON ${sql.ref('atlas.enrichments')} USING GIN (metadata JSONB_PATH_OPS);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_embeddings_embedding_idx
    ON ${sql.ref('atlas.embeddings')}
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_symbols_lookup_idx
    ON ${sql.ref('atlas.symbols')} (normalized_name, kind);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_symbol_defs_file_idx
    ON ${sql.ref('atlas.symbol_defs')} (file_version_id);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_symbol_refs_file_idx
    ON ${sql.ref('atlas.symbol_refs')} (file_version_id);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_file_edges_from_idx
    ON ${sql.ref('atlas.file_edges')} (from_file_version_id, kind);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_file_edges_to_idx
    ON ${sql.ref('atlas.file_edges')} (to_file_version_id, kind);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS memories_entries_task_name_idx
    ON ${sql.ref('memories.entries')} (task_name);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS memories_entries_tags_idx
    ON ${sql.ref('memories.entries')} USING GIN (tags);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS memories_entries_metadata_idx
    ON ${sql.ref('memories.entries')} USING GIN (metadata JSONB_PATH_OPS);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS memories_entries_encoder_idx
    ON ${sql.ref('memories.entries')} (encoder_model, encoder_version);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS memories_entries_embedding_idx
    ON ${sql.ref('memories.entries')}
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_symbols_enabled_idx
    ON torghut_symbols (enabled);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS torghut_symbols_asset_class_idx
    ON torghut_symbols (asset_class);
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
