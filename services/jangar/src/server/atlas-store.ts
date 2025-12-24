import { SQL } from 'bun'

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
  repositoryCommit: string
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

export type AtlasStats = {
  repositories: number
  fileKeys: number
  fileVersions: number
  enrichments: number
  embeddings: number
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
  search: (input: AtlasSearchInput) => Promise<AtlasSearchMatch[]>
  stats: () => Promise<AtlasStats>
  close: () => Promise<void>
}

type PostgresAtlasStoreOptions = {
  url?: string
  createDb?: (url: string) => {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
    unsafe: <T = unknown>(query: string, params?: unknown[]) => Promise<T>
    array: (values: unknown[], elementType?: string) => unknown
    close: () => Promise<void>
  }
}

const DEFAULT_SSLMODE = 'require'
const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding:0.6b'
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 1024
const DEFAULT_INDEX_LIMIT = 50
const DEFAULT_SEARCH_LIMIT = 10

const SCHEMA = 'atlas'

const withDefaultSslMode = (rawUrl: string): string => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }

  const params = url.searchParams
  if (params.get('sslmode')) return rawUrl

  const envMode = process.env.PGSSLMODE?.trim()
  const sslmode = envMode && envMode.length > 0 ? envMode : DEFAULT_SSLMODE
  params.set('sslmode', sslmode)

  url.search = params.toString()
  return url.toString()
}

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

export const __private = { withDefaultSslMode }

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

  const db = (options.createDb ?? ((resolvedUrl: string) => new SQL(resolvedUrl)))(withDefaultSslMode(url))
  let schemaReady: Promise<void> | null = null
  const defaults = resolveEmbeddingDefaults(
    process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_API_BASE ?? DEFAULT_OPENAI_API_BASE_URL,
  )
  const expectedEmbeddingDimension = loadEmbeddingDimension(defaults.dimension)

  const ensureEmbeddingDimensionMatches = async () => {
    const rows = (await db`
      SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS embedding_type
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${SCHEMA}
        AND c.relname = 'embeddings'
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped;
    `) as Array<{ embedding_type: string | null }>

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

  const ensureSchema = async () => {
    if (!schemaReady) {
      schemaReady = (async () => {
        try {
          await db.unsafe('CREATE SCHEMA IF NOT EXISTS atlas;')
        } catch (error) {
          throw new Error(`failed to ensure Postgres prerequisites (schema). Original error: ${String(error)}`)
        }

        const extensionRows = await db.unsafe<Array<{ extname: string }>>(
          `SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto')`,
        )
        const installed = new Set(extensionRows.map((row) => row.extname))
        const missing = ['vector', 'pgcrypto'].filter((ext) => !installed.has(ext))
        if (missing.length > 0) {
          throw new Error(
            `missing required Postgres extensions: ${missing.join(', ')}. ` +
              'Install them as a privileged user (e.g. `CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;`) ' +
              'or configure CNPG bootstrap.initdb.postInitApplicationSQL to create them at cluster init.',
          )
        }

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.repositories (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            name TEXT NOT NULL,
            default_ref TEXT NOT NULL DEFAULT 'main',
            metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (name)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.file_keys (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            repository_id UUID NOT NULL REFERENCES atlas.repositories(id) ON DELETE CASCADE,
            path TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (repository_id, path)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.file_versions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            file_key_id UUID NOT NULL REFERENCES atlas.file_keys(id) ON DELETE CASCADE,
            repository_ref TEXT NOT NULL DEFAULT 'main',
            repository_commit TEXT,
            content_hash TEXT NOT NULL DEFAULT '',
            language TEXT,
            byte_size INT,
            line_count INT,
            metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
            source_timestamp TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (repository_commit IS NULL OR repository_commit <> ''),
            UNIQUE (file_key_id, repository_ref, repository_commit, content_hash)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.file_chunks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
            chunk_index INT NOT NULL,
            start_line INT,
            end_line INT,
            content TEXT,
            token_count INT,
            metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (file_version_id, chunk_index)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.enrichments (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
            chunk_id UUID REFERENCES atlas.file_chunks(id) ON DELETE SET NULL,
            kind TEXT NOT NULL,
            source TEXT NOT NULL,
            content TEXT NOT NULL,
            summary TEXT,
            tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
            metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (file_version_id, chunk_id, kind, source)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.embeddings (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            enrichment_id UUID NOT NULL REFERENCES atlas.enrichments(id) ON DELETE CASCADE,
            model TEXT NOT NULL,
            dimension INT NOT NULL,
            embedding vector(${expectedEmbeddingDimension}) NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (enrichment_id, model, dimension)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.tree_sitter_facts (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
            node_type TEXT NOT NULL,
            match_text TEXT NOT NULL,
            start_line INT,
            end_line INT,
            metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (file_version_id, node_type, match_text, start_line, end_line)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.symbols (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            repository_id UUID NOT NULL REFERENCES atlas.repositories(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            kind TEXT NOT NULL,
            signature TEXT NOT NULL DEFAULT '',
            metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (repository_id, normalized_name, kind, signature)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.symbol_defs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            symbol_id UUID NOT NULL REFERENCES atlas.symbols(id) ON DELETE CASCADE,
            file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
            start_line INT,
            end_line INT,
            metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (symbol_id, file_version_id, start_line, end_line)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.symbol_refs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            symbol_id UUID NOT NULL REFERENCES atlas.symbols(id) ON DELETE CASCADE,
            file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
            start_line INT,
            end_line INT,
            metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (symbol_id, file_version_id, start_line, end_line)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.file_edges (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            from_file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
            to_file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (from_file_version_id, to_file_version_id, kind)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.github_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            repository_id UUID REFERENCES atlas.repositories(id) ON DELETE SET NULL,
            delivery_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            repository TEXT NOT NULL,
            installation_id TEXT,
            sender_login TEXT,
            payload JSONB NOT NULL DEFAULT '{}'::JSONB,
            received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            processed_at TIMESTAMPTZ,
            UNIQUE (delivery_id)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.ingestions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event_id UUID NOT NULL REFERENCES atlas.github_events(id) ON DELETE CASCADE,
            workflow_id TEXT NOT NULL,
            status TEXT NOT NULL,
            error TEXT,
            started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            finished_at TIMESTAMPTZ,
            UNIQUE (event_id, workflow_id)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.event_files (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event_id UUID NOT NULL REFERENCES atlas.github_events(id) ON DELETE CASCADE,
            file_key_id UUID NOT NULL REFERENCES atlas.file_keys(id) ON DELETE CASCADE,
            change_type TEXT NOT NULL,
            UNIQUE (event_id, file_key_id)
          );
        `)

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS atlas.ingestion_targets (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            ingestion_id UUID NOT NULL REFERENCES atlas.ingestions(id) ON DELETE CASCADE,
            file_version_id UUID NOT NULL REFERENCES atlas.file_versions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            UNIQUE (ingestion_id, file_version_id, kind)
          );
        `)

        await ensureEmbeddingDimensionMatches()

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_file_keys_path_idx
          ON atlas.file_keys (path text_pattern_ops);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_file_versions_ref_idx
          ON atlas.file_versions (repository_ref, repository_commit);
        `)

        await db.unsafe(`
          CREATE UNIQUE INDEX IF NOT EXISTS atlas_file_versions_hash_null_commit_idx
          ON atlas.file_versions (file_key_id, repository_ref, content_hash)
          WHERE repository_commit IS NULL;
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_file_versions_metadata_idx
          ON atlas.file_versions USING GIN (metadata JSONB_PATH_OPS);
        `)

        await db.unsafe(`
          CREATE UNIQUE INDEX IF NOT EXISTS atlas_enrichments_file_kind_source_null_chunk_idx
          ON atlas.enrichments (file_version_id, kind, source)
          WHERE chunk_id IS NULL;
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_enrichments_kind_idx
          ON atlas.enrichments (kind);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_enrichments_tags_idx
          ON atlas.enrichments USING GIN (tags);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_enrichments_metadata_idx
          ON atlas.enrichments USING GIN (metadata JSONB_PATH_OPS);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_embeddings_embedding_idx
          ON atlas.embeddings
          USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_symbols_lookup_idx
          ON atlas.symbols (normalized_name, kind);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_symbol_defs_file_idx
          ON atlas.symbol_defs (file_version_id);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_symbol_refs_file_idx
          ON atlas.symbol_refs (file_version_id);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_file_edges_from_idx
          ON atlas.file_edges (from_file_version_id, kind);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS atlas_file_edges_to_idx
          ON atlas.file_edges (to_file_version_id, kind);
        `)
      })()
    }
    await schemaReady
  }

  const upsertRepository: AtlasStore['upsertRepository'] = async ({ name, defaultRef, metadata }) => {
    await ensureSchema()

    const resolvedName = normalizeText(name, 'repository name')
    const resolvedDefaultRef = normalizeText(defaultRef ?? 'main', 'repository default ref', 'main')
    const resolvedMetadata = parseMetadata(metadata)

    const rows = (await db`
      INSERT INTO atlas.repositories (name, default_ref, metadata)
      VALUES (${resolvedName}, ${resolvedDefaultRef}, ${resolvedMetadata}::jsonb)
      ON CONFLICT (name)
      DO UPDATE SET default_ref = EXCLUDED.default_ref, metadata = EXCLUDED.metadata, updated_at = now()
      RETURNING id, name, default_ref, metadata, created_at, updated_at;
    `) as Array<{
      id: string
      name: string
      default_ref: string
      metadata: Record<string, unknown>
      created_at: string | Date
      updated_at: string | Date
    }>

    const row = rows[0]
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
    const rows = (await db`
      SELECT id, name, default_ref, metadata, created_at, updated_at
      FROM atlas.repositories
      WHERE name = ${resolvedName}
      LIMIT 1;
    `) as Array<{
      id: string
      name: string
      default_ref: string
      metadata: Record<string, unknown>
      created_at: string | Date
      updated_at: string | Date
    }>

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.file_keys (repository_id, path)
      VALUES (${resolvedRepoId}, ${resolvedPath})
      ON CONFLICT (repository_id, path)
      DO UPDATE SET path = EXCLUDED.path
      RETURNING id, repository_id, path, created_at;
    `) as Array<{ id: string; repository_id: string; path: string; created_at: string | Date }>

    const row = rows[0]
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

    const rows = (await db`
      SELECT id, repository_id, path, created_at
      FROM atlas.file_keys
      WHERE repository_id = ${resolvedRepoId} AND path = ${resolvedPath}
      LIMIT 1;
    `) as Array<{ id: string; repository_id: string; path: string; created_at: string | Date }>

    const row = rows[0]
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
    const resolvedCommit = normalizeOptionalText(repositoryCommit)
    const resolvedHash = normalizeOptionalText(contentHash)

    if (!resolvedCommit && !resolvedHash) {
      throw new Error('repositoryCommit or contentHash is required for file versions')
    }

    const resolvedMetadata = parseMetadata(metadata)
    const resolvedSourceTimestamp = parseDate(sourceTimestamp)

    const rows = (await db`
      INSERT INTO atlas.file_versions (
        file_key_id,
        repository_ref,
        repository_commit,
        content_hash,
        language,
        byte_size,
        line_count,
        metadata,
        source_timestamp
      )
      VALUES (
        ${resolvedFileKeyId},
        ${resolvedRepositoryRef},
        ${resolvedCommit},
        ${resolvedHash},
        ${normalizeOptionalNullableText(language)},
        ${byteSize ?? null},
        ${lineCount ?? null},
        ${resolvedMetadata}::jsonb,
        ${resolvedSourceTimestamp}
      )
      ON CONFLICT (file_key_id, repository_ref, repository_commit, content_hash)
      DO UPDATE SET
        language = EXCLUDED.language,
        byte_size = EXCLUDED.byte_size,
        line_count = EXCLUDED.line_count,
        metadata = EXCLUDED.metadata,
        source_timestamp = EXCLUDED.source_timestamp,
        updated_at = now()
      RETURNING id, file_key_id, repository_ref, repository_commit, content_hash, language, byte_size, line_count,
        metadata, source_timestamp, created_at, updated_at;
    `) as Array<{
      id: string
      file_key_id: string
      repository_ref: string
      repository_commit: string
      content_hash: string
      language: string | null
      byte_size: number | null
      line_count: number | null
      metadata: Record<string, unknown>
      source_timestamp: string | Date | null
      created_at: string | Date
      updated_at: string | Date
    }>

    const row = rows[0]
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

    const rows = (await db`
      SELECT id, file_key_id, repository_ref, repository_commit, content_hash, language, byte_size, line_count,
        metadata, source_timestamp, created_at, updated_at
      FROM atlas.file_versions
      WHERE file_key_id = ${resolvedFileKeyId}
        AND repository_ref = ${resolvedRepositoryRef}
        AND repository_commit = ${resolvedCommit}
        AND content_hash = ${resolvedHash}
      LIMIT 1;
    `) as Array<{
      id: string
      file_key_id: string
      repository_ref: string
      repository_commit: string
      content_hash: string
      language: string | null
      byte_size: number | null
      line_count: number | null
      metadata: Record<string, unknown>
      source_timestamp: string | Date | null
      created_at: string | Date
      updated_at: string | Date
    }>

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.file_chunks (
        file_version_id,
        chunk_index,
        start_line,
        end_line,
        content,
        token_count,
        metadata
      )
      VALUES (
        ${resolvedFileVersionId},
        ${Math.floor(chunkIndex)},
        ${startLine ?? null},
        ${endLine ?? null},
        ${content ?? null},
        ${tokenCount ?? null},
        ${resolvedMetadata}::jsonb
      )
      ON CONFLICT (file_version_id, chunk_index)
      DO UPDATE SET
        start_line = EXCLUDED.start_line,
        end_line = EXCLUDED.end_line,
        content = EXCLUDED.content,
        token_count = EXCLUDED.token_count,
        metadata = EXCLUDED.metadata
      RETURNING id, file_version_id, chunk_index, start_line, end_line, content, token_count, metadata, created_at;
    `) as Array<{
      id: string
      file_version_id: string
      chunk_index: number
      start_line: number | null
      end_line: number | null
      content: string | null
      token_count: number | null
      metadata: Record<string, unknown>
      created_at: string | Date
    }>

    const row = rows[0]
    if (!row) throw new Error('file chunk upsert failed')

    return {
      id: row.id,
      fileVersionId: row.file_version_id,
      chunkIndex: row.chunk_index,
      startLine: row.start_line,
      endLine: row.end_line,
      content: row.content,
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

    const rows = resolvedChunkId
      ? ((await db`
          INSERT INTO atlas.enrichments (
            file_version_id,
            chunk_id,
            kind,
            source,
            content,
            summary,
            tags,
            metadata
          )
          VALUES (
            ${resolvedFileVersionId},
            ${resolvedChunkId},
            ${resolvedKind},
            ${resolvedSource},
            ${resolvedContent},
            ${resolvedSummary},
            ${db.array(resolvedTags, 'text')}::text[],
            ${resolvedMetadata}::jsonb
          )
          ON CONFLICT (file_version_id, chunk_id, kind, source)
          DO UPDATE SET
            content = EXCLUDED.content,
            summary = EXCLUDED.summary,
            tags = EXCLUDED.tags,
            metadata = EXCLUDED.metadata
          RETURNING id, file_version_id, chunk_id, kind, source, content, summary, tags, metadata, created_at;
        `) as Array<{
          id: string
          file_version_id: string
          chunk_id: string | null
          kind: string
          source: string
          content: string
          summary: string | null
          tags: string[]
          metadata: Record<string, unknown>
          created_at: string | Date
        }>)
      : ((await db`
          INSERT INTO atlas.enrichments (
            file_version_id,
            chunk_id,
            kind,
            source,
            content,
            summary,
            tags,
            metadata
          )
          VALUES (
            ${resolvedFileVersionId},
            ${resolvedChunkId},
            ${resolvedKind},
            ${resolvedSource},
            ${resolvedContent},
            ${resolvedSummary},
            ${db.array(resolvedTags, 'text')}::text[],
            ${resolvedMetadata}::jsonb
          )
          ON CONFLICT (file_version_id, kind, source) WHERE chunk_id IS NULL
          DO UPDATE SET
            content = EXCLUDED.content,
            summary = EXCLUDED.summary,
            tags = EXCLUDED.tags,
            metadata = EXCLUDED.metadata
          RETURNING id, file_version_id, chunk_id, kind, source, content, summary, tags, metadata, created_at;
        `) as Array<{
          id: string
          file_version_id: string
          chunk_id: string | null
          kind: string
          source: string
          content: string
          summary: string | null
          tags: string[]
          metadata: Record<string, unknown>
          created_at: string | Date
        }>)

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.embeddings (enrichment_id, model, dimension, embedding)
      VALUES (
        ${resolvedEnrichmentId},
        ${resolvedModel},
        ${resolvedDimension},
        ${vectorString}::vector
      )
      ON CONFLICT (enrichment_id, model, dimension)
      DO UPDATE SET embedding = EXCLUDED.embedding
      RETURNING id, enrichment_id, model, dimension, created_at;
    `) as Array<{ id: string; enrichment_id: string; model: string; dimension: number; created_at: string | Date }>

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.tree_sitter_facts (
        file_version_id,
        node_type,
        match_text,
        start_line,
        end_line,
        metadata
      )
      VALUES (
        ${resolvedFileVersionId},
        ${resolvedNodeType},
        ${resolvedMatchText},
        ${startLine ?? null},
        ${endLine ?? null},
        ${resolvedMetadata}::jsonb
      )
      ON CONFLICT (file_version_id, node_type, match_text, start_line, end_line)
      DO UPDATE SET metadata = EXCLUDED.metadata
      RETURNING id, file_version_id, node_type, match_text, start_line, end_line, metadata, created_at;
    `) as Array<{
      id: string
      file_version_id: string
      node_type: string
      match_text: string
      start_line: number | null
      end_line: number | null
      metadata: Record<string, unknown>
      created_at: string | Date
    }>

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.symbols (repository_id, name, normalized_name, kind, signature, metadata)
      VALUES (
        ${resolvedRepositoryId},
        ${resolvedName},
        ${resolvedNormalizedName},
        ${resolvedKind},
        ${resolvedSignature},
        ${resolvedMetadata}::jsonb
      )
      ON CONFLICT (repository_id, normalized_name, kind, signature)
      DO UPDATE SET name = EXCLUDED.name, metadata = EXCLUDED.metadata
      RETURNING id, repository_id, name, normalized_name, kind, signature, metadata, created_at;
    `) as Array<{
      id: string
      repository_id: string
      name: string
      normalized_name: string
      kind: string
      signature: string
      metadata: Record<string, unknown>
      created_at: string | Date
    }>

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.symbol_defs (symbol_id, file_version_id, start_line, end_line, metadata)
      VALUES (
        ${resolvedSymbolId},
        ${resolvedFileVersionId},
        ${startLine ?? null},
        ${endLine ?? null},
        ${resolvedMetadata}::jsonb
      )
      ON CONFLICT (symbol_id, file_version_id, start_line, end_line)
      DO UPDATE SET metadata = EXCLUDED.metadata
      RETURNING id, symbol_id, file_version_id, start_line, end_line, metadata, created_at;
    `) as Array<{
      id: string
      symbol_id: string
      file_version_id: string
      start_line: number | null
      end_line: number | null
      metadata: Record<string, unknown>
      created_at: string | Date
    }>

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.symbol_refs (symbol_id, file_version_id, start_line, end_line, metadata)
      VALUES (
        ${resolvedSymbolId},
        ${resolvedFileVersionId},
        ${startLine ?? null},
        ${endLine ?? null},
        ${resolvedMetadata}::jsonb
      )
      ON CONFLICT (symbol_id, file_version_id, start_line, end_line)
      DO UPDATE SET metadata = EXCLUDED.metadata
      RETURNING id, symbol_id, file_version_id, start_line, end_line, metadata, created_at;
    `) as Array<{
      id: string
      symbol_id: string
      file_version_id: string
      start_line: number | null
      end_line: number | null
      metadata: Record<string, unknown>
      created_at: string | Date
    }>

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.file_edges (from_file_version_id, to_file_version_id, kind, metadata)
      VALUES (${resolvedFrom}, ${resolvedTo}, ${resolvedKind}, ${resolvedMetadata}::jsonb)
      ON CONFLICT (from_file_version_id, to_file_version_id, kind)
      DO UPDATE SET metadata = EXCLUDED.metadata
      RETURNING id, from_file_version_id, to_file_version_id, kind, metadata, created_at;
    `) as Array<{
      id: string
      from_file_version_id: string
      to_file_version_id: string
      kind: string
      metadata: Record<string, unknown>
      created_at: string | Date
    }>

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.github_events (
        repository_id,
        delivery_id,
        event_type,
        repository,
        installation_id,
        sender_login,
        payload,
        received_at,
        processed_at
      )
      VALUES (
        ${repositoryId ?? null},
        ${resolvedDeliveryId},
        ${resolvedEventType},
        ${resolvedRepository},
        ${normalizeOptionalNullableText(installationId)},
        ${normalizeOptionalNullableText(senderLogin)},
        ${resolvedPayload}::jsonb,
        COALESCE(${resolvedReceivedAt}, now()),
        ${resolvedProcessedAt}
      )
      ON CONFLICT (delivery_id)
      DO UPDATE SET
        repository_id = EXCLUDED.repository_id,
        event_type = EXCLUDED.event_type,
        repository = EXCLUDED.repository,
        installation_id = EXCLUDED.installation_id,
        sender_login = EXCLUDED.sender_login,
        payload = EXCLUDED.payload,
        processed_at = COALESCE(EXCLUDED.processed_at, atlas.github_events.processed_at)
      RETURNING id, repository_id, delivery_id, event_type, repository, installation_id, sender_login, payload,
        received_at, processed_at;
    `) as Array<{
      id: string
      repository_id: string | null
      delivery_id: string
      event_type: string
      repository: string
      installation_id: string | null
      sender_login: string | null
      payload: Record<string, unknown>
      received_at: string | Date
      processed_at: string | Date | null
    }>

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.ingestions (event_id, workflow_id, status, error, started_at, finished_at)
      VALUES (
        ${resolvedEventId},
        ${resolvedWorkflowId},
        ${resolvedStatus},
        ${resolvedError},
        COALESCE(${resolvedStartedAt}, now()),
        ${resolvedFinishedAt}
      )
      ON CONFLICT (event_id, workflow_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        error = EXCLUDED.error,
        started_at = COALESCE(EXCLUDED.started_at, atlas.ingestions.started_at),
        finished_at = COALESCE(EXCLUDED.finished_at, atlas.ingestions.finished_at)
      RETURNING id, event_id, workflow_id, status, error, started_at, finished_at;
    `) as Array<{
      id: string
      event_id: string
      workflow_id: string
      status: string
      error: string | null
      started_at: string | Date
      finished_at: string | Date | null
    }>

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.event_files (event_id, file_key_id, change_type)
      VALUES (${resolvedEventId}, ${resolvedFileKeyId}, ${resolvedChangeType})
      ON CONFLICT (event_id, file_key_id)
      DO UPDATE SET change_type = EXCLUDED.change_type
      RETURNING id, event_id, file_key_id, change_type;
    `) as Array<{ id: string; event_id: string; file_key_id: string; change_type: string }>

    const row = rows[0]
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

    const rows = (await db`
      INSERT INTO atlas.ingestion_targets (ingestion_id, file_version_id, kind)
      VALUES (${resolvedIngestionId}, ${resolvedFileVersionId}, ${resolvedKind})
      ON CONFLICT (ingestion_id, file_version_id, kind)
      DO UPDATE SET kind = EXCLUDED.kind
      RETURNING id, ingestion_id, file_version_id, kind;
    `) as Array<{ id: string; ingestion_id: string; file_version_id: string; kind: string }>

    const row = rows[0]
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

    const conditions: string[] = []
    const params: unknown[] = []

    if (resolvedRepository) {
      params.push(resolvedRepository)
      conditions.push(`repositories.name = $${params.length}`)
    }
    if (resolvedRef) {
      params.push(resolvedRef)
      conditions.push(`file_versions.repository_ref = $${params.length}`)
    }
    if (resolvedPathPrefix) {
      params.push(`${resolvedPathPrefix}%`)
      conditions.push(`file_keys.path LIKE $${params.length}`)
    }

    params.push(resolvedLimit)
    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const limitParam = `$${params.length}`

    const rows = await db.unsafe<
      Array<{
        repository_name: string
        repository_ref: string
        path: string
        repository_commit: string | null
        content_hash: string
        updated_at: string | Date | null
      }>
    >(
      `
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
        LIMIT ${limitParam};
      `,
      params,
    )

    return rows.map((row) => ({
      repository: row.repository_name,
      ref: row.repository_ref,
      path: row.path,
      commit: row.repository_commit,
      contentHash: row.content_hash,
      updatedAt: row.updated_at ?? undefined,
    }))
  }

  const search: AtlasStore['search'] = async ({ query, limit, repository, ref, pathPrefix, tags, kinds }) => {
    await ensureSchema()

    const resolvedQuery = normalizeText(query, 'query')
    const resolvedLimit = Math.max(1, Math.min(50, Math.floor(limit ?? DEFAULT_SEARCH_LIMIT)))
    const resolvedRepository = typeof repository === 'string' ? repository.trim() : ''
    const resolvedRef = typeof ref === 'string' ? ref.trim() : ''
    const resolvedPathPrefix = typeof pathPrefix === 'string' ? pathPrefix.trim() : ''
    const resolvedTags = normalizeTags(tags)
    const resolvedKinds = normalizeTags(kinds)

    const embeddingConfig = loadEmbeddingConfig()
    const embedding = await embedText(resolvedQuery, embeddingConfig)
    const vectorString = vectorToPgArray(embedding)

    const conditions = ['embeddings.model = $2', 'embeddings.dimension = $3']
    const params: unknown[] = [vectorString, embeddingConfig.model, embeddingConfig.dimension]

    if (resolvedRepository) {
      params.push(resolvedRepository)
      conditions.push(`repositories.name = $${params.length}`)
    }
    if (resolvedRef) {
      params.push(resolvedRef)
      conditions.push(`file_versions.repository_ref = $${params.length}`)
    }
    if (resolvedPathPrefix) {
      params.push(`${resolvedPathPrefix}%`)
      conditions.push(`file_keys.path LIKE $${params.length}`)
    }
    if (resolvedTags.length > 0) {
      params.push(resolvedTags)
      conditions.push(`enrichments.tags && $${params.length}::text[]`)
    }
    if (resolvedKinds.length > 0) {
      params.push(resolvedKinds)
      conditions.push(`enrichments.kind = ANY($${params.length}::text[])`)
    }

    params.push(resolvedLimit)

    const rows = await db.unsafe<
      Array<{
        enrichment_id: string
        enrichment_file_version_id: string
        enrichment_chunk_id: string | null
        enrichment_kind: string
        enrichment_source: string
        enrichment_content: string
        enrichment_summary: string | null
        enrichment_tags: string[]
        enrichment_metadata: Record<string, unknown>
        enrichment_created_at: string | Date
        file_version_id: string
        file_version_file_key_id: string
        file_version_repository_ref: string
        file_version_repository_commit: string
        file_version_content_hash: string
        file_version_language: string | null
        file_version_byte_size: number | null
        file_version_line_count: number | null
        file_version_metadata: Record<string, unknown>
        file_version_source_timestamp: string | Date | null
        file_version_created_at: string | Date
        file_version_updated_at: string | Date
        file_key_id: string
        file_key_repository_id: string
        file_key_path: string
        file_key_created_at: string | Date
        repository_id: string
        repository_name: string
        repository_default_ref: string
        repository_metadata: Record<string, unknown>
        repository_created_at: string | Date
        repository_updated_at: string | Date
        distance: number
      }>
    >(
      `
        SELECT
          enrichments.id AS enrichment_id,
          enrichments.file_version_id AS enrichment_file_version_id,
          enrichments.chunk_id AS enrichment_chunk_id,
          enrichments.kind AS enrichment_kind,
          enrichments.source AS enrichment_source,
          enrichments.content AS enrichment_content,
          enrichments.summary AS enrichment_summary,
          enrichments.tags AS enrichment_tags,
          enrichments.metadata AS enrichment_metadata,
          enrichments.created_at AS enrichment_created_at,
          file_versions.id AS file_version_id,
          file_versions.file_key_id AS file_version_file_key_id,
          file_versions.repository_ref AS file_version_repository_ref,
          file_versions.repository_commit AS file_version_repository_commit,
          file_versions.content_hash AS file_version_content_hash,
          file_versions.language AS file_version_language,
          file_versions.byte_size AS file_version_byte_size,
          file_versions.line_count AS file_version_line_count,
          file_versions.metadata AS file_version_metadata,
          file_versions.source_timestamp AS file_version_source_timestamp,
          file_versions.created_at AS file_version_created_at,
          file_versions.updated_at AS file_version_updated_at,
          file_keys.id AS file_key_id,
          file_keys.repository_id AS file_key_repository_id,
          file_keys.path AS file_key_path,
          file_keys.created_at AS file_key_created_at,
          repositories.id AS repository_id,
          repositories.name AS repository_name,
          repositories.default_ref AS repository_default_ref,
          repositories.metadata AS repository_metadata,
          repositories.created_at AS repository_created_at,
          repositories.updated_at AS repository_updated_at,
          embeddings.embedding <=> $1::vector AS distance
        FROM atlas.embeddings AS embeddings
        JOIN atlas.enrichments AS enrichments
          ON enrichments.id = embeddings.enrichment_id
        JOIN atlas.file_versions AS file_versions
          ON file_versions.id = enrichments.file_version_id
        JOIN atlas.file_keys AS file_keys
          ON file_keys.id = file_versions.file_key_id
        JOIN atlas.repositories AS repositories
          ON repositories.id = file_keys.repository_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY embeddings.embedding <=> $1::vector
        LIMIT $${params.length};
      `,
      params,
    )

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

  const stats: AtlasStore['stats'] = async () => {
    await ensureSchema()

    const rows = await db.unsafe<
      Array<{
        repositories: string | number
        file_keys: string | number
        file_versions: string | number
        enrichments: string | number
        embeddings: string | number
      }>
    >(
      `
        SELECT
          (SELECT COUNT(*) FROM atlas.repositories) AS repositories,
          (SELECT COUNT(*) FROM atlas.file_keys) AS file_keys,
          (SELECT COUNT(*) FROM atlas.file_versions) AS file_versions,
          (SELECT COUNT(*) FROM atlas.enrichments) AS enrichments,
          (SELECT COUNT(*) FROM atlas.embeddings) AS embeddings;
      `,
    )

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
    await db.close()
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
    search,
    stats,
    close,
  }
}
