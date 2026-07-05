import { type Kysely, sql } from 'kysely'

import type { AgentsDatabase } from '../db'
import { resolveEmbeddingConfig } from '../memory-config'
import { createPgvectorAnnIndexIfSupported } from '../pgvector-indexing'

const resolveEmbeddingDimension = () => resolveEmbeddingConfig(process.env).dimension

export const up = async (db: Kysely<AgentsDatabase>) => {
  const embeddingDimension = resolveEmbeddingDimension()

  await sql`
    CREATE TABLE IF NOT EXISTS memory_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dataset TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::JSONB
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS memory_events_dataset_created_at_idx
    ON memory_events (dataset, created_at DESC);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS memory_kv (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dataset TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB NOT NULL DEFAULT '{}'::JSONB,
      CONSTRAINT memory_kv_dataset_key_key UNIQUE (dataset, key)
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS memory_kv_dataset_key_idx
    ON memory_kv (dataset, key);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dataset TEXT NOT NULL,
      key TEXT NOT NULL,
      embedding vector(${sql.raw(String(embeddingDimension))}) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS memory_embeddings_dataset_key_idx
    ON memory_embeddings (dataset, key);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS memory_embeddings_metadata_idx
    ON memory_embeddings USING GIN (metadata JSONB_PATH_OPS);
  `.execute(db)

  await createPgvectorAnnIndexIfSupported(
    db,
    embeddingDimension,
    'CREATE INDEX IF NOT EXISTS memory_embeddings_embedding_idx ON memory_embeddings USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);',
    'memory_embeddings',
  )
}
