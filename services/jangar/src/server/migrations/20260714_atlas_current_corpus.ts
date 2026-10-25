import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'

const ATLAS_EMBEDDING_DIMENSION = 1024

export const up = async (db: Kysely<Database>) => {
  // The indexed corpus is disposable derived state. Keep repository identities and webhook/ingestion history, while
  // clearing every row that is derived from Git and every association that points into that corpus.
  await sql`TRUNCATE TABLE atlas.file_keys, atlas.symbols CASCADE;`.execute(db)

  await sql`
    UPDATE atlas.repositories
    SET default_ref = 'main',
        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
          'indexStatus', 'maintenance',
          'indexedCommit', NULL,
          'targetCommit', NULL,
          'gitHead', NULL,
          'treeHash', NULL,
          'expectedFiles', 0,
          'indexedFiles', 0,
          'missingPaths', 0,
          'stalePaths', 0,
          'hashMismatches', 0,
          'uncoveredLines', 0,
          'indexedChunks', 0,
          'embeddedChunks', 0,
          'embeddingDimension', ${sql.raw(String(ATLAS_EMBEDDING_DIMENSION))},
          'lastError', NULL,
          'resetAt', now()
        ),
        updated_at = now();
  `.execute(db)

  await sql`DROP INDEX IF EXISTS atlas.atlas_chunk_embeddings_embedding_idx;`.execute(db)
  await sql`DROP INDEX IF EXISTS atlas.atlas_file_versions_hash_null_commit_idx;`.execute(db)

  await sql`
    DO $$
    DECLARE
      constraint_name text;
    BEGIN
      FOR constraint_name IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'atlas.file_versions'::regclass
          AND contype = 'u'
      LOOP
        EXECUTE format('ALTER TABLE atlas.file_versions DROP CONSTRAINT %I', constraint_name);
      END LOOP;
    END
    $$;
  `.execute(db)

  await sql`
    ALTER TABLE atlas.chunk_embeddings
    ALTER COLUMN embedding TYPE vector(${sql.raw(String(ATLAS_EMBEDDING_DIMENSION))});
  `.execute(db)

  await sql`
    CREATE UNIQUE INDEX atlas_file_versions_file_key_id_unique_idx
    ON atlas.file_versions (file_key_id);
  `.execute(db)

  await sql`
    CREATE INDEX atlas_chunk_embeddings_embedding_hnsw_idx
    ON atlas.chunk_embeddings USING hnsw (embedding vector_cosine_ops);
  `.execute(db)

  await sql`
    CREATE INDEX atlas_file_keys_path_trgm_idx
    ON atlas.file_keys USING gin (path gin_trgm_ops);
  `.execute(db)

  await sql`
    CREATE INDEX atlas_file_chunks_content_trgm_idx
    ON atlas.file_chunks USING gin (content gin_trgm_ops)
    WHERE content IS NOT NULL;
  `.execute(db)

  await sql`
    ALTER TABLE atlas.repositories
    ADD CONSTRAINT atlas_repositories_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object');
  `.execute(db)

  await sql`
    ALTER TABLE atlas.file_versions
    ADD CONSTRAINT atlas_file_versions_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object');
  `.execute(db)

  await sql`
    ALTER TABLE atlas.file_chunks
    ADD CONSTRAINT atlas_file_chunks_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object');
  `.execute(db)

  await sql`
    ALTER TABLE atlas.enrichments
    ADD CONSTRAINT atlas_enrichments_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object');
  `.execute(db)

  await sql`
    ALTER TABLE atlas.tree_sitter_facts
    ADD CONSTRAINT atlas_tree_sitter_facts_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object');
  `.execute(db)

  await sql`
    ALTER TABLE atlas.github_events
    ADD CONSTRAINT atlas_github_events_payload_object_check
    CHECK (jsonb_typeof(payload) = 'object');
  `.execute(db)
}

export const down = async (_db: Kysely<Database>) => {}
