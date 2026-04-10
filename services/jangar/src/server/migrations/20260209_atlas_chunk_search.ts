import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'
import { resolveEmbeddingConfig } from '../memory-config'

const resolveEmbeddingDimension = () => resolveEmbeddingConfig(process.env).dimension

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
