import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

export const up = async (db: Kysely<Database>) => {
  await sql`
    CREATE INDEX IF NOT EXISTS atlas_file_versions_latest_idx
    ON atlas.file_versions (file_key_id, repository_ref, updated_at DESC, created_at DESC, id DESC);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_file_chunks_created_at_idx
    ON atlas.file_chunks (created_at DESC);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_file_chunks_file_version_created_idx
    ON atlas.file_chunks (file_version_id, created_at DESC);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_file_keys_repository_path_idx
    ON atlas.file_keys (repository_id, path text_pattern_ops);
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS atlas_chunk_embeddings_model_dimension_chunk_idx
    ON atlas.chunk_embeddings (model, dimension, chunk_id);
  `.execute(db)
}

export const down = async (db: Kysely<Database>) => {
  await sql`DROP INDEX IF EXISTS atlas.atlas_chunk_embeddings_model_dimension_chunk_idx;`.execute(db)
  await sql`DROP INDEX IF EXISTS atlas.atlas_file_keys_repository_path_idx;`.execute(db)
  await sql`DROP INDEX IF EXISTS atlas.atlas_file_chunks_file_version_created_idx;`.execute(db)
  await sql`DROP INDEX IF EXISTS atlas.atlas_file_chunks_created_at_idx;`.execute(db)
  await sql`DROP INDEX IF EXISTS atlas.atlas_file_versions_latest_idx;`.execute(db)
}
