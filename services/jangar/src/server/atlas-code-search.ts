import { sql } from 'kysely'

import type { Db } from '~/server/db'
import type { FileChunkRecord, FileKeyRecord, FileVersionRecord, RepositoryRecord } from './atlas-store'
import type { EmbeddingConfig } from './memory-config'

export type AtlasCodeSearchInput = {
  query: string
  limit?: number
  repository?: string
  ref?: string
  pathPrefix?: string
  language?: string
}

export type AtlasCodeSearchSignals = {
  exactRank: number | null
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
  retrievalMode: 'exact' | 'lexical' | 'semantic' | 'hybrid'
  degradation: string | null
  signals: AtlasCodeSearchSignals
}

export type AtlasCodeSearchHealthStatus = 'ok' | 'degraded' | 'critical' | 'empty'

export type AtlasCodeSearchHealth = {
  status: AtlasCodeSearchHealthStatus
  checkedAt: string
  model: string
  dimension: number
  indexStatus: 'maintenance' | 'building' | 'ready' | 'failed' | 'missing'
  indexedCommit: string | null
  gitHead: string | null
  treeHash: string | null
  filters: {
    repository: string | null
    ref: string | null
    pathPrefix: string | null
    language: string | null
  }
  corpus: {
    expectedFiles: number
    indexedFiles: number
    missingPaths: number
    stalePaths: number
    hashMismatches: number
    uncoveredLines: number
    chunks: number
    embeddedChunks: number
  }
  lastError: string | null
  message: string
}

type AtlasCodeSearchRow = {
  chunk_id: string
  chunk_file_version_id: string
  chunk_index: number
  chunk_start_line: number | null
  chunk_end_line: number | null
  chunk_content: string | null
  chunk_token_count: number | null
  chunk_metadata: Record<string, unknown> | null
  chunk_created_at: Date | string
  file_version_id: string
  file_version_file_key_id: string
  file_version_repository_ref: string
  file_version_repository_commit: string | null
  file_version_content_hash: string
  file_version_language: string | null
  file_version_byte_size: number | null
  file_version_line_count: number | null
  file_version_metadata: Record<string, unknown> | null
  file_version_source_timestamp: Date | string | null
  file_version_created_at: Date | string
  file_version_updated_at: Date | string
  file_key_id: string
  file_key_repository_id: string
  file_key_path: string
  file_key_created_at: Date | string
  repository_id: string
  repository_name: string
  repository_default_ref: string
  repository_metadata: Record<string, unknown> | null
  repository_created_at: Date | string
  repository_updated_at: Date | string
  semantic_distance?: number | string | null
  lexical_rank?: number | string | null
  exact_rank?: number | string | null
}

type CodeSearchFilters = {
  repository: string
  ref: string
  pathPrefix: string
  language: string
}

type CreateAtlasCodeSearchHandlersOptions = {
  db: Db
  ensureSchema: () => Promise<void>
  loadEmbeddingConfig: () => EmbeddingConfig
  embedText: (text: string, config: EmbeddingConfig) => Promise<number[]>
  normalizeText: (value: string, field: string, fallback?: string) => string
}

const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 200
const MIN_SEMANTIC_CANDIDATES = 20
const SEMANTIC_CANDIDATE_MULTIPLIER = 2
const DEFAULT_CODE_SEARCH_SEMANTIC_TIMEOUT_MS = 12_000
const DEFAULT_CODE_SEARCH_STATEMENT_TIMEOUT_MS = 750
const MAX_CODE_SEARCH_STATEMENT_TIMEOUT_MS = 900
const DEFAULT_CODE_SEARCH_QUERY_EMBEDDING_CACHE_TTL_MS = 60_000
const RRF_K = 60
const ATLAS_QUERY_INSTRUCTION = 'Given a query, retrieve relevant source-code chunks from the repository'
const LEXICAL_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'how',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'to',
  'which',
  'with',
])

const vectorToPgArray = (values: number[]) => `[${values.join(',')}]`

const extractIdentifierTokens = (query: string) => {
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
  const normalizedHaystack = haystack.toLowerCase()
  const matched: string[] = []
  for (const token of identifiers) {
    if (matched.length >= 10) break
    if (normalizedHaystack.includes(token.toLowerCase())) {
      matched.push(token)
    }
  }
  return { matched, count: matched.length }
}

const parsePositiveIntEnv = (name: string, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return Math.min(max, Math.floor(parsed))
}

const buildAtlasQueryInstruction = (query: string) => `Instruct: ${ATLAS_QUERY_INSTRUCTION}\nQuery: ${query}`

const escapeLikePattern = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`)

const buildDefinitionPattern = (query: string) => {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(query)) return null
  const escaped = query.replace(/\$/g, '\\$')
  return `(^|\\n)[[:space:]]*(export[[:space:]]+)?(default[[:space:]]+)?(async[[:space:]]+)?(const|let|var|function|class|interface|type|enum)[[:space:]]+${escaped}([^A-Za-z0-9_$]|$)`
}

const buildLexicalQuery = (query: string) => {
  const terms = [
    ...new Set(
      (query.match(/[A-Za-z0-9_$]+/g) ?? [])
        .map((term) => term.toLowerCase())
        .filter((term) => term.length > 2 && !LEXICAL_STOP_WORDS.has(term)),
    ),
  ].slice(0, 10)
  if (terms.length < 3) return query
  return terms.map((_, omitted) => terms.filter((__, index) => index !== omitted).join(' ')).join(' OR ')
}

const resolveCodeSearchFilters = ({
  repository,
  ref,
  pathPrefix,
  language,
}: Pick<AtlasCodeSearchInput, 'repository' | 'ref' | 'pathPrefix' | 'language'>): CodeSearchFilters => ({
  repository: typeof repository === 'string' ? repository.trim() : '',
  ref: typeof ref === 'string' ? ref.trim() : '',
  pathPrefix: typeof pathPrefix === 'string' ? pathPrefix.trim() : '',
  language: typeof language === 'string' ? language.trim() : '',
})

const asMetadata = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const metadataString = (metadata: Record<string, unknown>, key: string) => {
  const value = metadata[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

const metadataCount = (metadata: Record<string, unknown>, key: string) => {
  const value = metadata[key]
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

const searchWhereClause = (filters: CodeSearchFilters) => {
  const conditions: Array<ReturnType<typeof sql>> = [
    sql`repositories.metadata->>'indexStatus' = 'ready'`,
    sql`file_versions.repository_ref = repositories.default_ref`,
    sql`file_versions.repository_commit = repositories.metadata->>'indexedCommit'`,
  ]
  if (filters.repository) conditions.push(sql`repositories.name = ${filters.repository}`)
  if (filters.ref) conditions.push(sql`file_versions.repository_ref = ${filters.ref}`)
  if (filters.pathPrefix) {
    conditions.push(sql`file_keys.path LIKE ${`${escapeLikePattern(filters.pathPrefix)}%`} ESCAPE '\'`)
  }
  if (filters.language) conditions.push(sql`file_versions.language = ${filters.language}`)
  return sql`WHERE ${sql.join(conditions, sql` AND `)}`
}

const toIso = (value: Date | string) => (value instanceof Date ? value.toISOString() : String(value))

const rowToMatch = (
  row: AtlasCodeSearchRow,
  score: number,
  exactRank: number | null,
  semanticDistance: number | null,
  lexicalRank: number | null,
  matchedIdentifiers: string[],
  retrievalMode: AtlasCodeSearchMatch['retrievalMode'],
): AtlasCodeSearchMatch => ({
  repository: {
    id: row.repository_id,
    name: row.repository_name,
    defaultRef: row.repository_default_ref,
    metadata: row.repository_metadata ?? {},
    createdAt: toIso(row.repository_created_at),
    updatedAt: toIso(row.repository_updated_at),
  },
  fileKey: {
    id: row.file_key_id,
    repositoryId: row.file_key_repository_id,
    path: row.file_key_path,
    createdAt: toIso(row.file_key_created_at),
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
    createdAt: toIso(row.file_version_created_at),
    updatedAt: toIso(row.file_version_updated_at),
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
    createdAt: toIso(row.chunk_created_at),
  },
  score,
  retrievalMode,
  degradation: null,
  signals: {
    exactRank,
    semanticDistance,
    lexicalRank,
    matchedIdentifiers,
  },
})

const codeSearchSelectColumns = [
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
] as const

const codeSearchRawSelectColumns = codeSearchSelectColumns.join(',\n')

export const createAtlasCodeSearchHandlers = ({
  db,
  ensureSchema,
  loadEmbeddingConfig,
  embedText,
  normalizeText,
}: CreateAtlasCodeSearchHandlersOptions) => {
  const queryEmbeddingCache = new Map<string, { embedding: number[]; expiresAt: number }>()

  const embedCodeSearchQuery = async (query: string, config: EmbeddingConfig) => {
    const cacheTtlMs = parsePositiveIntEnv(
      'ATLAS_CODE_SEARCH_QUERY_EMBEDDING_CACHE_TTL_MS',
      DEFAULT_CODE_SEARCH_QUERY_EMBEDDING_CACHE_TTL_MS,
    )
    const cacheKey = [config.apiBaseUrl, config.model, config.dimension, query].join('\0')
    const now = Date.now()
    const cached = queryEmbeddingCache.get(cacheKey)
    if (cached && cached.expiresAt > now) return cached.embedding

    const embedding = await embedText(buildAtlasQueryInstruction(query), config)
    queryEmbeddingCache.set(cacheKey, { embedding, expiresAt: now + cacheTtlMs })
    return embedding
  }

  const codeSearchHealth = async ({
    repository,
    ref,
    pathPrefix,
    language,
  }: Omit<AtlasCodeSearchInput, 'query' | 'limit'>): Promise<AtlasCodeSearchHealth> => {
    await ensureSchema()

    const embeddingConfig = loadEmbeddingConfig()
    const filters = resolveCodeSearchFilters({ repository, ref, pathPrefix, language })
    let query = db
      .selectFrom('atlas.repositories as repositories')
      .select([
        'repositories.name as repository_name',
        'repositories.default_ref as repository_default_ref',
        'repositories.metadata as repository_metadata',
      ])
    if (filters.repository) query = query.where('repositories.name', '=', filters.repository)
    const rows = await query.orderBy('repositories.name').limit(2).execute()
    const row = rows[0]
    const metadata = asMetadata(row?.repository_metadata)
    const storedStatus = metadataString(metadata, 'indexStatus')
    const indexStatus: AtlasCodeSearchHealth['indexStatus'] =
      storedStatus === 'maintenance' ||
      storedStatus === 'building' ||
      storedStatus === 'ready' ||
      storedStatus === 'failed'
        ? storedStatus
        : 'missing'
    const expectedFiles = metadataCount(metadata, 'expectedFiles')
    const indexedFiles = metadataCount(metadata, 'indexedFiles')
    const chunks = metadataCount(metadata, 'indexedChunks')
    const embedded = metadataCount(metadata, 'embeddedChunks')
    const refMatches = !filters.ref || row?.repository_default_ref === filters.ref
    const configurationMatches =
      metadataString(metadata, 'embeddingModel') === embeddingConfig.model &&
      metadataCount(metadata, 'embeddingDimension') === embeddingConfig.dimension
    const corpusMatches =
      expectedFiles === indexedFiles &&
      metadataCount(metadata, 'missingPaths') === 0 &&
      metadataCount(metadata, 'stalePaths') === 0 &&
      metadataCount(metadata, 'hashMismatches') === 0 &&
      metadataCount(metadata, 'uncoveredLines') === 0 &&
      chunks === embedded &&
      (expectedFiles === 0 || chunks > 0)
    const ready = rows.length === 1 && indexStatus === 'ready' && refMatches && configurationMatches && corpusMatches
    const status: AtlasCodeSearchHealthStatus = ready
      ? 'ok'
      : !row
        ? 'empty'
        : indexStatus === 'failed' || (indexStatus === 'ready' && (!configurationMatches || !corpusMatches))
          ? 'critical'
          : 'degraded'
    const message = ready
      ? 'Atlas is ready at a fully reconciled commit'
      : !row
        ? 'Atlas repository is not indexed'
        : rows.length > 1 && !filters.repository
          ? 'repository is required because multiple Atlas corpora exist'
          : !refMatches
            ? `Atlas indexes only ${row.repository_default_ref}`
            : indexStatus !== 'ready'
              ? `Atlas index is ${indexStatus}`
              : !configurationMatches
                ? 'Atlas embedding configuration does not match the indexed corpus'
                : 'Atlas corpus verification metadata is inconsistent'

    return {
      status,
      checkedAt: new Date().toISOString(),
      model: embeddingConfig.model,
      dimension: embeddingConfig.dimension,
      indexStatus,
      indexedCommit: metadataString(metadata, 'indexedCommit'),
      gitHead: metadataString(metadata, 'gitHead'),
      treeHash: metadataString(metadata, 'treeHash'),
      filters: {
        repository: filters.repository || null,
        ref: filters.ref || null,
        pathPrefix: filters.pathPrefix || null,
        language: filters.language || null,
      },
      corpus: {
        expectedFiles,
        indexedFiles,
        missingPaths: metadataCount(metadata, 'missingPaths'),
        stalePaths: metadataCount(metadata, 'stalePaths'),
        hashMismatches: metadataCount(metadata, 'hashMismatches'),
        uncoveredLines: metadataCount(metadata, 'uncoveredLines'),
        chunks,
        embeddedChunks: embedded,
      },
      lastError: metadataString(metadata, 'lastError'),
      message,
    }
  }

  const codeSearch = async ({
    query,
    limit,
    repository,
    ref,
    pathPrefix,
    language,
  }: AtlasCodeSearchInput): Promise<AtlasCodeSearchMatch[]> => {
    await ensureSchema()

    const resolvedQuery = normalizeText(query, 'query')
    const resolvedLimit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit ?? DEFAULT_SEARCH_LIMIT)))
    const filters = resolveCodeSearchFilters({ repository, ref, pathPrefix, language })
    const health = await codeSearchHealth({ repository, ref, pathPrefix, language })
    if (health.status !== 'ok') throw new Error(`Atlas code search is not ready: ${health.message}`)

    const identifiers = extractIdentifierTokens(resolvedQuery)
    const candidateLimit = Math.min(MAX_SEARCH_LIMIT, Math.max(resolvedLimit * 5, resolvedLimit))
    const semanticCandidateLimit = Math.min(
      MAX_SEARCH_LIMIT,
      Math.max(MIN_SEMANTIC_CANDIDATES, resolvedLimit * SEMANTIC_CANDIDATE_MULTIPLIER),
    )
    const embeddingConfig = loadEmbeddingConfig()
    const embedding = await embedCodeSearchQuery(resolvedQuery, embeddingConfig)
    const vectorString = vectorToPgArray(embedding)
    const containsPattern = `%${escapeLikePattern(resolvedQuery)}%`
    const definitionPattern = buildDefinitionPattern(resolvedQuery)
    const definitionRankClause = definitionPattern
      ? sql`WHEN file_chunks.content ~ ${definitionPattern} THEN 0.98`
      : sql``
    const lexicalQuery = buildLexicalQuery(resolvedQuery)
    const whereClause = searchWhereClause(filters)
    const semanticTimeoutMs = parsePositiveIntEnv(
      'ATLAS_CODE_SEARCH_SEMANTIC_TIMEOUT_MS',
      DEFAULT_CODE_SEARCH_SEMANTIC_TIMEOUT_MS,
    )
    const statementTimeoutMs = parsePositiveIntEnv(
      'ATLAS_CODE_SEARCH_STATEMENT_TIMEOUT_MS',
      Math.min(DEFAULT_CODE_SEARCH_STATEMENT_TIMEOUT_MS, Math.max(250, semanticTimeoutMs - 250)),
      Math.min(MAX_CODE_SEARCH_STATEMENT_TIMEOUT_MS, Math.max(250, semanticTimeoutMs - 250)),
    )

    const { exactRows, lexicalRows, semanticRows } = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true);`.execute(trx)

      const exactResult = await sql<AtlasCodeSearchRow>`
        WITH exact_candidates AS MATERIALIZED (
          SELECT file_chunks.id AS chunk_id
          FROM atlas.file_chunks AS file_chunks
          WHERE file_chunks.content IS NOT NULL
            AND file_chunks.content ILIKE ${containsPattern} ESCAPE '\'

          UNION

          SELECT file_chunks.id AS chunk_id
          FROM atlas.file_keys AS file_keys
          INNER JOIN atlas.file_versions AS file_versions ON file_versions.file_key_id = file_keys.id
          INNER JOIN atlas.file_chunks AS file_chunks ON file_chunks.file_version_id = file_versions.id
          WHERE file_keys.path ILIKE ${containsPattern} ESCAPE '\'
             OR file_keys.path % ${resolvedQuery}::text
        )
        SELECT
          ${sql.raw(codeSearchRawSelectColumns)},
          CASE
            WHEN file_keys.path = ${resolvedQuery} THEN 1.0
            WHEN lower(file_keys.path) = lower(${resolvedQuery}) THEN 0.99
            ${definitionRankClause}
            WHEN file_keys.path ILIKE ${containsPattern} ESCAPE '\' THEN 0.90
            WHEN file_chunks.content ILIKE ${containsPattern} ESCAPE '\' THEN 0.75
            ELSE similarity(file_keys.path, ${resolvedQuery}::text)
          END AS exact_rank
        FROM exact_candidates
        INNER JOIN atlas.file_chunks AS file_chunks ON file_chunks.id = exact_candidates.chunk_id
        INNER JOIN atlas.file_versions AS file_versions ON file_versions.id = file_chunks.file_version_id
        INNER JOIN atlas.file_keys AS file_keys ON file_keys.id = file_versions.file_key_id
        INNER JOIN atlas.repositories AS repositories ON repositories.id = file_keys.repository_id
        ${whereClause}
        ORDER BY exact_rank DESC, file_keys.path, file_chunks.chunk_index
        LIMIT ${candidateLimit};
      `.execute(trx)

      const lexicalResult = await sql<AtlasCodeSearchRow>`
        SELECT
          ${sql.raw(codeSearchRawSelectColumns)},
          ts_rank_cd(file_chunks.text_tsvector, websearch_to_tsquery('simple', ${lexicalQuery}::text)) AS lexical_rank
        FROM atlas.file_chunks AS file_chunks
        INNER JOIN atlas.file_versions AS file_versions ON file_versions.id = file_chunks.file_version_id
        INNER JOIN atlas.file_keys AS file_keys ON file_keys.id = file_versions.file_key_id
        INNER JOIN atlas.repositories AS repositories ON repositories.id = file_keys.repository_id
        ${whereClause}
          AND file_chunks.text_tsvector @@ websearch_to_tsquery('simple', ${lexicalQuery}::text)
        ORDER BY lexical_rank DESC, file_keys.path, file_chunks.chunk_index
        LIMIT ${candidateLimit};
      `.execute(trx)

      await sql`SELECT set_config('hnsw.ef_search', ${String(semanticCandidateLimit)}, true);`.execute(trx)

      const semanticResult = await sql<AtlasCodeSearchRow>`
        SELECT
          ${sql.raw(codeSearchRawSelectColumns)},
          chunk_embeddings.embedding <=> ${vectorString}::vector AS semantic_distance
        FROM atlas.chunk_embeddings AS chunk_embeddings
        INNER JOIN atlas.file_chunks AS file_chunks ON file_chunks.id = chunk_embeddings.chunk_id
        INNER JOIN atlas.file_versions AS file_versions ON file_versions.id = file_chunks.file_version_id
        INNER JOIN atlas.file_keys AS file_keys ON file_keys.id = file_versions.file_key_id
        INNER JOIN atlas.repositories AS repositories ON repositories.id = file_keys.repository_id
        ${whereClause}
          AND chunk_embeddings.model = ${embeddingConfig.model}
          AND chunk_embeddings.dimension = ${embeddingConfig.dimension}
        ORDER BY chunk_embeddings.embedding <=> ${vectorString}::vector
        LIMIT ${semanticCandidateLimit};
      `.execute(trx)

      return {
        exactRows: exactResult.rows as AtlasCodeSearchRow[],
        lexicalRows: lexicalResult.rows as AtlasCodeSearchRow[],
        semanticRows: semanticResult.rows as AtlasCodeSearchRow[],
      }
    })

    type MergedMatch = {
      row: AtlasCodeSearchRow
      score: number
      exactRank: number | null
      lexicalRank: number | null
      semanticDistance: number | null
      modes: Set<'exact' | 'lexical' | 'semantic'>
    }
    const merged = new Map<string, MergedMatch>()
    const addRows = (rows: AtlasCodeSearchRow[], mode: 'exact' | 'lexical' | 'semantic', weight: number) => {
      rows.forEach((row, index) => {
        const entry = merged.get(row.chunk_id) ?? {
          row,
          score: 0,
          exactRank: null,
          lexicalRank: null,
          semanticDistance: null,
          modes: new Set<'exact' | 'lexical' | 'semantic'>(),
        }
        entry.score += weight / (RRF_K + index + 1)
        entry.modes.add(mode)
        if (mode === 'exact') {
          entry.exactRank = Number(row.exact_rank)
          if (Number.isFinite(entry.exactRank)) entry.score += entry.exactRank
        }
        if (mode === 'lexical') entry.lexicalRank = Number(row.lexical_rank)
        if (mode === 'semantic') entry.semanticDistance = Number(row.semantic_distance)
        merged.set(row.chunk_id, entry)
      })
    }
    addRows(exactRows, 'exact', 3)
    addRows(lexicalRows, 'lexical', 2)
    addRows(semanticRows, 'semantic', 1)

    return [...merged.values()]
      .map((entry) => {
        const content = `${entry.row.file_key_path}\n${entry.row.chunk_content ?? ''}`
        const { matched } = countIdentifierMatches(content, identifiers)
        const modes = [...entry.modes]
        const retrievalMode: AtlasCodeSearchMatch['retrievalMode'] = modes.length > 1 ? 'hybrid' : (modes[0] ?? 'exact')
        return rowToMatch(
          entry.row,
          entry.score,
          entry.exactRank,
          entry.semanticDistance,
          entry.lexicalRank,
          matched,
          retrievalMode,
        )
      })
      .sort((left, right) => right.score - left.score || left.fileKey.path.localeCompare(right.fileKey.path))
      .slice(0, resolvedLimit)
  }

  return { codeSearch, codeSearchHealth }
}
