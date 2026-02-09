import { type Kysely, sql } from 'kysely'

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

  await sql`
    ALTER TABLE ${sql.ref('atlas.file_chunks')}
    ADD COLUMN IF NOT EXISTS text_tsvector tsvector;
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_file_chunks_file_version_id_idx
    ON ${sql.ref('atlas.file_chunks')} (file_version_id);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_file_chunks_text_tsvector_gin_idx
    ON ${sql.ref('atlas.file_chunks')} USING gin (text_tsvector);
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS ${sql.ref('atlas.chunk_embeddings')} (
      chunk_id UUID PRIMARY KEY REFERENCES atlas.file_chunks(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimension INT NOT NULL,
      embedding vector(${sql.raw(String(embeddingDimension))}) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_chunk_embeddings_model_dimension_idx
    ON ${sql.ref('atlas.chunk_embeddings')} (model, dimension);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_chunk_embeddings_embedding_idx
    ON ${sql.ref('atlas.chunk_embeddings')}
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
