import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'kysely'

import { createAtlasCodeSearchHandlers } from '../atlas-code-search'
import { createKyselyDb, type Db } from '../db'
import { ensureMigrations } from '../kysely-migrations'

const databaseUrl = process.env.ATLAS_INTEGRATION_DATABASE_URL?.trim()
if (process.env.ATLAS_REQUIRE_INTEGRATION_TESTS === '1' && !databaseUrl) {
  throw new Error('ATLAS_INTEGRATION_DATABASE_URL is required when ATLAS_REQUIRE_INTEGRATION_TESTS=1')
}

const integration = databaseUrl ? describe : describe.skip

integration('Atlas code search PostgreSQL integration', () => {
  let db: Db
  let lockDb: Db
  let migrationEvidence: {
    embeddingType: string
    hasHnsw: boolean
    hasCurrentUnique: boolean
    hasPgTrgm: boolean
    repositoryStatus: string | null
    counts: {
      repositories: number
      fileKeys: number
      githubEvents: number
      ingestions: number
      eventFiles: number
      ingestionTargets: number
    }
  }
  const embeddedInputs: string[] = []
  const previousStatementTimeout = process.env.ATLAS_CODE_SEARCH_STATEMENT_TIMEOUT_MS
  const previousSemanticTimeout = process.env.ATLAS_CODE_SEARCH_SEMANTIC_TIMEOUT_MS

  beforeAll(async () => {
    if (!databaseUrl) throw new Error('integration database was not configured')
    process.env.ATLAS_CODE_SEARCH_STATEMENT_TIMEOUT_MS = '250'
    process.env.ATLAS_CODE_SEARCH_SEMANTIC_TIMEOUT_MS = '300'
    db = createKyselyDb(databaseUrl)
    lockDb = createKyselyDb(databaseUrl)
    await sql`DROP SCHEMA IF EXISTS atlas CASCADE;`.execute(db)
    await sql`
      DO $$
      BEGIN
        IF to_regclass('public.kysely_migration') IS NOT NULL THEN
          EXECUTE $migration$
            DELETE FROM public.kysely_migration
            WHERE name IN (
              '20251228_init',
              '20260209_atlas_chunk_search',
              '20260531_atlas_code_search_performance_indexes',
              '20260714_atlas_current_corpus'
            )
          $migration$;
        END IF;
      END
      $$;
    `.execute(db)
    await sql`CREATE SCHEMA atlas;`.execute(db)
    await sql`DROP EXTENSION IF EXISTS pg_trgm CASCADE;`.execute(db)
    await sql`CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;`.execute(db)
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;`.execute(db)
    await sql`
      CREATE TABLE atlas.repositories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL UNIQUE,
        default_ref text NOT NULL DEFAULT 'main',
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE atlas.file_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        repository_id uuid NOT NULL REFERENCES atlas.repositories(id) ON DELETE CASCADE,
        path text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (repository_id, path)
      );
      CREATE TABLE atlas.file_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        file_key_id uuid NOT NULL REFERENCES atlas.file_keys(id) ON DELETE CASCADE,
        repository_ref text NOT NULL DEFAULT 'main',
        repository_commit text,
        content_hash text NOT NULL DEFAULT '',
        language text,
        byte_size int,
        line_count int,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        source_timestamp timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (repository_commit IS NULL OR repository_commit <> ''),
        UNIQUE (file_key_id, repository_ref, repository_commit, content_hash)
      );
      CREATE TABLE atlas.github_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        repository_id uuid REFERENCES atlas.repositories(id) ON DELETE SET NULL,
        delivery_id text NOT NULL UNIQUE,
        event_type text NOT NULL,
        repository text NOT NULL,
        installation_id text,
        sender_login text,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        received_at timestamptz NOT NULL DEFAULT now(),
        processed_at timestamptz
      );
      CREATE TABLE atlas.ingestions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES atlas.github_events(id) ON DELETE CASCADE,
        workflow_id text NOT NULL,
        status text NOT NULL,
        error text,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz,
        UNIQUE (event_id, workflow_id)
      );
      CREATE TABLE atlas.event_files (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        event_id uuid NOT NULL REFERENCES atlas.github_events(id) ON DELETE CASCADE,
        file_key_id uuid NOT NULL REFERENCES atlas.file_keys(id) ON DELETE CASCADE,
        change_type text NOT NULL,
        UNIQUE (event_id, file_key_id)
      );
      CREATE TABLE atlas.ingestion_targets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        ingestion_id uuid NOT NULL REFERENCES atlas.ingestions(id) ON DELETE CASCADE,
        file_version_id uuid NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
        kind text NOT NULL,
        UNIQUE (ingestion_id, file_version_id, kind)
      );
    `.execute(db)
    await sql`
      WITH repository AS (
        INSERT INTO atlas.repositories (name, default_ref, metadata)
        VALUES ('proompteng/lab', 'main', '{"indexStatus":"ready","indexedCommit":"stale"}'::jsonb)
        RETURNING id
      ), file_key AS (
        INSERT INTO atlas.file_keys (repository_id, path)
        SELECT id, 'stale.ts' FROM repository
        RETURNING id
      ), file_version AS (
        INSERT INTO atlas.file_versions (file_key_id, repository_ref, repository_commit, content_hash, metadata)
        SELECT id, 'main', 'stale', 'stale-hash', '{}'::jsonb FROM file_key
        RETURNING id
      ), event AS (
        INSERT INTO atlas.github_events (repository_id, delivery_id, event_type, repository, payload)
        SELECT id, 'delivery-before-reset', 'push', 'proompteng/lab', '{}'::jsonb FROM repository
        RETURNING id
      ), ingestion AS (
        INSERT INTO atlas.ingestions (event_id, workflow_id, status)
        SELECT id, 'workflow-before-reset', 'completed' FROM event
        RETURNING id
      ), event_file AS (
        INSERT INTO atlas.event_files (event_id, file_key_id, change_type)
        SELECT event.id, file_key.id, 'modified' FROM event CROSS JOIN file_key
      )
      INSERT INTO atlas.ingestion_targets (ingestion_id, file_version_id, kind)
      SELECT ingestion.id, file_version.id, 'index' FROM ingestion CROSS JOIN file_version;
    `.execute(db)
    await ensureMigrations(db)
    const migrationRows = await sql<{
      embedding_type: string
      has_hnsw: boolean
      has_current_unique: boolean
      has_pg_trgm: boolean
      repository_status: string | null
      repositories: number
      file_keys: number
      github_events: number
      ingestions: number
      event_files: number
      ingestion_targets: number
    }>`
      SELECT
        format_type(a.atttypid, a.atttypmod) AS embedding_type,
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'atlas' AND indexname = 'atlas_chunk_embeddings_embedding_hnsw_idx'
        ) AS has_hnsw,
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'atlas' AND indexname = 'atlas_file_versions_file_key_id_unique_idx'
        ) AS has_current_unique,
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS has_pg_trgm,
        (SELECT metadata->>'indexStatus' FROM atlas.repositories WHERE name = 'proompteng/lab') AS repository_status,
        (SELECT count(*)::int FROM atlas.repositories) AS repositories,
        (SELECT count(*)::int FROM atlas.file_keys) AS file_keys,
        (SELECT count(*)::int FROM atlas.github_events) AS github_events,
        (SELECT count(*)::int FROM atlas.ingestions) AS ingestions,
        (SELECT count(*)::int FROM atlas.event_files) AS event_files,
        (SELECT count(*)::int FROM atlas.ingestion_targets) AS ingestion_targets
      FROM pg_attribute a
      WHERE a.attrelid = 'atlas.chunk_embeddings'::regclass
        AND a.attname = 'embedding';
    `.execute(db)
    const migration = migrationRows.rows[0]
    migrationEvidence = {
      embeddingType: migration?.embedding_type ?? '',
      hasHnsw: migration?.has_hnsw ?? false,
      hasCurrentUnique: migration?.has_current_unique ?? false,
      hasPgTrgm: migration?.has_pg_trgm ?? false,
      repositoryStatus: migration?.repository_status ?? null,
      counts: {
        repositories: migration?.repositories ?? -1,
        fileKeys: migration?.file_keys ?? -1,
        githubEvents: migration?.github_events ?? -1,
        ingestions: migration?.ingestions ?? -1,
        eventFiles: migration?.event_files ?? -1,
        ingestionTargets: migration?.ingestion_targets ?? -1,
      },
    }
    await sql`DROP SCHEMA atlas CASCADE;`.execute(db)
    await sql`CREATE SCHEMA atlas;`.execute(db)
    await sql`
      CREATE TABLE atlas.repositories (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL UNIQUE,
        default_ref text NOT NULL DEFAULT 'main',
        metadata jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE atlas.file_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        repository_id uuid NOT NULL REFERENCES atlas.repositories(id) ON DELETE CASCADE,
        path text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (repository_id, path)
      );
      CREATE TABLE atlas.file_versions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        file_key_id uuid NOT NULL UNIQUE REFERENCES atlas.file_keys(id) ON DELETE CASCADE,
        repository_ref text NOT NULL,
        repository_commit text,
        content_hash text NOT NULL,
        language text,
        byte_size int,
        line_count int,
        metadata jsonb NOT NULL,
        source_timestamp timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE atlas.file_chunks (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        file_version_id uuid NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
        chunk_index int NOT NULL,
        start_line int,
        end_line int,
        content text,
        text_tsvector tsvector,
        token_count int,
        metadata jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (file_version_id, chunk_index)
      );
      CREATE TABLE atlas.chunk_embeddings (
        chunk_id uuid PRIMARY KEY REFERENCES atlas.file_chunks(id) ON DELETE CASCADE,
        model text NOT NULL,
        dimension int NOT NULL,
        embedding vector(3) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `.execute(db)
    await sql`
      WITH repository AS (
        INSERT INTO atlas.repositories (name, default_ref, metadata)
        VALUES (
          'proompteng/lab',
          'main',
          ${JSON.stringify({
            indexStatus: 'ready',
            indexedCommit: 'deadbeef',
            gitHead: 'deadbeef',
            treeHash: 'tree-hash',
            embeddingModel: 'atlas-test-model',
            embeddingDimension: 3,
            expectedFiles: 2,
            indexedFiles: 2,
            missingPaths: 0,
            stalePaths: 0,
            hashMismatches: 0,
            uncoveredLines: 0,
            indexedChunks: 2,
            embeddedChunks: 2,
          })}::jsonb
        )
        RETURNING id
      ), file_keys AS (
        INSERT INTO atlas.file_keys (repository_id, path)
        SELECT id, 'services/jangar/src/server/atlas-code-search.ts' FROM repository
        UNION ALL
        SELECT id, 'services/bumba/src/atlas/file-eligibility.ts' FROM repository
        RETURNING id, path
      ), versions AS (
        INSERT INTO atlas.file_versions (
          file_key_id, repository_ref, repository_commit, content_hash, language, metadata
        )
        SELECT id, 'main', 'deadbeef', encode(digest(path, 'sha256'), 'hex'), 'typescript', '{}'::jsonb
        FROM file_keys
        RETURNING id, file_key_id
      ), chunks AS (
        INSERT INTO atlas.file_chunks (
          file_version_id, chunk_index, start_line, end_line, content, text_tsvector, token_count, metadata
        )
        SELECT
          versions.id,
          0,
          1,
          20,
          CASE
            WHEN file_keys.path LIKE '%atlas-code-search.ts'
              THEN 'export const createAtlasCodeSearchHandlers = () => full HNSW code search'
            ELSE '// createAtlasCodeSearchHandlers is referenced here\nexport const shouldSkipAtlasPath = path => versioned Git file eligibility'
          END,
          to_tsvector(
            'simple',
            CASE
              WHEN file_keys.path LIKE '%atlas-code-search.ts'
                THEN 'export const createAtlasCodeSearchHandlers = () => full HNSW code search'
              ELSE '// createAtlasCodeSearchHandlers is referenced here\nexport const shouldSkipAtlasPath = path => versioned Git file eligibility'
            END
          ),
          10,
          '{}'::jsonb
        FROM versions
        JOIN file_keys ON file_keys.id = versions.file_key_id
        RETURNING id, content
      )
      INSERT INTO atlas.chunk_embeddings (chunk_id, model, dimension, embedding)
      SELECT
        id,
        'atlas-test-model',
        3,
        CASE WHEN content LIKE '%createAtlasCodeSearchHandlers%' THEN '[1,0,0]'::vector ELSE '[0,1,0]'::vector END
      FROM chunks;
    `.execute(db)
    await sql`
      CREATE INDEX atlas_chunk_embeddings_embedding_hnsw_idx
      ON atlas.chunk_embeddings USING hnsw (embedding vector_cosine_ops);
    `.execute(db)
  })

  afterAll(async () => {
    await lockDb?.destroy()
    await db?.destroy()
    if (previousStatementTimeout === undefined) delete process.env.ATLAS_CODE_SEARCH_STATEMENT_TIMEOUT_MS
    else process.env.ATLAS_CODE_SEARCH_STATEMENT_TIMEOUT_MS = previousStatementTimeout
    if (previousSemanticTimeout === undefined) delete process.env.ATLAS_CODE_SEARCH_SEMANTIC_TIMEOUT_MS
    else process.env.ATLAS_CODE_SEARCH_SEMANTIC_TIMEOUT_MS = previousSemanticTimeout
  })

  const handlers = () =>
    createAtlasCodeSearchHandlers({
      db,
      ensureSchema: async () => undefined,
      loadEmbeddingConfig: () => ({
        apiBaseUrl: 'http://embedding.test/v1',
        apiKey: null,
        model: 'atlas-test-model',
        dimension: 3,
        timeoutMs: 1_000,
        maxInputChars: 60_000,
        hosted: false,
        hasExplicitBaseUrl: true,
        allowDevFallback: false,
      }),
      embedText: async (text) => {
        embeddedInputs.push(text)
        return [1, 0, 0]
      },
      normalizeText: (value, field) => {
        const normalized = value.trim()
        if (!normalized) throw new Error(`${field} is required`)
        return normalized
      },
    })

  it('resets only the derived corpus and bootstraps pg_trgm on real PostgreSQL', () => {
    expect(migrationEvidence).toEqual({
      embeddingType: 'vector(1024)',
      hasHnsw: true,
      hasCurrentUnique: true,
      hasPgTrgm: true,
      repositoryStatus: 'maintenance',
      counts: {
        repositories: 1,
        fileKeys: 0,
        githubEvents: 1,
        ingestions: 1,
        eventFiles: 0,
        ingestionTargets: 0,
      },
    })
  })

  it('ranks exact identifiers first and searches the current ready commit', async () => {
    const matches = await handlers().codeSearch({
      query: 'createAtlasCodeSearchHandlers',
      repository: 'proompteng/lab',
      ref: 'main',
      limit: 2,
    })

    expect(matches[0]).toMatchObject({
      fileKey: { path: 'services/jangar/src/server/atlas-code-search.ts' },
      fileVersion: { repositoryCommit: 'deadbeef' },
      retrievalMode: 'hybrid',
      degradation: null,
    })
    expect(embeddedInputs.at(-1)).toBe(
      'Instruct: Given a query, retrieve relevant source-code chunks from the repository\nQuery: createAtlasCodeSearchHandlers',
    )
  })

  it('returns no deleted or unknown path', async () => {
    const matches = await handlers().codeSearch({
      query: 'services/deleted/old-atlas.ts',
      repository: 'proompteng/lab',
      ref: 'main',
      limit: 10,
    })
    expect(matches.every((match) => match.fileKey.path !== 'services/deleted/old-atlas.ts')).toBe(true)
  })

  it('cancels a lock-blocked SQL statement through PostgreSQL statement_timeout', async () => {
    let releaseLock: (() => void) | undefined
    let lockReady: (() => void) | undefined
    const ready = new Promise<void>((resolve) => {
      lockReady = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const locker = lockDb.transaction().execute(async (transaction) => {
      await sql`LOCK TABLE atlas.chunk_embeddings IN ACCESS EXCLUSIVE MODE;`.execute(transaction)
      lockReady?.()
      await release
    })
    await ready

    const startedAt = performance.now()
    try {
      await expect(
        handlers().codeSearch({ query: 'blocked semantic search', repository: 'proompteng/lab', ref: 'main' }),
      ).rejects.toThrow(/statement timeout|canceling statement/i)
    } finally {
      releaseLock?.()
      await locker
    }
    const durationMs = performance.now() - startedAt
    expect(durationMs).toBeLessThan(1_000)

    const active = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM pg_stat_activity
      WHERE state = 'active'
        AND query ILIKE '%atlas.chunk_embeddings%'
        AND pid <> pg_backend_pid();
    `.execute(db)
    expect(Number(active.rows[0]?.count ?? 0)).toBe(0)
  })
})
