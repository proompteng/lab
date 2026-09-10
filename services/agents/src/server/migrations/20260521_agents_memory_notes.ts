import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'
import { resolveEmbeddingConfig } from '../memory-config'
import { createPgvectorAnnIndexIfSupported } from '../pgvector-indexing'

const resolveEmbeddingDimension = () => resolveEmbeddingConfig(process.env).dimension

export const up = async (db: Kysely<AgentsDatabase>) => {
  const embeddingDimension = resolveEmbeddingDimension()

  await sql`CREATE SCHEMA IF NOT EXISTS memories;`.execute(db)

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

  await createPgvectorAnnIndexIfSupported(
    db,
    embeddingDimension,
    'CREATE INDEX IF NOT EXISTS memories_entries_embedding_idx ON memories.entries USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);',
    'memories.entries',
  )
}
