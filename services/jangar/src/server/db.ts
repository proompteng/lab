import { existsSync, readFileSync } from 'node:fs'
import { type ColumnType, type Generated, type JSONColumnType, Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

type JsonRecord = Record<string, unknown>
type Jsonb = JSONColumnType<JsonRecord, string, string>
type TextArray = ColumnType<string[], string[] | string, string[] | string>
type Vector = ColumnType<string, string, string>
type Uuid = ColumnType<string, string, string>
type GeneratedUuid = Generated<string>
type GeneratedTimestamptz = ColumnType<Date, Date | string | undefined, Date | string | undefined>
type NullableTimestamptz = ColumnType<Date | null, Date | string | null, Date | string | null>

export type MemoriesEntriesTable = {
  id: GeneratedUuid
  created_at: GeneratedTimestamptz
  updated_at: GeneratedTimestamptz
  execution_id: Uuid | null
  task_name: string
  task_description: string | null
  repository_ref: string
  repository_commit: string | null
  repository_path: string | null
  content: string
  summary: string
  metadata: Jsonb
  tags: TextArray
  source: string
  embedding: Vector
  encoder_model: string
  encoder_version: string | null
  last_accessed_at: NullableTimestamptz
  next_review_at: NullableTimestamptz
}

export type AtlasRepositoriesTable = {
  id: GeneratedUuid
  name: string
  default_ref: string
  metadata: Jsonb
  created_at: GeneratedTimestamptz
  updated_at: GeneratedTimestamptz
}

export type AtlasFileKeysTable = {
  id: GeneratedUuid
  repository_id: Uuid
  path: string
  created_at: GeneratedTimestamptz
}

export type AtlasFileVersionsTable = {
  id: GeneratedUuid
  file_key_id: Uuid
  repository_ref: string
  repository_commit: string | null
  content_hash: string
  language: string | null
  byte_size: number | null
  line_count: number | null
  metadata: Jsonb
  source_timestamp: NullableTimestamptz
  created_at: GeneratedTimestamptz
  updated_at: GeneratedTimestamptz
}

export type AtlasFileChunksTable = {
  id: GeneratedUuid
  file_version_id: Uuid
  chunk_index: number
  start_line: number | null
  end_line: number | null
  content: string | null
  token_count: number | null
  metadata: Jsonb
  created_at: GeneratedTimestamptz
}

export type AtlasEnrichmentsTable = {
  id: GeneratedUuid
  file_version_id: Uuid
  chunk_id: Uuid | null
  kind: string
  source: string
  content: string
  summary: string | null
  tags: TextArray
  metadata: Jsonb
  created_at: GeneratedTimestamptz
}

export type AtlasEmbeddingsTable = {
  id: GeneratedUuid
  enrichment_id: Uuid
  model: string
  dimension: number
  embedding: Vector
  created_at: GeneratedTimestamptz
}

export type AtlasTreeSitterFactsTable = {
  id: GeneratedUuid
  file_version_id: Uuid
  node_type: string
  match_text: string
  start_line: number | null
  end_line: number | null
  metadata: Jsonb
  created_at: GeneratedTimestamptz
}

export type AtlasSymbolsTable = {
  id: GeneratedUuid
  repository_id: Uuid
  name: string
  normalized_name: string
  kind: string
  signature: string
  metadata: Jsonb
  created_at: GeneratedTimestamptz
}

export type AtlasSymbolDefsTable = {
  id: GeneratedUuid
  symbol_id: Uuid
  file_version_id: Uuid
  start_line: number | null
  end_line: number | null
  metadata: Jsonb
  created_at: GeneratedTimestamptz
}

export type AtlasSymbolRefsTable = {
  id: GeneratedUuid
  symbol_id: Uuid
  file_version_id: Uuid
  start_line: number | null
  end_line: number | null
  metadata: Jsonb
  created_at: GeneratedTimestamptz
}

export type AtlasFileEdgesTable = {
  id: GeneratedUuid
  from_file_version_id: Uuid
  to_file_version_id: Uuid
  kind: string
  metadata: Jsonb
  created_at: GeneratedTimestamptz
}

export type AtlasGithubEventsTable = {
  id: GeneratedUuid
  repository_id: Uuid | null
  delivery_id: string
  event_type: string
  repository: string
  installation_id: string | null
  sender_login: string | null
  payload: Jsonb
  received_at: GeneratedTimestamptz
  processed_at: NullableTimestamptz
}

export type AtlasIngestionsTable = {
  id: GeneratedUuid
  event_id: Uuid
  workflow_id: string
  status: string
  error: string | null
  started_at: GeneratedTimestamptz
  finished_at: NullableTimestamptz
}

export type AtlasEventFilesTable = {
  id: GeneratedUuid
  event_id: Uuid
  file_key_id: Uuid
  change_type: string
}

export type AtlasIngestionTargetsTable = {
  id: GeneratedUuid
  ingestion_id: Uuid
  file_version_id: Uuid
  kind: string
}

export type TorghutSymbolsTable = {
  symbol: string
  enabled: boolean
  asset_class: string
  updated_at: GeneratedTimestamptz
}

export type Database = {
  entries: MemoriesEntriesTable
  repositories: AtlasRepositoriesTable
  file_keys: AtlasFileKeysTable
  file_versions: AtlasFileVersionsTable
  file_chunks: AtlasFileChunksTable
  enrichments: AtlasEnrichmentsTable
  embeddings: AtlasEmbeddingsTable
  tree_sitter_facts: AtlasTreeSitterFactsTable
  symbols: AtlasSymbolsTable
  symbol_defs: AtlasSymbolDefsTable
  symbol_refs: AtlasSymbolRefsTable
  file_edges: AtlasFileEdgesTable
  github_events: AtlasGithubEventsTable
  ingestions: AtlasIngestionsTable
  event_files: AtlasEventFilesTable
  ingestion_targets: AtlasIngestionTargetsTable
  torghut_symbols: TorghutSymbolsTable
}

export type Db = Kysely<Database>

let db: Db | null | undefined

const loadCaCert = (rawValue: string) => {
  if (rawValue.includes('BEGIN CERTIFICATE')) {
    return rawValue
  }
  if (existsSync(rawValue)) {
    return readFileSync(rawValue, 'utf8')
  }
  return rawValue
}

const resolveSslMode = (rawUrl: string) => {
  try {
    return new URL(rawUrl).searchParams.get('sslmode')
  } catch {
    return null
  }
}

const resolveSslOptions = (rawUrl: string) => {
  const caCertPath = process.env.PGSSLROOTCERT?.trim() || process.env.JANGAR_DB_CA_CERT?.trim()
  const ca = caCertPath ? loadCaCert(caCertPath) : undefined
  const sslmode = resolveSslMode(rawUrl)

  if (sslmode === 'disable') return undefined
  if (!sslmode && !ca) return undefined

  const verify = sslmode === 'verify-ca' || sslmode === 'verify-full' || Boolean(ca)
  return ca ? { ca, rejectUnauthorized: verify } : { rejectUnauthorized: false }
}

export const createKyselyDb = (url: string): Db => {
  const pool = new Pool({
    connectionString: url,
    ssl: resolveSslOptions(url),
  })

  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  })
}

export const getDb = () => {
  if (db !== undefined) return db

  const url = process.env.DATABASE_URL?.trim()
  if (!url) {
    db = null
    return db
  }

  db = createKyselyDb(url)
  return db
}
