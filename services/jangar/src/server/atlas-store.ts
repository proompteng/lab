import { sql } from 'kysely'

import { createKyselyDb, type Db } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'

export type RepositoryRecord = {
  id: string
  name: string
  defaultRef: string
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type FileKeyRecord = {
  id: string
  repositoryId: string
  path: string
  createdAt: string
}

export type FileVersionRecord = {
  id: string
  fileKeyId: string
  repositoryRef: string
  repositoryCommit: string | null
  contentHash: string
  language: string | null
  byteSize: number | null
  lineCount: number | null
  metadata: Record<string, unknown>
  sourceTimestamp: string | null
  createdAt: string
  updatedAt: string
}

export type FileChunkRecord = {
  id: string
  fileVersionId: string
  chunkIndex: number
  startLine: number | null
  endLine: number | null
  content: string | null
  tokenCount: number | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type EnrichmentRecord = {
  id: string
  fileVersionId: string
  chunkId: string | null
  kind: string
  source: string
  content: string
  summary: string | null
  tags: string[]
  metadata: Record<string, unknown>
  createdAt: string
}

export type EmbeddingRecord = {
  id: string
  enrichmentId: string
  model: string
  dimension: number
  createdAt: string
}

export type TreeSitterFactRecord = {
  id: string
  fileVersionId: string
  nodeType: string
  matchText: string
  startLine: number | null
  endLine: number | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type SymbolRecord = {
  id: string
  repositoryId: string
  name: string
  normalizedName: string
  kind: string
  signature: string
  metadata: Record<string, unknown>
  createdAt: string
}

export type SymbolDefRecord = {
  id: string
  symbolId: string
  fileVersionId: string
  startLine: number | null
  endLine: number | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type SymbolRefRecord = {
  id: string
  symbolId: string
  fileVersionId: string
  startLine: number | null
  endLine: number | null
  metadata: Record<string, unknown>
  createdAt: string
}

export type FileEdgeRecord = {
  id: string
  fromFileVersionId: string
  toFileVersionId: string
  kind: string
  metadata: Record<string, unknown>
  createdAt: string
}

export type GithubEventRecord = {
  id: string
  repositoryId: string | null
  deliveryId: string
  eventType: string
  repository: string
  installationId: string | null
  senderLogin: string | null
  payload: Record<string, unknown>
  receivedAt: string
  processedAt: string | null
}

export type IngestionRecord = {
  id: string
  eventId: string
  workflowId: string
  status: string
  error: string | null
  startedAt: string
  finishedAt: string | null
}

export type EventFileRecord = {
  id: string
  eventId: string
  fileKeyId: string
  changeType: string
}

export type IngestionTargetRecord = {
  id: string
  ingestionId: string
  fileVersionId: string
  kind: string
}

export type UpsertRepositoryInput = {
  name: string
  defaultRef?: string
  metadata?: Record<string, unknown>
}

export type UpsertFileKeyInput = {
  repositoryId: string
  path: string
}

export type UpsertFileVersionInput = {
  fileKeyId: string
  repositoryRef: string
  repositoryCommit?: string | null
  contentHash?: string | null
  language?: string | null
  byteSize?: number | null
  lineCount?: number | null
  metadata?: Record<string, unknown>
  sourceTimestamp?: string | Date | null
}

export type UpsertFileChunkInput = {
  fileVersionId: string
  chunkIndex: number
  startLine?: number | null
  endLine?: number | null
  content?: string | null
  tokenCount?: number | null
  metadata?: Record<string, unknown>
}

export type UpsertEnrichmentInput = {
  fileVersionId: string
  chunkId?: string | null
  kind: string
  source: string
  content: string
  summary?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
}

export type UpsertEmbeddingInput = {
  enrichmentId: string
  model: string
  dimension?: number
  embedding: number[]
}

export type UpsertTreeSitterFactInput = {
  fileVersionId: string
  nodeType: string
  matchText: string
  startLine?: number | null
  endLine?: number | null
  metadata?: Record<string, unknown>
}

export type UpsertSymbolInput = {
  repositoryId: string
  name: string
  normalizedName?: string
  kind: string
  signature?: string | null
  metadata?: Record<string, unknown>
}

export type UpsertSymbolDefInput = {
  symbolId: string
  fileVersionId: string
  startLine?: number | null
  endLine?: number | null
  metadata?: Record<string, unknown>
}

export type UpsertSymbolRefInput = {
  symbolId: string
  fileVersionId: string
  startLine?: number | null
  endLine?: number | null
  metadata?: Record<string, unknown>
}

export type UpsertFileEdgeInput = {
  fromFileVersionId: string
  toFileVersionId: string
  kind: string
  metadata?: Record<string, unknown>
}

export type UpsertGithubEventInput = {
  repositoryId?: string | null
  deliveryId: string
  eventType: string
  repository: string
  installationId?: string | null
  senderLogin?: string | null
  payload?: Record<string, unknown>
  receivedAt?: string | Date | null
  processedAt?: string | Date | null
}

export type UpsertIngestionInput = {
  eventId: string
  workflowId: string
  status: string
  error?: string | null
  startedAt?: string | Date | null
  finishedAt?: string | Date | null
}

export type UpsertEventFileInput = {
  eventId: string
  fileKeyId: string
  changeType: string
}

export type UpsertIngestionTargetInput = {
  ingestionId: string
  fileVersionId: string
  kind: string
}

export type AtlasSearchInput = {
  query: string
  limit?: number
  repository?: string
  ref?: string
  pathPrefix?: string
  tags?: string[]
  kinds?: string[]
}

export type AtlasSearchMatch = {
  enrichment: EnrichmentRecord & { distance: number }
  fileVersion: FileVersionRecord
  fileKey: FileKeyRecord
  repository: RepositoryRecord
}

export type AtlasCodeSearchInput = {
  query: string
  limit?: number
  repository?: string
  ref?: string
  pathPrefix?: string
  language?: string
}

export type AtlasCodeSearchSignals = {
  semanticDistance: number | null
  lexicalRank: number | null
  matchedIdentifiers: string[]
}

export type AtlasCodeSearchMatch = {
  repository: RepositoryRecord
  fileKey: FileKeyRecord
  fileVersion: FileVersionRecord
  chunk: FileChunkRecord
  score: number
  signals: AtlasCodeSearchSignals
}

export type AtlasStats = {
  repositories: number
  fileKeys: number
  fileVersions: number
  enrichments: number
  embeddings: number
}

export type AtlasAstFact = {
  nodeType: string
  matchText: string
  startLine: number | null
  endLine: number | null
}

export type AtlasAstPreview = {
  facts: AtlasAstFact[]
  summary?: string | null
}

export type AtlasIndexedFile = {
  repository: string
  ref: string
  path: string
  commit?: string | null
  contentHash: string
  updatedAt?: string | Date | null
}

export type AtlasStore = {
  upsertRepository: (input: UpsertRepositoryInput) => Promise<RepositoryRecord>
  getRepositoryByName: (input: { name: string }) => Promise<RepositoryRecord | null>
  upsertFileKey: (input: UpsertFileKeyInput) => Promise<FileKeyRecord>
  getFileKeyByPath: (input: { repositoryId: string; path: string }) => Promise<FileKeyRecord | null>
  upsertFileVersion: (input: UpsertFileVersionInput) => Promise<FileVersionRecord>
  getFileVersionByKey: (input: {
    fileKeyId: string
    repositoryRef: string
    repositoryCommit?: string | null
    contentHash?: string | null
  }) => Promise<FileVersionRecord | null>
  upsertFileChunk: (input: UpsertFileChunkInput) => Promise<FileChunkRecord>
  upsertEnrichment: (input: UpsertEnrichmentInput) => Promise<EnrichmentRecord>
  upsertEmbedding: (input: UpsertEmbeddingInput) => Promise<EmbeddingRecord>
  upsertTreeSitterFact: (input: UpsertTreeSitterFactInput) => Promise<TreeSitterFactRecord>
  upsertSymbol: (input: UpsertSymbolInput) => Promise<SymbolRecord>
  upsertSymbolDef: (input: UpsertSymbolDefInput) => Promise<SymbolDefRecord>
  upsertSymbolRef: (input: UpsertSymbolRefInput) => Promise<SymbolRefRecord>
  upsertFileEdge: (input: UpsertFileEdgeInput) => Promise<FileEdgeRecord>
  upsertGithubEvent: (input: UpsertGithubEventInput) => Promise<GithubEventRecord>
  upsertIngestion: (input: UpsertIngestionInput) => Promise<IngestionRecord>
  upsertEventFile: (input: UpsertEventFileInput) => Promise<EventFileRecord>
  upsertIngestionTarget: (input: UpsertIngestionTargetInput) => Promise<IngestionTargetRecord>
  listIndexedFiles: (input: {
    limit?: number
    repository?: string
    ref?: string
    pathPrefix?: string
  }) => Promise<AtlasIndexedFile[]>
  getAstPreview: (input: { fileVersionId: string; limit?: number }) => Promise<AtlasAstPreview>
  search: (input: AtlasSearchInput) => Promise<AtlasSearchMatch[]>
  searchCount: (input: AtlasSearchInput) => Promise<number>
  codeSearch: (input: AtlasCodeSearchInput) => Promise<AtlasCodeSearchMatch[]>
  stats: () => Promise<AtlasStats>
  close: () => Promise<void>
}

type PostgresAtlasStoreOptions = {
  url?: string
  createDb?: (url: string) => Db
}

const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding-saigak:0.6b'
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 1024
const DEFAULT_INDEX_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 200

const SCHEMA = 'atlas'

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

const loadEmbeddingTimeoutMs = () => {
  const timeoutMs = Number.parseInt(process.env.OPENAI_EMBEDDING_TIMEOUT_MS ?? '15000', 10)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('OPENAI_EMBEDDING_TIMEOUT_MS must be a positive integer')
  }
  return timeoutMs
}

const loadEmbeddingMaxInputChars = () => {
  const maxInputChars = Number.parseInt(process.env.OPENAI_EMBEDDING_MAX_INPUT_CHARS ?? '60000', 10)
  if (!Number.isFinite(maxInputChars) || maxInputChars <= 0) {
    throw new Error('OPENAI_EMBEDDING_MAX_INPUT_CHARS must be a positive integer')
  }
  return maxInputChars
}

const resolveEmbeddingDefaults = (apiBaseUrl: string) => {
  const hosted = isHostedOpenAiBaseUrl(apiBaseUrl)
  return {
    model: hosted ? DEFAULT_OPENAI_EMBEDDING_MODEL : DEFAULT_SELF_HOSTED_EMBEDDING_MODEL,
    dimension: hosted ? DEFAULT_OPENAI_EMBEDDING_DIMENSION : DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION,
  }
}

const vectorToPgArray = (values: number[]) => `[${values.join(',')}]`

const extractIdentifierTokens = (query: string) => {
  // Prefer identifiers that are likely to appear in code.
  const candidates = query
    .split(/[^A-Za-z0-9_./-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)

  const blocked = new Set([
    'the',
    'and',
    'for',
    'with',
    'where',
    'what',
    'how',
    'file',
    'files',
    'code',
    'repo',
    'repository',
    'path',
    'search',
  ])

  const result: string[] = []
  const seen = new Set<string>()
  for (const token of candidates) {
    const lowered = token.toLowerCase()
    if (blocked.has(lowered)) continue
    if (seen.has(lowered)) continue
    seen.add(lowered)
    result.push(token)
  }
  return result.slice(0, 25)
}

const countIdentifierMatches = (haystack: string, identifiers: string[]) => {
  if (!haystack || identifiers.length === 0) return { matched: [], count: 0 }
  const matched: string[] = []
  for (const token of identifiers) {
    if (matched.length >= 10) break
    if (haystack.includes(token)) {
      matched.push(token)
    }
  }
  return { matched, count: matched.length }
}

const loadEmbeddingConfig = () => {
  const apiBaseUrl = process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_API_BASE ?? DEFAULT_OPENAI_API_BASE_URL
  const apiKey = process.env.OPENAI_API_KEY?.trim() || null
  if (!apiKey && isHostedOpenAiBaseUrl(apiBaseUrl)) {
    throw new Error(
      'missing OPENAI_API_KEY; set it or point OPENAI_API_BASE_URL at an OpenAI-compatible endpoint (e.g. Ollama)',
    )
  }
  const defaults = resolveEmbeddingDefaults(apiBaseUrl)
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? defaults.model
  const dimension = loadEmbeddingDimension(defaults.dimension)
  const timeoutMs = loadEmbeddingTimeoutMs()
  const maxInputChars = loadEmbeddingMaxInputChars()

  return { apiKey, apiBaseUrl, model, dimension, timeoutMs, maxInputChars }
}

const embedText = async (
  text: string,
  config: ReturnType<typeof loadEmbeddingConfig> = loadEmbeddingConfig(),
): Promise<number[]> => {
  const { apiKey, apiBaseUrl, model, dimension, timeoutMs, maxInputChars } = config
  if (text.length > maxInputChars) {
    throw new Error(`embedding input too large (${text.length} chars; max ${maxInputChars})`)
  }

  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (apiKey) {
      headers.authorization = `Bearer ${apiKey}`
    }

    const response = await fetch(`${apiBaseUrl}/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: text }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`embedding request failed (${response.status}): ${body}`)
    }

    const json = (await response.json()) as { data?: { embedding?: number[] }[] }
    const embedding = json.data?.[0]?.embedding
    if (!embedding || !Array.isArray(embedding)) {
      throw new Error('embedding response missing data[0].embedding')
    }
    if (embedding.length !== dimension) {
      throw new Error(`embedding dimension mismatch: expected ${dimension} but got ${embedding.length}`)
    }

    return embedding
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`embedding request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeoutHandle)
  }
}

const normalizeText = (value: string, field: string, fallback?: string) => {
  const trimmed = value.trim()
  if (trimmed.length > 0) return trimmed
  if (fallback !== undefined) return fallback
  throw new Error(`${field} is required`)
}

const normalizeOptionalText = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : ''
}

const normalizeOptionalNullableText = (value?: string | null) => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : null
}

const normalizeTags = (tags: string[] | undefined) =>
  (tags ?? [])
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
    .slice(0, 50)

const parseDate = (value?: string | Date | null) => {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const parseMetadata = (metadata?: Record<string, unknown>) => JSON.stringify(metadata ?? {})

const toIso = (value: string | Date | null | undefined) => {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

export const createPostgresAtlasStore = (options: PostgresAtlasStoreOptions = {}): AtlasStore => {
  const url = options.url ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required for Atlas storage')
  }

  const db = (options.createDb ?? createKyselyDb)(url)
  let schemaReady: Promise<void> | null = null
  const defaults = resolveEmbeddingDefaults(
    process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_API_BASE ?? DEFAULT_OPENAI_API_BASE_URL,
  )
  const expectedEmbeddingDimension = loadEmbeddingDimension(defaults.dimension)

  const ensureEmbeddingDimensionMatches = async () => {
    const { rows } = await sql<{ embedding_type: string | null }>`
      SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS embedding_type
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${SCHEMA}
        AND c.relname = ${'embeddings'}
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped;
    `.execute(db)

    const embeddingType = rows[0]?.embedding_type ?? null
    if (!embeddingType) return

    const match = embeddingType.match(/vector\((\d+)\)/i)
    const actualDimension = match ? Number.parseInt(match[1] ?? '', 10) : null
    if (!actualDimension || !Number.isFinite(actualDimension)) return

    if (actualDimension !== expectedEmbeddingDimension) {
      throw new Error(
        `embedding dimension mismatch in Postgres schema: atlas.embeddings.embedding is ${embeddingType} ` +
          `but OPENAI_EMBEDDING_DIMENSION is ${expectedEmbeddingDimension}. ` +
          'Update OPENAI_EMBEDDING_DIMENSION (and regenerate embeddings) or migrate the column type to match.',
      )
    }
  }

  const ensureChunkEmbeddingDimensionMatches = async () => {
    const { rows } = await sql<{ embedding_type: string | null }>`
      SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS embedding_type
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${SCHEMA}
        AND c.relname = ${'chunk_embeddings'}
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped;
    `.execute(db)

    const embeddingType = rows[0]?.embedding_type ?? null
    if (!embeddingType) return

    const match = embeddingType.match(/vector\((\d+)\)/i)
    const actualDimension = match ? Number.parseInt(match[1] ?? '', 10) : null
    if (!actualDimension || !Number.isFinite(actualDimension)) return

    if (actualDimension !== expectedEmbeddingDimension) {
      throw new Error(
        `embedding dimension mismatch in Postgres schema: atlas.chunk_embeddings.embedding is ${embeddingType} ` +
          `but OPENAI_EMBEDDING_DIMENSION is ${expectedEmbeddingDimension}. ` +
          'Update OPENAI_EMBEDDING_DIMENSION or migrate the column type to match.',
      )
    }
  }

  const ensureSchema = async () => {
    if (!schemaReady) {
      schemaReady = (async () => {
        await ensureMigrations(db)
        await ensureEmbeddingDimensionMatches()
        await ensureChunkEmbeddingDimensionMatches()
      })()
    }
    await schemaReady
  }

  const upsertRepository: AtlasStore['upsertRepository'] = async ({ name, defaultRef, metadata }) => {
    await ensureSchema()

    const resolvedName = normalizeText(name, 'repository name')
    const resolvedDefaultRef = normalizeText(defaultRef ?? 'main', 'repository default ref', 'main')
    const resolvedMetadata = parseMetadata(metadata)

    const row = await db
      .insertInto('atlas.repositories')
      .values({
        name: resolvedName,
        default_ref: resolvedDefaultRef,
        metadata: sql`${resolvedMetadata}::jsonb`,
      })
      .onConflict((oc) =>
        oc.column('name').doUpdateSet({
          default_ref: sql`excluded.default_ref`,
          metadata: sql`excluded.metadata`,
          updated_at: sql`now()`,
        }),
      )
      .returning(['id', 'name', 'default_ref', 'metadata', 'created_at', 'updated_at'])
      .executeTakeFirst()

    if (!row) throw new Error('repository upsert failed')

    return {
      id: row.id,
      name: row.name,
      defaultRef: row.default_ref,
      metadata: row.metadata ?? {},
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    }
  }

  const getRepositoryByName: AtlasStore['getRepositoryByName'] = async ({ name }) => {
    await ensureSchema()

    const resolvedName = normalizeText(name, 'repository name')
    const row = await db
      .selectFrom('atlas.repositories')
      .select(['id', 'name', 'default_ref', 'metadata', 'created_at', 'updated_at'])
      .where('name', '=', resolvedName)
      .limit(1)
      .executeTakeFirst()

    if (!row) return null

    return {
      id: row.id,
      name: row.name,
      defaultRef: row.default_ref,
      metadata: row.metadata ?? {},
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    }
  }

  const upsertFileKey: AtlasStore['upsertFileKey'] = async ({ repositoryId, path }) => {
    await ensureSchema()

    const resolvedRepoId = normalizeText(repositoryId, 'repositoryId')
    const resolvedPath = normalizeText(path, 'path')

    const row = await db
      .insertInto('atlas.file_keys')
      .values({
        repository_id: resolvedRepoId,
        path: resolvedPath,
      })
      .onConflict((oc) =>
        oc.columns(['repository_id', 'path']).doUpdateSet({
          path: sql`excluded.path`,
        }),
      )
      .returning(['id', 'repository_id', 'path', 'created_at'])
      .executeTakeFirst()

    if (!row) throw new Error('file key upsert failed')

    return {
      id: row.id,
      repositoryId: row.repository_id,
      path: row.path,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }
  }

  const getFileKeyByPath: AtlasStore['getFileKeyByPath'] = async ({ repositoryId, path }) => {
    await ensureSchema()

    const resolvedRepoId = normalizeText(repositoryId, 'repositoryId')
    const resolvedPath = normalizeText(path, 'path')

    const row = await db
      .selectFrom('atlas.file_keys')
      .select(['id', 'repository_id', 'path', 'created_at'])
      .where('repository_id', '=', resolvedRepoId)
      .where('path', '=', resolvedPath)
      .limit(1)
      .executeTakeFirst()

    if (!row) return null

    return {
      id: row.id,
      repositoryId: row.repository_id,
      path: row.path,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }
  }

  const upsertFileVersion: AtlasStore['upsertFileVersion'] = async ({
    fileKeyId,
    repositoryRef,
    repositoryCommit,
    contentHash,
    language,
    byteSize,
    lineCount,
    metadata,
    sourceTimestamp,
  }) => {
    await ensureSchema()

    const resolvedFileKeyId = normalizeText(fileKeyId, 'fileKeyId')
    const resolvedRepositoryRef = normalizeText(repositoryRef, 'repositoryRef', 'main')
    const resolvedCommit = normalizeOptionalNullableText(repositoryCommit)
    const resolvedHash = normalizeOptionalText(contentHash)

    if (!resolvedCommit && !resolvedHash) {
      throw new Error('repositoryCommit or contentHash is required for file versions')
    }

    const resolvedMetadata = parseMetadata(metadata)
    const resolvedSourceTimestamp = parseDate(sourceTimestamp)

    const fileVersionInsert = db.insertInto('atlas.file_versions').values({
      file_key_id: resolvedFileKeyId,
      repository_ref: resolvedRepositoryRef,
      repository_commit: resolvedCommit,
      content_hash: resolvedHash,
      language: normalizeOptionalNullableText(language),
      byte_size: byteSize ?? null,
      line_count: lineCount ?? null,
      metadata: sql`${resolvedMetadata}::jsonb`,
      source_timestamp: resolvedSourceTimestamp,
    })

    const fileVersionUpsert =
      resolvedCommit === null
        ? fileVersionInsert.onConflict((oc) =>
            oc
              .columns(['file_key_id', 'repository_ref', 'content_hash'])
              .where('repository_commit', 'is', null)
              .doUpdateSet({
                language: sql`excluded.language`,
                byte_size: sql`excluded.byte_size`,
                line_count: sql`excluded.line_count`,
                metadata: sql`excluded.metadata`,
                source_timestamp: sql`excluded.source_timestamp`,
                updated_at: sql`now()`,
              }),
          )
        : fileVersionInsert.onConflict((oc) =>
            oc.columns(['file_key_id', 'repository_ref', 'repository_commit', 'content_hash']).doUpdateSet({
              language: sql`excluded.language`,
              byte_size: sql`excluded.byte_size`,
              line_count: sql`excluded.line_count`,
              metadata: sql`excluded.metadata`,
              source_timestamp: sql`excluded.source_timestamp`,
              updated_at: sql`now()`,
            }),
          )

    const row = await fileVersionUpsert
      .returning([
        'id',
        'file_key_id',
        'repository_ref',
        'repository_commit',
        'content_hash',
        'language',
        'byte_size',
        'line_count',
        'metadata',
        'source_timestamp',
        'created_at',
        'updated_at',
      ])
      .executeTakeFirst()

    if (!row) throw new Error('file version upsert failed')

    return {
      id: row.id,
      fileKeyId: row.file_key_id,
      repositoryRef: row.repository_ref,
      repositoryCommit: row.repository_commit,
      contentHash: row.content_hash,
      language: row.language,
      byteSize: row.byte_size,
      lineCount: row.line_count,
      metadata: row.metadata ?? {},
      sourceTimestamp: row.source_timestamp ? toIso(row.source_timestamp) : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    }
  }

  const getFileVersionByKey: AtlasStore['getFileVersionByKey'] = async ({
    fileKeyId,
    repositoryRef,
    repositoryCommit,
    contentHash,
  }) => {
    await ensureSchema()

    const resolvedFileKeyId = normalizeText(fileKeyId, 'fileKeyId')
    const resolvedRepositoryRef = normalizeText(repositoryRef, 'repositoryRef', 'main')
    const resolvedCommit = normalizeOptionalText(repositoryCommit)
    const resolvedHash = normalizeOptionalText(contentHash)

    const row = await db
      .selectFrom('atlas.file_versions')
      .select([
        'id',
        'file_key_id',
        'repository_ref',
        'repository_commit',
        'content_hash',
        'language',
        'byte_size',
        'line_count',
        'metadata',
        'source_timestamp',
        'created_at',
        'updated_at',
      ])
      .where('file_key_id', '=', resolvedFileKeyId)
      .where('repository_ref', '=', resolvedRepositoryRef)
      .where('repository_commit', '=', resolvedCommit)
      .where('content_hash', '=', resolvedHash)
      .limit(1)
      .executeTakeFirst()

    if (!row) return null

    return {
      id: row.id,
      fileKeyId: row.file_key_id,
      repositoryRef: row.repository_ref,
      repositoryCommit: row.repository_commit,
      contentHash: row.content_hash,
      language: row.language,
      byteSize: row.byte_size,
      lineCount: row.line_count,
      metadata: row.metadata ?? {},
      sourceTimestamp: row.source_timestamp ? toIso(row.source_timestamp) : null,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    }
  }

  const upsertFileChunk: AtlasStore['upsertFileChunk'] = async ({
    fileVersionId,
    chunkIndex,
    startLine,
    endLine,
    content,
    tokenCount,
    metadata,
  }) => {
    await ensureSchema()

    const resolvedFileVersionId = normalizeText(fileVersionId, 'fileVersionId')
    if (!Number.isFinite(chunkIndex)) throw new Error('chunkIndex is required')

    const resolvedMetadata = parseMetadata(metadata)

    const row = await db
      .insertInto('atlas.file_chunks')
      .values({
        file_version_id: resolvedFileVersionId,
        chunk_index: Math.floor(chunkIndex),
        start_line: startLine ?? null,
        end_line: endLine ?? null,
        content: content ?? null,
        text_tsvector: sql`to_tsvector('simple', ${content ?? ''})`,
        token_count: tokenCount ?? null,
        metadata: sql`${resolvedMetadata}::jsonb`,
      })
      .onConflict((oc) =>
        oc.columns(['file_version_id', 'chunk_index']).doUpdateSet({
          start_line: sql`excluded.start_line`,
          end_line: sql`excluded.end_line`,
          content: sql`excluded.content`,
          text_tsvector: sql`excluded.text_tsvector`,
          token_count: sql`excluded.token_count`,
          metadata: sql`excluded.metadata`,
        }),
      )
      .returning([
        'id',
        'file_version_id',
        'chunk_index',
        'start_line',
        'end_line',
        'content',
        'text_tsvector',
        'token_count',
        'metadata',
        'created_at',
      ])
      .executeTakeFirst()

    if (!row) throw new Error('file chunk upsert failed')

    return {
      id: row.id,
      fileVersionId: row.file_version_id,
      chunkIndex: row.chunk_index,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
      // We don't expose tsvector as part of the record contract; it is query-only.
      tokenCount: row.token_count,
      metadata: row.metadata ?? {},
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }
  }

  const upsertEnrichment: AtlasStore['upsertEnrichment'] = async ({
    fileVersionId,
    chunkId,
    kind,
    source,
    content,
    summary,
    tags,
    metadata,
  }) => {
    await ensureSchema()

    const resolvedFileVersionId = normalizeText(fileVersionId, 'fileVersionId')
    const resolvedChunkId = normalizeOptionalNullableText(chunkId)
    const resolvedKind = normalizeText(kind, 'kind')
    const resolvedSource = normalizeText(source, 'source')
    const resolvedContent = normalizeText(content, 'content')
    const resolvedSummary = normalizeOptionalNullableText(summary)
    const resolvedTags = normalizeTags(tags)
    const resolvedMetadata = parseMetadata(metadata)

    const insertQuery = db
      .insertInto('atlas.enrichments')
      .values({
        file_version_id: resolvedFileVersionId,
        chunk_id: resolvedChunkId,
        kind: resolvedKind,
        source: resolvedSource,
        content: resolvedContent,
        summary: resolvedSummary,
        tags: sql`${sql.value(resolvedTags)}::text[]`,
        metadata: sql`${resolvedMetadata}::jsonb`,
      })
      .returning([
        'id',
        'file_version_id',
        'chunk_id',
        'kind',
        'source',
        'content',
        'summary',
        'tags',
        'metadata',
        'created_at',
      ])

    const row = await (
      resolvedChunkId
        ? insertQuery.onConflict((oc) =>
            oc.columns(['file_version_id', 'chunk_id', 'kind', 'source']).doUpdateSet({
              content: sql`excluded.content`,
              summary: sql`excluded.summary`,
              tags: sql`excluded.tags`,
              metadata: sql`excluded.metadata`,
            }),
          )
        : insertQuery.onConflict((oc) =>
            oc
              .columns(['file_version_id', 'kind', 'source'])
              .where('chunk_id', 'is', null)
              .doUpdateSet({
                content: sql`excluded.content`,
                summary: sql`excluded.summary`,
                tags: sql`excluded.tags`,
                metadata: sql`excluded.metadata`,
              }),
          )
    ).executeTakeFirst()

    if (!row) throw new Error('enrichment upsert failed')

    return {
      id: row.id,
      fileVersionId: row.file_version_id,
      chunkId: row.chunk_id,
      kind: row.kind,
      source: row.source,
      content: row.content,
      summary: row.summary,
      tags: Array.isArray(row.tags) ? row.tags : [],
      metadata: row.metadata ?? {},
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }
  }

  const upsertEmbedding: AtlasStore['upsertEmbedding'] = async ({ enrichmentId, model, dimension, embedding }) => {
    await ensureSchema()

    const resolvedEnrichmentId = normalizeText(enrichmentId, 'enrichmentId')
    const resolvedModel = normalizeText(model, 'model')
    const resolvedDimension = dimension ?? embedding.length

    if (!Number.isFinite(resolvedDimension) || resolvedDimension <= 0) {
      throw new Error('dimension must be a positive integer')
    }
    if (embedding.length !== resolvedDimension) {
      throw new Error(`embedding dimension mismatch: expected ${resolvedDimension} but got ${embedding.length}`)
    }
    if (resolvedDimension !== expectedEmbeddingDimension) {
      throw new Error(
        `embedding dimension mismatch: expected ${expectedEmbeddingDimension} for atlas.embeddings.embedding but got ${resolvedDimension}. ` +
          'Update OPENAI_EMBEDDING_DIMENSION or regenerate embeddings to match the schema.',
      )
    }

    const vectorString = vectorToPgArray(embedding)

    const row = await db
      .insertInto('atlas.embeddings')
      .values({
        enrichment_id: resolvedEnrichmentId,
        model: resolvedModel,
        dimension: resolvedDimension,
        embedding: sql`${vectorString}::vector`,
      })
      .onConflict((oc) =>
        oc.columns(['enrichment_id', 'model', 'dimension']).doUpdateSet({
          embedding: sql`excluded.embedding`,
        }),
      )
      .returning(['id', 'enrichment_id', 'model', 'dimension', 'created_at'])
      .executeTakeFirst()

    if (!row) throw new Error('embedding upsert failed')

    return {
      id: row.id,
      enrichmentId: row.enrichment_id,
      model: row.model,
      dimension: Number(row.dimension),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }
  }

  const upsertTreeSitterFact: AtlasStore['upsertTreeSitterFact'] = async ({
    fileVersionId,
    nodeType,
    matchText,
    startLine,
    endLine,
    metadata,
  }) => {
    await ensureSchema()

    const resolvedFileVersionId = normalizeText(fileVersionId, 'fileVersionId')
    const resolvedNodeType = normalizeText(nodeType, 'nodeType')
    const resolvedMatchText = normalizeText(matchText, 'matchText')
    const resolvedMetadata = parseMetadata(metadata)

    const row = await db
      .insertInto('atlas.tree_sitter_facts')
      .values({
        file_version_id: resolvedFileVersionId,
        node_type: resolvedNodeType,
        match_text: resolvedMatchText,
        start_line: startLine ?? null,
        end_line: endLine ?? null,
        metadata: sql`${resolvedMetadata}::jsonb`,
      })
      .onConflict((oc) =>
        oc.columns(['file_version_id', 'node_type', 'match_text', 'start_line', 'end_line']).doUpdateSet({
          metadata: sql`excluded.metadata`,
        }),
      )
      .returning([
        'id',
        'file_version_id',
        'node_type',
        'match_text',
        'start_line',
        'end_line',
        'metadata',
        'created_at',
      ])
      .executeTakeFirst()

    if (!row) throw new Error('tree sitter fact upsert failed')

    return {
      id: row.id,
      fileVersionId: row.file_version_id,
      nodeType: row.node_type,
      matchText: row.match_text,
      startLine: row.start_line,
      endLine: row.end_line,
      metadata: row.metadata ?? {},
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }
  }

  const upsertSymbol: AtlasStore['upsertSymbol'] = async ({
    repositoryId,
    name,
    normalizedName,
    kind,
    signature,
    metadata,
  }) => {
    await ensureSchema()

    const resolvedRepositoryId = normalizeText(repositoryId, 'repositoryId')
    const resolvedName = normalizeText(name, 'name')
    const resolvedNormalizedName = normalizeText(normalizedName ?? resolvedName.toLowerCase(), 'normalizedName')
    const resolvedKind = normalizeText(kind, 'kind')
    const resolvedSignature = normalizeOptionalText(signature)
    const resolvedMetadata = parseMetadata(metadata)

    const row = await db
      .insertInto('atlas.symbols')
      .values({
        repository_id: resolvedRepositoryId,
        name: resolvedName,
        normalized_name: resolvedNormalizedName,
        kind: resolvedKind,
        signature: resolvedSignature,
        metadata: sql`${resolvedMetadata}::jsonb`,
      })
      .onConflict((oc) =>
        oc.columns(['repository_id', 'normalized_name', 'kind', 'signature']).doUpdateSet({
          name: sql`excluded.name`,
          metadata: sql`excluded.metadata`,
        }),
      )
      .returning(['id', 'repository_id', 'name', 'normalized_name', 'kind', 'signature', 'metadata', 'created_at'])
      .executeTakeFirst()

    if (!row) throw new Error('symbol upsert failed')

    return {
      id: row.id,
      repositoryId: row.repository_id,
      name: row.name,
      normalizedName: row.normalized_name,
      kind: row.kind,
      signature: row.signature,
      metadata: row.metadata ?? {},
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }
  }

  const upsertSymbolDef: AtlasStore['upsertSymbolDef'] = async ({
    symbolId,
    fileVersionId,
    startLine,
    endLine,
    metadata,
  }) => {
    await ensureSchema()

    const resolvedSymbolId = normalizeText(symbolId, 'symbolId')
    const resolvedFileVersionId = normalizeText(fileVersionId, 'fileVersionId')
    const resolvedMetadata = parseMetadata(metadata)

    const row = await db
      .insertInto('atlas.symbol_defs')
      .values({
        symbol_id: resolvedSymbolId,
        file_version_id: resolvedFileVersionId,
        start_line: startLine ?? null,
        end_line: endLine ?? null,
        metadata: sql`${resolvedMetadata}::jsonb`,
      })
      .onConflict((oc) =>
        oc.columns(['symbol_id', 'file_version_id', 'start_line', 'end_line']).doUpdateSet({
          metadata: sql`excluded.metadata`,
        }),
      )
      .returning(['id', 'symbol_id', 'file_version_id', 'start_line', 'end_line', 'metadata', 'created_at'])
      .executeTakeFirst()

    if (!row) throw new Error('symbol def upsert failed')

    return {
      id: row.id,
      symbolId: row.symbol_id,
      fileVersionId: row.file_version_id,
      startLine: row.start_line,
      endLine: row.end_line,
      metadata: row.metadata ?? {},
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }
  }

  const upsertSymbolRef: AtlasStore['upsertSymbolRef'] = async ({
    symbolId,
    fileVersionId,
    startLine,
    endLine,
    metadata,
  }) => {
    await ensureSchema()

    const resolvedSymbolId = normalizeText(symbolId, 'symbolId')
    const resolvedFileVersionId = normalizeText(fileVersionId, 'fileVersionId')
    const resolvedMetadata = parseMetadata(metadata)

    const row = await db
      .insertInto('atlas.symbol_refs')
      .values({
        symbol_id: resolvedSymbolId,
        file_version_id: resolvedFileVersionId,
        start_line: startLine ?? null,
        end_line: endLine ?? null,
        metadata: sql`${resolvedMetadata}::jsonb`,
      })
      .onConflict((oc) =>
        oc.columns(['symbol_id', 'file_version_id', 'start_line', 'end_line']).doUpdateSet({
          metadata: sql`excluded.metadata`,
        }),
      )
      .returning(['id', 'symbol_id', 'file_version_id', 'start_line', 'end_line', 'metadata', 'created_at'])
      .executeTakeFirst()

    if (!row) throw new Error('symbol ref upsert failed')

    return {
      id: row.id,
      symbolId: row.symbol_id,
      fileVersionId: row.file_version_id,
      startLine: row.start_line,
      endLine: row.end_line,
      metadata: row.metadata ?? {},
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }
  }

  const upsertFileEdge: AtlasStore['upsertFileEdge'] = async ({
    fromFileVersionId,
    toFileVersionId,
    kind,
    metadata,
  }) => {
    await ensureSchema()

    const resolvedFrom = normalizeText(fromFileVersionId, 'fromFileVersionId')
    const resolvedTo = normalizeText(toFileVersionId, 'toFileVersionId')
    const resolvedKind = normalizeText(kind, 'kind')
    const resolvedMetadata = parseMetadata(metadata)

    const row = await db
      .insertInto('atlas.file_edges')
      .values({
        from_file_version_id: resolvedFrom,
        to_file_version_id: resolvedTo,
        kind: resolvedKind,
        metadata: sql`${resolvedMetadata}::jsonb`,
      })
      .onConflict((oc) =>
        oc.columns(['from_file_version_id', 'to_file_version_id', 'kind']).doUpdateSet({
          metadata: sql`excluded.metadata`,
        }),
      )
      .returning(['id', 'from_file_version_id', 'to_file_version_id', 'kind', 'metadata', 'created_at'])
      .executeTakeFirst()

    if (!row) throw new Error('file edge upsert failed')

    return {
      id: row.id,
      fromFileVersionId: row.from_file_version_id,
      toFileVersionId: row.to_file_version_id,
      kind: row.kind,
      metadata: row.metadata ?? {},
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }
  }

  const upsertGithubEvent: AtlasStore['upsertGithubEvent'] = async ({
    repositoryId,
    deliveryId,
    eventType,
    repository,
    installationId,
    senderLogin,
    payload,
    receivedAt,
    processedAt,
  }) => {
    await ensureSchema()

    const resolvedDeliveryId = normalizeText(deliveryId, 'deliveryId')
    const resolvedEventType = normalizeText(eventType, 'eventType')
    const resolvedRepository = normalizeText(repository, 'repository')
    const resolvedPayload = parseMetadata(payload)

    const resolvedReceivedAt = parseDate(receivedAt)
    const resolvedProcessedAt = parseDate(processedAt)

    const row = await db
      .insertInto('atlas.github_events')
      .values({
        repository_id: repositoryId ?? null,
        delivery_id: resolvedDeliveryId,
        event_type: resolvedEventType,
        repository: resolvedRepository,
        installation_id: normalizeOptionalNullableText(installationId),
        sender_login: normalizeOptionalNullableText(senderLogin),
        payload: sql`${resolvedPayload}::jsonb`,
        received_at: sql`COALESCE(${resolvedReceivedAt}, now())`,
        processed_at: resolvedProcessedAt,
      })
      .onConflict((oc) =>
        oc.column('delivery_id').doUpdateSet({
          repository_id: sql`excluded.repository_id`,
          event_type: sql`excluded.event_type`,
          repository: sql`excluded.repository`,
          installation_id: sql`excluded.installation_id`,
          sender_login: sql`excluded.sender_login`,
          payload: sql`excluded.payload`,
          processed_at: sql`COALESCE(excluded.processed_at, atlas.github_events.processed_at)`,
        }),
      )
      .returning([
        'id',
        'repository_id',
        'delivery_id',
        'event_type',
        'repository',
        'installation_id',
        'sender_login',
        'payload',
        'received_at',
        'processed_at',
      ])
      .executeTakeFirst()

    if (!row) throw new Error('github event upsert failed')

    return {
      id: row.id,
      repositoryId: row.repository_id,
      deliveryId: row.delivery_id,
      eventType: row.event_type,
      repository: row.repository,
      installationId: row.installation_id,
      senderLogin: row.sender_login,
      payload: row.payload ?? {},
      receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : String(row.received_at),
      processedAt: row.processed_at ? toIso(row.processed_at) : null,
    }
  }

  const upsertIngestion: AtlasStore['upsertIngestion'] = async ({
    eventId,
    workflowId,
    status,
    error,
    startedAt,
    finishedAt,
  }) => {
    await ensureSchema()

    const resolvedEventId = normalizeText(eventId, 'eventId')
    const resolvedWorkflowId = normalizeText(workflowId, 'workflowId')
    const resolvedStatus = normalizeText(status, 'status')
    const resolvedError = normalizeOptionalNullableText(error)
    const resolvedStartedAt = parseDate(startedAt)
    const resolvedFinishedAt = parseDate(finishedAt)

    const row = await db
      .insertInto('atlas.ingestions')
      .values({
        event_id: resolvedEventId,
        workflow_id: resolvedWorkflowId,
        status: resolvedStatus,
        error: resolvedError,
        started_at: sql`COALESCE(${resolvedStartedAt}, now())`,
        finished_at: resolvedFinishedAt,
      })
      .onConflict((oc) =>
        oc.columns(['event_id', 'workflow_id']).doUpdateSet({
          status: sql`excluded.status`,
          error: sql`excluded.error`,
          started_at: sql`COALESCE(excluded.started_at, atlas.ingestions.started_at)`,
          finished_at: sql`COALESCE(excluded.finished_at, atlas.ingestions.finished_at)`,
        }),
      )
      .returning(['id', 'event_id', 'workflow_id', 'status', 'error', 'started_at', 'finished_at'])
      .executeTakeFirst()

    if (!row) throw new Error('ingestion upsert failed')

    return {
      id: row.id,
      eventId: row.event_id,
      workflowId: row.workflow_id,
      status: row.status,
      error: row.error,
      startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
      finishedAt: row.finished_at ? toIso(row.finished_at) : null,
    }
  }

  const upsertEventFile: AtlasStore['upsertEventFile'] = async ({ eventId, fileKeyId, changeType }) => {
    await ensureSchema()

    const resolvedEventId = normalizeText(eventId, 'eventId')
    const resolvedFileKeyId = normalizeText(fileKeyId, 'fileKeyId')
    const resolvedChangeType = normalizeText(changeType, 'changeType')

    const row = await db
      .insertInto('atlas.event_files')
      .values({
        event_id: resolvedEventId,
        file_key_id: resolvedFileKeyId,
        change_type: resolvedChangeType,
      })
      .onConflict((oc) =>
        oc.columns(['event_id', 'file_key_id']).doUpdateSet({
          change_type: sql`excluded.change_type`,
        }),
      )
      .returning(['id', 'event_id', 'file_key_id', 'change_type'])
      .executeTakeFirst()

    if (!row) throw new Error('event file upsert failed')

    return {
      id: row.id,
      eventId: row.event_id,
      fileKeyId: row.file_key_id,
      changeType: row.change_type,
    }
  }

  const upsertIngestionTarget: AtlasStore['upsertIngestionTarget'] = async ({ ingestionId, fileVersionId, kind }) => {
    await ensureSchema()

    const resolvedIngestionId = normalizeText(ingestionId, 'ingestionId')
    const resolvedFileVersionId = normalizeText(fileVersionId, 'fileVersionId')
    const resolvedKind = normalizeText(kind, 'kind')

    const row = await db
      .insertInto('atlas.ingestion_targets')
      .values({
        ingestion_id: resolvedIngestionId,
        file_version_id: resolvedFileVersionId,
        kind: resolvedKind,
      })
      .onConflict((oc) =>
        oc.columns(['ingestion_id', 'file_version_id', 'kind']).doUpdateSet({
          kind: sql`excluded.kind`,
        }),
      )
      .returning(['id', 'ingestion_id', 'file_version_id', 'kind'])
      .executeTakeFirst()

    if (!row) throw new Error('ingestion target upsert failed')

    return {
      id: row.id,
      ingestionId: row.ingestion_id,
      fileVersionId: row.file_version_id,
      kind: row.kind,
    }
  }

  const listIndexedFiles: AtlasStore['listIndexedFiles'] = async ({ limit, repository, ref, pathPrefix }) => {
    await ensureSchema()

    const resolvedLimit = Math.max(1, Math.min(200, Math.floor(limit ?? DEFAULT_INDEX_LIMIT)))
    const resolvedRepository = typeof repository === 'string' ? repository.trim() : ''
    const resolvedRef = typeof ref === 'string' ? ref.trim() : ''
    const resolvedPathPrefix = typeof pathPrefix === 'string' ? pathPrefix.trim() : ''

    const conditions: Array<ReturnType<typeof sql>> = []

    if (resolvedRepository) {
      conditions.push(sql`repositories.name = ${resolvedRepository}`)
    }
    if (resolvedRef) {
      conditions.push(sql`file_versions.repository_ref = ${resolvedRef}`)
    }
    if (resolvedPathPrefix) {
      conditions.push(sql`file_keys.path LIKE ${`${resolvedPathPrefix}%`}`)
    }

    const whereClause = conditions.length ? sql`WHERE ${sql.join(conditions, sql` AND `)}` : sql``

    const rows = await sql<{
      repository_name: string
      repository_ref: string
      path: string
      repository_commit: string | null
      content_hash: string
      updated_at: string | Date | null
    }>`
        SELECT latest.repository_name,
               latest.repository_ref,
               latest.path,
               latest.repository_commit,
               latest.content_hash,
               latest.updated_at
        FROM (
          SELECT DISTINCT ON (file_versions.file_key_id, file_versions.repository_ref)
            repositories.name AS repository_name,
            file_versions.repository_ref,
            file_versions.repository_commit,
            file_versions.content_hash,
            file_versions.updated_at,
            file_keys.path
          FROM atlas.file_versions
          JOIN atlas.file_keys ON file_keys.id = file_versions.file_key_id
          JOIN atlas.repositories ON repositories.id = file_keys.repository_id
          ${whereClause}
          ORDER BY file_versions.file_key_id, file_versions.repository_ref, file_versions.updated_at DESC
        ) AS latest
        ORDER BY latest.updated_at DESC NULLS LAST
        LIMIT ${resolvedLimit};
      `.execute(db)

    return rows.rows.map((row) => ({
      repository: row.repository_name,
      ref: row.repository_ref,
      path: row.path,
      commit: row.repository_commit,
      contentHash: row.content_hash,
      updatedAt: row.updated_at ?? undefined,
    }))
  }

  const getAstPreview: AtlasStore['getAstPreview'] = async ({ fileVersionId, limit }) => {
    await ensureSchema()

    const resolvedFileVersionId = normalizeText(fileVersionId, 'fileVersionId')
    const resolvedLimit = Math.max(1, Math.min(1000, Math.floor(limit ?? 500)))

    const facts = await db
      .selectFrom('atlas.tree_sitter_facts')
      .select(['node_type', 'match_text', 'start_line', 'end_line'])
      .where('file_version_id', '=', resolvedFileVersionId)
      .orderBy('start_line', 'asc')
      .orderBy('node_type', 'asc')
      .limit(resolvedLimit)
      .execute()

    const summaryRow = await db
      .selectFrom('atlas.enrichments')
      .select([sql<string>`metadata ->> 'astSummary'`.as('ast_summary')])
      .where('file_version_id', '=', resolvedFileVersionId)
      .where('kind', '=', 'model_enrichment')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst()

    return {
      facts: facts.map((row) => ({
        nodeType: row.node_type,
        matchText: row.match_text,
        startLine: row.start_line ?? null,
        endLine: row.end_line ?? null,
      })),
      summary: summaryRow?.ast_summary ?? null,
    }
  }

  const resolveSearchFilters = ({
    repository,
    ref,
    pathPrefix,
    tags,
    kinds,
  }: Pick<AtlasSearchInput, 'repository' | 'ref' | 'pathPrefix' | 'tags' | 'kinds'>) => ({
    repository: typeof repository === 'string' ? repository.trim() : '',
    ref: typeof ref === 'string' ? ref.trim() : '',
    pathPrefix: typeof pathPrefix === 'string' ? pathPrefix.trim() : '',
    tags: normalizeTags(tags),
    kinds: normalizeTags(kinds),
  })

  const applySearchFilters = <T extends { where: (...args: unknown[]) => T }>(
    query: T,
    filters: ReturnType<typeof resolveSearchFilters>,
  ) => {
    let next = query
    if (filters.repository) {
      next = next.where('repositories.name', '=', filters.repository)
    }
    if (filters.ref) {
      next = next.where('file_versions.repository_ref', '=', filters.ref)
    }
    if (filters.pathPrefix) {
      next = next.where('file_keys.path', 'like', `${filters.pathPrefix}%`)
    }
    if (filters.tags.length > 0) {
      next = next.where(sql<boolean>`enrichments.tags && ${sql.value(filters.tags)}::text[]`)
    }
    if (filters.kinds.length > 0) {
      next = next.where(sql<boolean>`enrichments.kind = ANY(${sql.value(filters.kinds)}::text[])`)
    }
    return next
  }

  const search: AtlasStore['search'] = async ({ query, limit, repository, ref, pathPrefix, tags, kinds }) => {
    await ensureSchema()

    const resolvedQuery = normalizeText(query, 'query')
    const resolvedLimit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit ?? DEFAULT_SEARCH_LIMIT)))
    const filters = resolveSearchFilters({ repository, ref, pathPrefix, tags, kinds })

    const embeddingConfig = loadEmbeddingConfig()
    const embedding = await embedText(resolvedQuery, embeddingConfig)
    const vectorString = vectorToPgArray(embedding)

    const distanceExpr = sql<number>`embeddings.embedding <=> ${vectorString}::vector`

    let searchQuery = db
      .selectFrom('atlas.embeddings as embeddings')
      .innerJoin('atlas.enrichments as enrichments', 'enrichments.id', 'embeddings.enrichment_id')
      .innerJoin('atlas.file_versions as file_versions', 'file_versions.id', 'enrichments.file_version_id')
      .innerJoin('atlas.file_keys as file_keys', 'file_keys.id', 'file_versions.file_key_id')
      .innerJoin('atlas.repositories as repositories', 'repositories.id', 'file_keys.repository_id')
      .select([
        'enrichments.id as enrichment_id',
        'enrichments.file_version_id as enrichment_file_version_id',
        'enrichments.chunk_id as enrichment_chunk_id',
        'enrichments.kind as enrichment_kind',
        'enrichments.source as enrichment_source',
        'enrichments.content as enrichment_content',
        'enrichments.summary as enrichment_summary',
        'enrichments.tags as enrichment_tags',
        'enrichments.metadata as enrichment_metadata',
        'enrichments.created_at as enrichment_created_at',
        'file_versions.id as file_version_id',
        'file_versions.file_key_id as file_version_file_key_id',
        'file_versions.repository_ref as file_version_repository_ref',
        'file_versions.repository_commit as file_version_repository_commit',
        'file_versions.content_hash as file_version_content_hash',
        'file_versions.language as file_version_language',
        'file_versions.byte_size as file_version_byte_size',
        'file_versions.line_count as file_version_line_count',
        'file_versions.metadata as file_version_metadata',
        'file_versions.source_timestamp as file_version_source_timestamp',
        'file_versions.created_at as file_version_created_at',
        'file_versions.updated_at as file_version_updated_at',
        'file_keys.id as file_key_id',
        'file_keys.repository_id as file_key_repository_id',
        'file_keys.path as file_key_path',
        'file_keys.created_at as file_key_created_at',
        'repositories.id as repository_id',
        'repositories.name as repository_name',
        'repositories.default_ref as repository_default_ref',
        'repositories.metadata as repository_metadata',
        'repositories.created_at as repository_created_at',
        'repositories.updated_at as repository_updated_at',
        distanceExpr.as('distance'),
      ])
      .where('embeddings.model', '=', embeddingConfig.model)
      .where('embeddings.dimension', '=', embeddingConfig.dimension)

    searchQuery = applySearchFilters(searchQuery, filters)

    const rows = await searchQuery.orderBy(distanceExpr).limit(resolvedLimit).execute()

    return rows.map((row) => ({
      enrichment: {
        id: row.enrichment_id,
        fileVersionId: row.enrichment_file_version_id,
        chunkId: row.enrichment_chunk_id,
        kind: row.enrichment_kind,
        source: row.enrichment_source,
        content: row.enrichment_content,
        summary: row.enrichment_summary,
        tags: row.enrichment_tags,
        metadata: row.enrichment_metadata,
        createdAt:
          row.enrichment_created_at instanceof Date
            ? row.enrichment_created_at.toISOString()
            : String(row.enrichment_created_at),
        distance: Number(row.distance),
      },
      fileVersion: {
        id: row.file_version_id,
        fileKeyId: row.file_version_file_key_id,
        repositoryRef: row.file_version_repository_ref,
        repositoryCommit: row.file_version_repository_commit,
        contentHash: row.file_version_content_hash,
        language: row.file_version_language,
        byteSize: row.file_version_byte_size,
        lineCount: row.file_version_line_count,
        metadata: row.file_version_metadata,
        sourceTimestamp:
          row.file_version_source_timestamp instanceof Date
            ? row.file_version_source_timestamp.toISOString()
            : row.file_version_source_timestamp
              ? String(row.file_version_source_timestamp)
              : null,
        createdAt:
          row.file_version_created_at instanceof Date
            ? row.file_version_created_at.toISOString()
            : String(row.file_version_created_at),
        updatedAt:
          row.file_version_updated_at instanceof Date
            ? row.file_version_updated_at.toISOString()
            : String(row.file_version_updated_at),
      },
      fileKey: {
        id: row.file_key_id,
        repositoryId: row.file_key_repository_id,
        path: row.file_key_path,
        createdAt:
          row.file_key_created_at instanceof Date
            ? row.file_key_created_at.toISOString()
            : String(row.file_key_created_at),
      },
      repository: {
        id: row.repository_id,
        name: row.repository_name,
        defaultRef: row.repository_default_ref,
        metadata: row.repository_metadata,
        createdAt:
          row.repository_created_at instanceof Date
            ? row.repository_created_at.toISOString()
            : String(row.repository_created_at),
        updatedAt:
          row.repository_updated_at instanceof Date
            ? row.repository_updated_at.toISOString()
            : String(row.repository_updated_at),
      },
    }))
  }

  const searchCount: AtlasStore['searchCount'] = async ({ query, repository, ref, pathPrefix, tags, kinds }) => {
    await ensureSchema()

    const resolvedQuery = normalizeText(query, 'query')
    const filters = resolveSearchFilters({ repository, ref, pathPrefix, tags, kinds })
    const embeddingConfig = loadEmbeddingConfig()
    const embedding = await embedText(resolvedQuery, embeddingConfig)
    const vectorString = vectorToPgArray(embedding)
    const distanceExpr = sql<number>`embeddings.embedding <=> ${vectorString}::vector`

    let countQuery = db
      .selectFrom('atlas.embeddings as embeddings')
      .innerJoin('atlas.enrichments as enrichments', 'enrichments.id', 'embeddings.enrichment_id')
      .innerJoin('atlas.file_versions as file_versions', 'file_versions.id', 'enrichments.file_version_id')
      .innerJoin('atlas.file_keys as file_keys', 'file_keys.id', 'file_versions.file_key_id')
      .innerJoin('atlas.repositories as repositories', 'repositories.id', 'file_keys.repository_id')
      .select(['file_versions.id as file_version_id', distanceExpr.as('distance')])
      .where('embeddings.model', '=', embeddingConfig.model)
      .where('embeddings.dimension', '=', embeddingConfig.dimension)

    countQuery = applySearchFilters(countQuery, filters)

    const rows = await countQuery.orderBy(distanceExpr).limit(MAX_SEARCH_LIMIT).execute()
    const unique = new Set(rows.map((row) => row.file_version_id))
    return unique.size
  }

  const resolveCodeSearchFilters = ({
    repository,
    ref,
    pathPrefix,
    language,
  }: Pick<AtlasCodeSearchInput, 'repository' | 'ref' | 'pathPrefix' | 'language'>) => ({
    repository: typeof repository === 'string' ? repository.trim() : '',
    ref: typeof ref === 'string' ? ref.trim() : '',
    pathPrefix: typeof pathPrefix === 'string' ? pathPrefix.trim() : '',
    language: typeof language === 'string' ? language.trim() : '',
  })

  const applyCodeSearchFilters = <T extends { where: (...args: unknown[]) => T }>(
    query: T,
    filters: ReturnType<typeof resolveCodeSearchFilters>,
  ) => {
    let next = query
    if (filters.repository) {
      next = next.where('repositories.name', '=', filters.repository)
    }
    if (filters.ref) {
      next = next.where('file_versions.repository_ref', '=', filters.ref)
    }
    if (filters.pathPrefix) {
      next = next.where('file_keys.path', 'like', `${filters.pathPrefix}%`)
    }
    if (filters.language) {
      next = next.where('file_versions.language', '=', filters.language)
    }
    return next
  }

  const latestFileVersionIdsExpr = sql<string>`
    SELECT ranked.id
    FROM (
      SELECT
        fv.id,
        ROW_NUMBER() OVER (
          PARTITION BY fv.file_key_id, fv.repository_ref
          ORDER BY fv.updated_at DESC, fv.created_at DESC, fv.id DESC
        ) AS latest_rank
      FROM atlas.file_versions AS fv
    ) AS ranked
    WHERE ranked.latest_rank = 1
  `

  // Keep only the most recent indexed file version per (file, ref)
  // so code-search doesn't surface stale duplicates from prior versions.
  const applyLatestFileVersionFilter = <T extends { where: (...args: unknown[]) => T }>(query: T) =>
    query.where(sql<boolean>`file_versions.id IN (${latestFileVersionIdsExpr})`)

  const codeSearch: AtlasStore['codeSearch'] = async ({ query, limit, repository, ref, pathPrefix, language }) => {
    await ensureSchema()

    const resolvedQuery = normalizeText(query, 'query')
    const resolvedLimit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit ?? DEFAULT_SEARCH_LIMIT)))
    const filters = resolveCodeSearchFilters({ repository, ref, pathPrefix, language })

    const identifiers = extractIdentifierTokens(resolvedQuery)

    const semanticLimit = Math.min(MAX_SEARCH_LIMIT, Math.max(resolvedLimit * 5, resolvedLimit))
    const lexicalLimit = Math.min(MAX_SEARCH_LIMIT, Math.max(resolvedLimit * 5, resolvedLimit))
    const semanticRows = await (async () => {
      try {
        const embeddingConfig = loadEmbeddingConfig()
        const embedding = await embedText(resolvedQuery, embeddingConfig)
        const vectorString = vectorToPgArray(embedding)
        const semanticDistanceExpr = sql<number>`chunk_embeddings.embedding <=> ${vectorString}::vector`

        let semanticQuery = db
          .selectFrom('atlas.chunk_embeddings as chunk_embeddings')
          .innerJoin('atlas.file_chunks as file_chunks', 'file_chunks.id', 'chunk_embeddings.chunk_id')
          .innerJoin('atlas.file_versions as file_versions', 'file_versions.id', 'file_chunks.file_version_id')
          .innerJoin('atlas.file_keys as file_keys', 'file_keys.id', 'file_versions.file_key_id')
          .innerJoin('atlas.repositories as repositories', 'repositories.id', 'file_keys.repository_id')
          .select([
            'file_chunks.id as chunk_id',
            'file_chunks.file_version_id as chunk_file_version_id',
            'file_chunks.chunk_index as chunk_index',
            'file_chunks.start_line as chunk_start_line',
            'file_chunks.end_line as chunk_end_line',
            'file_chunks.content as chunk_content',
            'file_chunks.token_count as chunk_token_count',
            'file_chunks.metadata as chunk_metadata',
            'file_chunks.created_at as chunk_created_at',
            'file_versions.id as file_version_id',
            'file_versions.file_key_id as file_version_file_key_id',
            'file_versions.repository_ref as file_version_repository_ref',
            'file_versions.repository_commit as file_version_repository_commit',
            'file_versions.content_hash as file_version_content_hash',
            'file_versions.language as file_version_language',
            'file_versions.byte_size as file_version_byte_size',
            'file_versions.line_count as file_version_line_count',
            'file_versions.metadata as file_version_metadata',
            'file_versions.source_timestamp as file_version_source_timestamp',
            'file_versions.created_at as file_version_created_at',
            'file_versions.updated_at as file_version_updated_at',
            'file_keys.id as file_key_id',
            'file_keys.repository_id as file_key_repository_id',
            'file_keys.path as file_key_path',
            'file_keys.created_at as file_key_created_at',
            'repositories.id as repository_id',
            'repositories.name as repository_name',
            'repositories.default_ref as repository_default_ref',
            'repositories.metadata as repository_metadata',
            'repositories.created_at as repository_created_at',
            'repositories.updated_at as repository_updated_at',
            semanticDistanceExpr.as('semantic_distance'),
          ])
          .where('chunk_embeddings.model', '=', embeddingConfig.model)
          .where('chunk_embeddings.dimension', '=', embeddingConfig.dimension)

        semanticQuery = applyCodeSearchFilters(semanticQuery, filters)
        semanticQuery = applyLatestFileVersionFilter(semanticQuery)

        return await semanticQuery.orderBy(semanticDistanceExpr).limit(semanticLimit).execute()
      } catch (error) {
        console.warn('[atlas] semantic code search unavailable; falling back to lexical only', {
          error: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    })()

    const lexicalQueryExpr = sql<string>`websearch_to_tsquery('simple', ${resolvedQuery})`
    const lexicalRankExpr = sql<number>`ts_rank_cd(file_chunks.text_tsvector, ${lexicalQueryExpr})`

    let lexicalQuery = db
      .selectFrom('atlas.file_chunks as file_chunks')
      .innerJoin('atlas.file_versions as file_versions', 'file_versions.id', 'file_chunks.file_version_id')
      .innerJoin('atlas.file_keys as file_keys', 'file_keys.id', 'file_versions.file_key_id')
      .innerJoin('atlas.repositories as repositories', 'repositories.id', 'file_keys.repository_id')
      .select([
        'file_chunks.id as chunk_id',
        'file_chunks.file_version_id as chunk_file_version_id',
        'file_chunks.chunk_index as chunk_index',
        'file_chunks.start_line as chunk_start_line',
        'file_chunks.end_line as chunk_end_line',
        'file_chunks.content as chunk_content',
        'file_chunks.token_count as chunk_token_count',
        'file_chunks.metadata as chunk_metadata',
        'file_chunks.created_at as chunk_created_at',
        'file_versions.id as file_version_id',
        'file_versions.file_key_id as file_version_file_key_id',
        'file_versions.repository_ref as file_version_repository_ref',
        'file_versions.repository_commit as file_version_repository_commit',
        'file_versions.content_hash as file_version_content_hash',
        'file_versions.language as file_version_language',
        'file_versions.byte_size as file_version_byte_size',
        'file_versions.line_count as file_version_line_count',
        'file_versions.metadata as file_version_metadata',
        'file_versions.source_timestamp as file_version_source_timestamp',
        'file_versions.created_at as file_version_created_at',
        'file_versions.updated_at as file_version_updated_at',
        'file_keys.id as file_key_id',
        'file_keys.repository_id as file_key_repository_id',
        'file_keys.path as file_key_path',
        'file_keys.created_at as file_key_created_at',
        'repositories.id as repository_id',
        'repositories.name as repository_name',
        'repositories.default_ref as repository_default_ref',
        'repositories.metadata as repository_metadata',
        'repositories.created_at as repository_created_at',
        'repositories.updated_at as repository_updated_at',
        lexicalRankExpr.as('lexical_rank'),
      ])
      .where(sql<boolean>`file_chunks.text_tsvector @@ ${lexicalQueryExpr}`)

    lexicalQuery = applyCodeSearchFilters(lexicalQuery, filters)
    lexicalQuery = applyLatestFileVersionFilter(lexicalQuery)

    const lexicalRows = await lexicalQuery.orderBy(lexicalRankExpr, 'desc').limit(lexicalLimit).execute()

    const merged = new Map<
      string,
      {
        row: (typeof semanticRows)[number] | (typeof lexicalRows)[number]
        semanticDistance: number | null
        lexicalRank: number | null
      }
    >()

    for (const row of semanticRows) {
      merged.set(row.chunk_id, { row, semanticDistance: Number(row.semantic_distance), lexicalRank: null })
    }

    for (const row of lexicalRows) {
      const existing = merged.get(row.chunk_id)
      if (existing) {
        existing.lexicalRank = Number(row.lexical_rank)
      } else {
        merged.set(row.chunk_id, { row, semanticDistance: null, lexicalRank: Number(row.lexical_rank) })
      }
    }

    const results: AtlasCodeSearchMatch[] = []

    for (const entry of merged.values()) {
      const row = entry.row
      const content = row.chunk_content ?? ''
      const { matched } = countIdentifierMatches(content, identifiers)

      const semanticDistance = entry.semanticDistance
      const lexicalRank = entry.lexicalRank

      // Convert distance (lower is better) to a bounded score.
      const semanticScore = semanticDistance === null ? 0 : 1 / (1 + Math.max(0, semanticDistance))
      const lexicalScore = lexicalRank === null ? 0 : Math.max(0, lexicalRank)
      const identifierBoost = Math.min(0.5, matched.length * 0.05)

      const score = semanticScore + lexicalScore * 0.25 + identifierBoost

      results.push({
        repository: {
          id: row.repository_id,
          name: row.repository_name,
          defaultRef: row.repository_default_ref,
          metadata: row.repository_metadata ?? {},
          createdAt:
            row.repository_created_at instanceof Date
              ? row.repository_created_at.toISOString()
              : String(row.repository_created_at),
          updatedAt:
            row.repository_updated_at instanceof Date
              ? row.repository_updated_at.toISOString()
              : String(row.repository_updated_at),
        },
        fileKey: {
          id: row.file_key_id,
          repositoryId: row.file_key_repository_id,
          path: row.file_key_path,
          createdAt:
            row.file_key_created_at instanceof Date
              ? row.file_key_created_at.toISOString()
              : String(row.file_key_created_at),
        },
        fileVersion: {
          id: row.file_version_id,
          fileKeyId: row.file_version_file_key_id,
          repositoryRef: row.file_version_repository_ref,
          repositoryCommit: row.file_version_repository_commit,
          contentHash: row.file_version_content_hash,
          language: row.file_version_language,
          byteSize: row.file_version_byte_size,
          lineCount: row.file_version_line_count,
          metadata: row.file_version_metadata ?? {},
          sourceTimestamp:
            row.file_version_source_timestamp instanceof Date
              ? row.file_version_source_timestamp.toISOString()
              : row.file_version_source_timestamp
                ? String(row.file_version_source_timestamp)
                : null,
          createdAt:
            row.file_version_created_at instanceof Date
              ? row.file_version_created_at.toISOString()
              : String(row.file_version_created_at),
          updatedAt:
            row.file_version_updated_at instanceof Date
              ? row.file_version_updated_at.toISOString()
              : String(row.file_version_updated_at),
        },
        chunk: {
          id: row.chunk_id,
          fileVersionId: row.chunk_file_version_id,
          chunkIndex: row.chunk_index,
          startLine: row.chunk_start_line,
          endLine: row.chunk_end_line,
          content: row.chunk_content,
          tokenCount: row.chunk_token_count,
          metadata: row.chunk_metadata ?? {},
          createdAt:
            row.chunk_created_at instanceof Date ? row.chunk_created_at.toISOString() : String(row.chunk_created_at),
        },
        score,
        signals: {
          semanticDistance,
          lexicalRank,
          matchedIdentifiers: matched,
        },
      })
    }

    return results.sort((a, b) => b.score - a.score).slice(0, resolvedLimit)
  }

  const stats: AtlasStore['stats'] = async () => {
    await ensureSchema()

    const { rows } = await sql<{
      repositories: string | number
      file_keys: string | number
      file_versions: string | number
      enrichments: string | number
      embeddings: string | number
    }>`
      SELECT
        (SELECT COUNT(*) FROM atlas.repositories) AS repositories,
        (SELECT COUNT(*) FROM atlas.file_keys) AS file_keys,
        (SELECT COUNT(*) FROM atlas.file_versions) AS file_versions,
        (SELECT COUNT(*) FROM atlas.enrichments) AS enrichments,
        (SELECT COUNT(*) FROM atlas.embeddings) AS embeddings;
    `.execute(db)

    const row = rows[0]
    if (!row) {
      return { repositories: 0, fileKeys: 0, fileVersions: 0, enrichments: 0, embeddings: 0 }
    }

    return {
      repositories: Number(row.repositories) || 0,
      fileKeys: Number(row.file_keys) || 0,
      fileVersions: Number(row.file_versions) || 0,
      enrichments: Number(row.enrichments) || 0,
      embeddings: Number(row.embeddings) || 0,
    }
  }

  const close: AtlasStore['close'] = async () => {
    await db.destroy()
  }

  return {
    upsertRepository,
    getRepositoryByName,
    upsertFileKey,
    getFileKeyByPath,
    upsertFileVersion,
    getFileVersionByKey,
    upsertFileChunk,
    upsertEnrichment,
    upsertEmbedding,
    upsertTreeSitterFact,
    upsertSymbol,
    upsertSymbolDef,
    upsertSymbolRef,
    upsertFileEdge,
    upsertGithubEvent,
    upsertIngestion,
    upsertEventFile,
    upsertIngestionTarget,
    listIndexedFiles,
    getAstPreview,
    search,
    searchCount,
    codeSearch,
    stats,
    close,
  }
}
