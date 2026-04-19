import { type Kysely, sql } from 'kysely'

import type { Database } from '../db'
import { requestEmbeddings } from '../embedding-client'
import { resolveEmbeddingConfig } from '../memory-config'

const TARGET_DIMENSION = 4096
const BATCH_SIZE = 32
const MIN_TIMEOUT_MS = 120_000

type MigrationEmbeddingConfig = ReturnType<typeof resolveEmbeddingConfig> & {
  timeoutMs: number
}

type MemoryRow = {
  id: string
  created_at: Date | string
  updated_at: Date | string
  execution_id: string | null
  task_name: string
  task_description: string | null
  repository_ref: string
  repository_commit: string | null
  repository_path: string | null
  content: string
  summary: string
  metadata: Record<string, unknown> | null
  tags: string[] | null
  source: string
  last_accessed_at: Date | string | null
  next_review_at: Date | string | null
}

const vectorToPgArray = (values: readonly number[]) => `[${values.join(',')}]`

const textArray = (values: readonly string[]) =>
  values.length === 0 ? sql`ARRAY[]::text[]` : sql`ARRAY[${sql.join(values.map((value) => sql`${value}`))}]::text[]`

const logMigration = (event: string, fields: Record<string, unknown> = {}) => {
  console.log('[jangar:migration:20260418_embedding_dimension_4096]', { event, ...fields })
}

const resolveMigrationEmbeddingConfig = (): MigrationEmbeddingConfig | null => {
  const config = resolveEmbeddingConfig(process.env)
  if (config.dimension !== TARGET_DIMENSION) {
    return null
  }

  return {
    ...config,
    timeoutMs: Math.max(config.timeoutMs, MIN_TIMEOUT_MS),
  }
}

const readVectorDimension = async (db: Kysely<Database>, schema: string, table: string) => {
  const { rows } = await sql<{ embedding_type: string | null }>`
    SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS embedding_type
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema}
      AND c.relname = ${table}
      AND a.attname = 'embedding'
      AND a.attnum > 0
      AND NOT a.attisdropped;
  `.execute(db)

  const embeddingType = rows[0]?.embedding_type ?? null
  if (!embeddingType) return null
  const match = embeddingType.match(/vector\((\d+)\)/i)
  if (!match?.[1]) return null
  const dimension = Number.parseInt(match[1], 10)
  return Number.isFinite(dimension) ? dimension : null
}

const insertMemoriesBatch = async (
  db: Kysely<Database>,
  rows: readonly MemoryRow[],
  embeddings: readonly number[][],
  encoderModel: string,
) => {
  const values = rows.map((row, index) => {
    const embedding = embeddings[index]
    if (!embedding) {
      throw new Error(`missing migrated embedding for memories.entries row ${row.id}`)
    }
    return sql`(
      ${row.id},
      ${row.created_at},
      ${row.updated_at},
      ${row.execution_id},
      ${row.task_name},
      ${row.task_description},
      ${row.repository_ref},
      ${row.repository_commit},
      ${row.repository_path},
      ${row.content},
      ${row.summary},
      ${JSON.stringify(row.metadata ?? {})}::jsonb,
      ${textArray(row.tags ?? [])},
      ${row.source},
      ${vectorToPgArray(embedding)}::vector,
      ${encoderModel},
      ${null},
      ${row.last_accessed_at},
      ${row.next_review_at}
    )`
  })

  await sql`
    INSERT INTO memories.entries_4096_next (
      id,
      created_at,
      updated_at,
      execution_id,
      task_name,
      task_description,
      repository_ref,
      repository_commit,
      repository_path,
      content,
      summary,
      metadata,
      tags,
      source,
      embedding,
      encoder_model,
      encoder_version,
      last_accessed_at,
      next_review_at
    )
    VALUES ${sql.join(values)}
  `.execute(db)
}

const rebuildMemoriesEntries = async (db: Kysely<Database>, embeddingConfig: MigrationEmbeddingConfig) => {
  const currentDimension = await readVectorDimension(db, 'memories', 'entries')
  if (currentDimension === TARGET_DIMENSION) {
    logMigration('skip_memories_entries', { reason: 'already_4096' })
    return
  }
  const { rows } = await sql<MemoryRow>`
    SELECT
      id,
      created_at,
      updated_at,
      execution_id,
      task_name,
      task_description,
      repository_ref,
      repository_commit,
      repository_path,
      content,
      summary,
      metadata,
      tags,
      source,
      last_accessed_at,
      next_review_at
    FROM memories.entries
    ORDER BY created_at, id
  `.execute(db)

  logMigration('rebuild_memories_entries_started', {
    sourceDimension: currentDimension,
    rows: rows.length,
    model: embeddingConfig.model,
    dimension: embeddingConfig.dimension,
  })

  await sql.raw('DROP TABLE IF EXISTS memories.entries_4096_next CASCADE').execute(db)
  await sql.raw('DROP TABLE IF EXISTS memories.entries_1024_legacy CASCADE').execute(db)
  await sql
    .raw(`
    CREATE TABLE memories.entries_4096_next (
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
      embedding vector(4096) NOT NULL,
      encoder_model TEXT NOT NULL,
      encoder_version TEXT,
      last_accessed_at TIMESTAMPTZ,
      next_review_at TIMESTAMPTZ
    )
  `)
    .execute(db)
  await sql
    .raw('CREATE INDEX memories_entries_4096_next_task_name_idx ON memories.entries_4096_next (task_name)')
    .execute(db)
  await sql
    .raw('CREATE INDEX memories_entries_4096_next_tags_idx ON memories.entries_4096_next USING GIN (tags)')
    .execute(db)
  await sql
    .raw(
      'CREATE INDEX memories_entries_4096_next_metadata_idx ON memories.entries_4096_next USING GIN (metadata JSONB_PATH_OPS)',
    )
    .execute(db)
  await sql
    .raw(
      'CREATE INDEX memories_entries_4096_next_encoder_idx ON memories.entries_4096_next (encoder_model, encoder_version)',
    )
    .execute(db)
  await sql
    .raw(
      'CREATE INDEX memories_entries_4096_next_embedding_idx ON memories.entries_4096_next USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)',
    )
    .execute(db)

  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    const batch = rows.slice(start, start + BATCH_SIZE)
    const texts = batch.map((row) => (row.summary ? `${row.summary}\n\n${row.content}` : row.content))
    const embeddings = await requestEmbeddings(texts, embeddingConfig)
    await insertMemoriesBatch(db, batch, embeddings, embeddingConfig.model)
    logMigration('rebuild_memories_entries_progress', {
      processed: Math.min(start + batch.length, rows.length),
      total: rows.length,
    })
  }

  await db.transaction().execute(async (trx) => {
    await sql.raw('LOCK TABLE memories.entries IN ACCESS EXCLUSIVE MODE').execute(trx)
    await sql.raw('ALTER TABLE memories.entries RENAME TO entries_1024_legacy').execute(trx)
    await sql.raw('ALTER TABLE memories.entries_4096_next RENAME TO entries').execute(trx)
    await sql.raw('DROP TABLE memories.entries_1024_legacy').execute(trx)
  })

  logMigration('rebuild_memories_entries_completed', {
    rows: rows.length,
    dimension: TARGET_DIMENSION,
  })
}

const resetAtlasEmbeddings = async (db: Kysely<Database>) => {
  const currentDimension = await readVectorDimension(db, 'atlas', 'embeddings')
  if (currentDimension === TARGET_DIMENSION) {
    logMigration('skip_atlas_embeddings', { reason: 'already_4096' })
    return
  }

  const { rows } = await sql<{ count: string }>`SELECT count(*)::text AS count FROM atlas.embeddings`.execute(db)
  const clearedRows = Number.parseInt(rows[0]?.count ?? '0', 10)

  logMigration('reset_atlas_embeddings_started', {
    sourceDimension: currentDimension,
    clearedRows,
  })

  await sql.raw('DROP TABLE IF EXISTS atlas.embeddings_4096_next CASCADE').execute(db)
  await sql.raw('DROP TABLE IF EXISTS atlas.embeddings_1024_legacy CASCADE').execute(db)
  await sql
    .raw(`
    CREATE TABLE atlas.embeddings_4096_next (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      enrichment_id UUID NOT NULL REFERENCES atlas.enrichments(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimension INT NOT NULL,
      embedding vector(4096) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (enrichment_id, model, dimension)
    )
  `)
    .execute(db)
  await sql
    .raw(
      'CREATE INDEX atlas_embeddings_4096_next_embedding_idx ON atlas.embeddings_4096_next USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)',
    )
    .execute(db)

  await db.transaction().execute(async (trx) => {
    await sql.raw('LOCK TABLE atlas.embeddings IN ACCESS EXCLUSIVE MODE').execute(trx)
    await sql.raw('ALTER TABLE atlas.embeddings RENAME TO embeddings_1024_legacy').execute(trx)
    await sql.raw('ALTER TABLE atlas.embeddings_4096_next RENAME TO embeddings').execute(trx)
    await sql.raw('DROP TABLE atlas.embeddings_1024_legacy').execute(trx)
  })

  logMigration('reset_atlas_embeddings_completed', {
    clearedRows,
    dimension: TARGET_DIMENSION,
  })
}

const resetAtlasChunkEmbeddings = async (db: Kysely<Database>) => {
  const currentDimension = await readVectorDimension(db, 'atlas', 'chunk_embeddings')
  if (currentDimension === TARGET_DIMENSION) {
    logMigration('skip_atlas_chunk_embeddings', { reason: 'already_4096' })
    return
  }

  const { rows } = await sql<{ count: string }>`SELECT count(*)::text AS count FROM atlas.chunk_embeddings`.execute(db)
  const clearedRows = Number.parseInt(rows[0]?.count ?? '0', 10)

  logMigration('reset_atlas_chunk_embeddings_started', {
    sourceDimension: currentDimension,
    clearedRows,
  })

  await sql.raw('DROP TABLE IF EXISTS atlas.chunk_embeddings_4096_next CASCADE').execute(db)
  await sql.raw('DROP TABLE IF EXISTS atlas.chunk_embeddings_1024_legacy CASCADE').execute(db)
  await sql
    .raw(`
    CREATE TABLE atlas.chunk_embeddings_4096_next (
      chunk_id UUID PRIMARY KEY REFERENCES atlas.file_chunks(id) ON DELETE CASCADE,
      model TEXT NOT NULL,
      dimension INT NOT NULL,
      embedding vector(4096) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
    .execute(db)
  await sql
    .raw(
      'CREATE INDEX atlas_chunk_embeddings_4096_next_model_dimension_idx ON atlas.chunk_embeddings_4096_next (model, dimension)',
    )
    .execute(db)
  await sql
    .raw(
      'CREATE INDEX atlas_chunk_embeddings_4096_next_embedding_idx ON atlas.chunk_embeddings_4096_next USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)',
    )
    .execute(db)

  await db.transaction().execute(async (trx) => {
    await sql.raw('LOCK TABLE atlas.chunk_embeddings IN ACCESS EXCLUSIVE MODE').execute(trx)
    await sql.raw('ALTER TABLE atlas.chunk_embeddings RENAME TO chunk_embeddings_1024_legacy').execute(trx)
    await sql.raw('ALTER TABLE atlas.chunk_embeddings_4096_next RENAME TO chunk_embeddings').execute(trx)
    await sql.raw('DROP TABLE atlas.chunk_embeddings_1024_legacy').execute(trx)
  })

  logMigration('reset_atlas_chunk_embeddings_completed', {
    clearedRows,
    dimension: TARGET_DIMENSION,
  })
}

export const up = async (db: Kysely<Database>) => {
  const embeddingConfig = resolveMigrationEmbeddingConfig()
  if (!embeddingConfig) {
    logMigration('skip_all', { reason: 'configured_dimension_not_4096' })
    return
  }

  await rebuildMemoriesEntries(db, embeddingConfig)
  await resetAtlasEmbeddings(db)
  await resetAtlasChunkEmbeddings(db)
}

export const down = async (_db: Kysely<Database>) => {}
