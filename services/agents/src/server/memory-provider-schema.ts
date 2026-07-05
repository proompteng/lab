import type { Pool } from 'pg'

import { MAX_PGVECTOR_ANN_DIMENSION, supportsPgvectorAnnIndex } from './pgvector-indexing'

export type MemoryProviderSchemaConnection = {
  schema: string
  embeddingDimension: number
}

export type MemoryProviderQueryable = Pick<Pool, 'query'>

const REQUIRED_EXTENSIONS = ['vector', 'pgcrypto'] as const
const PREFERRED_IVFFLAT_LISTS = 100
const PREFERRED_IVFFLAT_ROWS_PER_LIST = 1000
const MIN_IVFFLAT_INDEX_ROWS = PREFERRED_IVFFLAT_LISTS * PREFERRED_IVFFLAT_ROWS_PER_LIST

const quoteIdentifier = (identifier: string) => {
  const normalized = identifier.trim()
  if (!normalized) throw new Error('Postgres identifier cannot be empty')
  if (normalized.includes('\0')) throw new Error('Postgres identifier cannot contain a NUL byte')
  return `"${normalized.replace(/"/g, '""')}"`
}

const normalizeEmbeddingDimension = (dimension: number) => {
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new Error(`memory embedding dimension must be a positive integer; got ${dimension}`)
  }
  return Math.floor(dimension)
}

export const qualifyMemoryProviderTable = (schema: string, table: string) =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`

export const getMemoryProviderSchemaStatements = (dimension: number, schema: string) => {
  const embeddingDimension = normalizeEmbeddingDimension(dimension)
  const eventsTable = qualifyMemoryProviderTable(schema, 'memory_events')
  const kvTable = qualifyMemoryProviderTable(schema, 'memory_kv')
  const embeddingsTable = qualifyMemoryProviderTable(schema, 'memory_embeddings')

  return [
    `CREATE TABLE IF NOT EXISTS ${eventsTable} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dataset TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::JSONB
    );`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier('memory_events_dataset_created_at_idx')}
    ON ${eventsTable} (dataset, created_at DESC);`,
    `CREATE TABLE IF NOT EXISTS ${kvTable} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dataset TEXT NOT NULL,
      key TEXT NOT NULL,
      value JSONB NOT NULL DEFAULT '{}'::JSONB,
      CONSTRAINT ${quoteIdentifier('memory_kv_dataset_key_key')} UNIQUE (dataset, key)
    );`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier('memory_kv_dataset_key_idx')}
    ON ${kvTable} (dataset, key);`,
    `CREATE TABLE IF NOT EXISTS ${embeddingsTable} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dataset TEXT NOT NULL,
      key TEXT NOT NULL,
      embedding vector(${embeddingDimension}) NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::JSONB
    );`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier('memory_embeddings_dataset_key_idx')}
    ON ${embeddingsTable} (dataset, key);`,
    `CREATE INDEX IF NOT EXISTS ${quoteIdentifier('memory_embeddings_metadata_idx')}
    ON ${embeddingsTable} USING GIN (metadata JSONB_PATH_OPS);`,
  ]
}

const getMemoryProviderAnnIndexStatement = (dimension: number, schema: string, lists: number) => {
  normalizeEmbeddingDimension(dimension)
  const normalizedLists = Math.max(1, Math.floor(lists))
  const embeddingsTable = qualifyMemoryProviderTable(schema, 'memory_embeddings')
  return `CREATE INDEX IF NOT EXISTS ${quoteIdentifier('memory_embeddings_embedding_idx')}
    ON ${embeddingsTable} USING ivfflat (embedding vector_cosine_ops) WITH (lists = ${normalizedLists});`
}

const estimateIvfflatLists = (rowCount: number) => {
  if (rowCount < 1_000_000) return Math.max(1, Math.floor(rowCount / PREFERRED_IVFFLAT_ROWS_PER_LIST))
  return Math.max(1, Math.floor(Math.sqrt(rowCount)))
}

export const ensureMemoryProviderExtensions = async (db: MemoryProviderQueryable) => {
  const { rows } = await db.query<{ extname: string }>(
    'SELECT extname FROM pg_extension WHERE extname = ANY($1::text[])',
    [[...REQUIRED_EXTENSIONS]],
  )

  const installed = new Set(rows.map((row) => row.extname))
  const missing = REQUIRED_EXTENSIONS.filter((ext) => !installed.has(ext))
  if (missing.length > 0) {
    throw new Error(
      `missing required Postgres extensions in Memory provider database: ${missing.join(', ')}. ` +
        'Install them as a privileged user (e.g. `CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;`) ' +
        'before using postgres Memory providers.',
    )
  }
}

export const ensureMemoryProviderSchema = async (
  db: MemoryProviderQueryable,
  connection: MemoryProviderSchemaConnection,
) => {
  await ensureMemoryProviderExtensions(db)
  for (const statement of getMemoryProviderSchemaStatements(connection.embeddingDimension, connection.schema)) {
    await db.query(statement)
  }
}

export const createMemoryProviderAnnIndexIfReady = async (
  db: MemoryProviderQueryable,
  connection: MemoryProviderSchemaConnection,
) => {
  if (!supportsPgvectorAnnIndex(connection.embeddingDimension)) {
    console.log('[agents:pgvector]', {
      event: 'skip_ann_index',
      context: `${connection.schema}.memory_embeddings`,
      dimension: connection.embeddingDimension,
      maxSupportedDimension: MAX_PGVECTOR_ANN_DIMENSION,
    })
    return false
  }

  const embeddingsTable = qualifyMemoryProviderTable(connection.schema, 'memory_embeddings')
  const { rows } = await db.query<{ row_count: string | number }>(
    `SELECT COUNT(*)::bigint AS row_count FROM ${embeddingsTable}`,
  )
  const rowCount = Number(rows[0]?.row_count ?? 0)
  if (!Number.isFinite(rowCount) || rowCount < MIN_IVFFLAT_INDEX_ROWS) return false

  await db.query(
    getMemoryProviderAnnIndexStatement(
      connection.embeddingDimension,
      connection.schema,
      estimateIvfflatLists(rowCount),
    ),
  )
  return true
}

export const __test__ = {
  getMemoryProviderAnnIndexStatement,
  quoteIdentifier,
}
