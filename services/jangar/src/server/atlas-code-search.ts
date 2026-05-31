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
  requireSemanticCoverage?: boolean
  minSemanticCoverage?: number
  healthSampleLimit?: number
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

export type AtlasCodeSearchHealthStatus = 'ok' | 'degraded' | 'critical' | 'empty'

export type AtlasCodeSearchHealth = {
  status: AtlasCodeSearchHealthStatus
  checkedAt: string
  model: string
  dimension: number
  filters: {
    repository: string | null
    ref: string | null
    pathPrefix: string | null
    language: string | null
  }
  sample: {
    limit: number
    chunks: number
    embedded: number
    missing: number
    coverage: number
  }
  thresholds: {
    minSemanticCoverage: number
  }
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
const DEFAULT_CODE_SEARCH_SEMANTIC_TIMEOUT_MS = 12_000
const DEFAULT_CODE_SEARCH_QUERY_EMBEDDING_CACHE_TTL_MS = 60_000
const DEFAULT_CODE_SEARCH_SEMANTIC_CANDIDATE_LIMIT = 100
const DEFAULT_CODE_SEARCH_SEMANTIC_CANDIDATE_LIMIT_CAP = 500
const DEFAULT_CODE_SEARCH_SEMANTIC_CANDIDATE_MULTIPLIER = 20
const MAX_CODE_SEARCH_SEMANTIC_CANDIDATE_LIMIT = 50_000
const DEFAULT_CODE_SEARCH_HEALTH_SAMPLE_LIMIT = 500
const MAX_CODE_SEARCH_HEALTH_SAMPLE_LIMIT = 5_000
const DEFAULT_MIN_SEMANTIC_COVERAGE = 0.95

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

const isSingleExactCodeIdentifierQuery = (query: string, identifiers: string[]) => {
  if (identifiers.length !== 1) return false
  const identifier = identifiers[0]
  if (!identifier || query.trim() !== identifier) return false
  return /^[A-Za-z0-9_$./:-]+$/.test(identifier)
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

const normalizeCoverageThreshold = (value: number | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MIN_SEMANTIC_COVERAGE
  return Math.max(0, Math.min(1, value))
}

const normalizeHealthSampleLimit = (value: number | undefined) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CODE_SEARCH_HEALTH_SAMPLE_LIMIT
  return Math.max(1, Math.min(MAX_CODE_SEARCH_HEALTH_SAMPLE_LIMIT, Math.floor(value)))
}

const resolveSemanticCandidateLimit = (resultLimit: number) => {
  const fallback = Math.min(
    DEFAULT_CODE_SEARCH_SEMANTIC_CANDIDATE_LIMIT_CAP,
    Math.max(
      DEFAULT_CODE_SEARCH_SEMANTIC_CANDIDATE_LIMIT,
      resultLimit * DEFAULT_CODE_SEARCH_SEMANTIC_CANDIDATE_MULTIPLIER,
    ),
  )
  return parsePositiveIntEnv(
    'ATLAS_CODE_SEARCH_SEMANTIC_CANDIDATE_LIMIT',
    fallback,
    MAX_CODE_SEARCH_SEMANTIC_CANDIDATE_LIMIT,
  )
}

const withTimeout = async <T>(input: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      input,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
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

const applyCodeSearchFilters = <T extends { where: (...args: unknown[]) => T }>(
  query: T,
  filters: CodeSearchFilters,
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

const latestFileVersionPredicate = (filters: CodeSearchFilters) => {
  const languageClause = filters.language ? sql`AND newer_file_versions.language = ${filters.language}` : sql``
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM atlas.file_versions AS newer_file_versions
      WHERE newer_file_versions.file_key_id = file_versions.file_key_id
        AND newer_file_versions.repository_ref = file_versions.repository_ref
        ${languageClause}
        AND (
          newer_file_versions.updated_at,
          newer_file_versions.created_at,
          newer_file_versions.id
        ) > (
          file_versions.updated_at,
          file_versions.created_at,
          file_versions.id
        )
    )
  `
}

const applyLatestFileVersionFilter = <T extends { where: (...args: unknown[]) => T }>(
  query: T,
  filters: CodeSearchFilters,
) => query.where(latestFileVersionPredicate(filters))

const toIso = (value: Date | string) => (value instanceof Date ? value.toISOString() : String(value))

const rowToMatch = (
  row: AtlasCodeSearchRow,
  score: number,
  semanticDistance: number | null,
  lexicalRank: number | null,
  matchedIdentifiers: string[],
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
  signals: {
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

const semanticCandidateWhereClause = (filters: CodeSearchFilters) => {
  const conditions: Array<ReturnType<typeof sql>> = [latestFileVersionPredicate(filters)]
  if (filters.repository) {
    conditions.push(sql`repositories.name = ${filters.repository}`)
  }
  if (filters.ref) {
    conditions.push(sql`file_versions.repository_ref = ${filters.ref}`)
  }
  if (filters.pathPrefix) {
    conditions.push(sql`file_keys.path LIKE ${`${filters.pathPrefix}%`}`)
  }
  if (filters.language) {
    conditions.push(sql`file_versions.language = ${filters.language}`)
  }
  return sql`WHERE ${sql.join(conditions, sql` AND `)}`
}

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

    const embedding = await embedText(query, config)
    queryEmbeddingCache.set(cacheKey, { embedding, expiresAt: now + cacheTtlMs })
    return embedding
  }

  const codeSearchHealth = async ({
    repository,
    ref,
    pathPrefix,
    language,
    minSemanticCoverage,
    healthSampleLimit,
  }: Omit<AtlasCodeSearchInput, 'query' | 'limit'>): Promise<AtlasCodeSearchHealth> => {
    await ensureSchema()

    const embeddingConfig = loadEmbeddingConfig()
    const filters = resolveCodeSearchFilters({ repository, ref, pathPrefix, language })
    const sampleLimit = normalizeHealthSampleLimit(healthSampleLimit)
    const coverageThreshold = normalizeCoverageThreshold(minSemanticCoverage)

    let healthQuery = db
      .selectFrom('atlas.file_chunks as file_chunks')
      .innerJoin('atlas.file_versions as file_versions', 'file_versions.id', 'file_chunks.file_version_id')
      .innerJoin('atlas.file_keys as file_keys', 'file_keys.id', 'file_versions.file_key_id')
      .innerJoin('atlas.repositories as repositories', 'repositories.id', 'file_keys.repository_id')
      .leftJoin('atlas.chunk_embeddings as chunk_embeddings', (join) =>
        join
          .onRef('chunk_embeddings.chunk_id', '=', 'file_chunks.id')
          .on('chunk_embeddings.model', '=', embeddingConfig.model)
          .on('chunk_embeddings.dimension', '=', embeddingConfig.dimension),
      )
      .select(['file_chunks.id as chunk_id', 'chunk_embeddings.chunk_id as embedded_chunk_id'])

    healthQuery = applyCodeSearchFilters(healthQuery, filters)
    healthQuery = applyLatestFileVersionFilter(healthQuery, filters)

    const rows = await healthQuery.orderBy('file_chunks.created_at', 'desc').limit(sampleLimit).execute()
    const chunks = rows.length
    const embedded = rows.filter((row) => row.embedded_chunk_id != null).length
    const missing = chunks - embedded
    const coverage = chunks === 0 ? 0 : embedded / chunks
    const status: AtlasCodeSearchHealthStatus =
      chunks === 0 ? 'empty' : coverage >= coverageThreshold ? 'ok' : embedded === 0 ? 'critical' : 'degraded'

    const message =
      status === 'ok'
        ? 'semantic chunk coverage is healthy'
        : status === 'empty'
          ? 'no indexed chunks matched the requested filters'
          : `semantic chunk coverage is below ${coverageThreshold}`

    return {
      status,
      checkedAt: new Date().toISOString(),
      model: embeddingConfig.model,
      dimension: embeddingConfig.dimension,
      filters: {
        repository: filters.repository || null,
        ref: filters.ref || null,
        pathPrefix: filters.pathPrefix || null,
        language: filters.language || null,
      },
      sample: {
        limit: sampleLimit,
        chunks,
        embedded,
        missing,
        coverage,
      },
      thresholds: {
        minSemanticCoverage: coverageThreshold,
      },
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

    const identifiers = extractIdentifierTokens(resolvedQuery)
    const semanticLimit = Math.min(MAX_SEARCH_LIMIT, Math.max(resolvedLimit * 5, resolvedLimit))
    const lexicalLimit = Math.min(MAX_SEARCH_LIMIT, Math.max(resolvedLimit * 5, resolvedLimit))

    const lexicalQueryExpr = sql<string>`websearch_to_tsquery('simple', ${resolvedQuery})`
    const lexicalRankExpr = sql<number>`ts_rank_cd(file_chunks.text_tsvector, ${lexicalQueryExpr})`

    let lexicalQuery = db
      .selectFrom('atlas.file_chunks as file_chunks')
      .innerJoin('atlas.file_versions as file_versions', 'file_versions.id', 'file_chunks.file_version_id')
      .innerJoin('atlas.file_keys as file_keys', 'file_keys.id', 'file_versions.file_key_id')
      .innerJoin('atlas.repositories as repositories', 'repositories.id', 'file_keys.repository_id')
      .select([...codeSearchSelectColumns, lexicalRankExpr.as('lexical_rank')])
      .where(sql<boolean>`file_chunks.text_tsvector @@ ${lexicalQueryExpr}`)

    lexicalQuery = applyCodeSearchFilters(lexicalQuery, filters)
    lexicalQuery = applyLatestFileVersionFilter(lexicalQuery, filters)

    const lexicalRows = (await lexicalQuery
      .orderBy(lexicalRankExpr, 'desc')
      .limit(lexicalLimit)
      .execute()) as AtlasCodeSearchRow[]

    const shouldSkipSemantic = lexicalRows.length > 0 && isSingleExactCodeIdentifierQuery(resolvedQuery, identifiers)

    const semanticRows: AtlasCodeSearchRow[] = shouldSkipSemantic
      ? []
      : await (async () => {
          const semanticTimeoutMs = parsePositiveIntEnv(
            'ATLAS_CODE_SEARCH_SEMANTIC_TIMEOUT_MS',
            DEFAULT_CODE_SEARCH_SEMANTIC_TIMEOUT_MS,
          )
          try {
            return await withTimeout(
              (async () => {
                const embeddingConfig = loadEmbeddingConfig()
                const embedding = await embedCodeSearchQuery(resolvedQuery, embeddingConfig)
                const vectorString = vectorToPgArray(embedding)
                const semanticDistanceExpr = sql<number>`chunk_embeddings.embedding <=> ${vectorString}::vector`

                const semanticCandidateLimit = resolveSemanticCandidateLimit(resolvedLimit)
                const whereClause = semanticCandidateWhereClause(filters)
                const { rows } = await sql<AtlasCodeSearchRow>`
                  WITH candidate_chunks AS MATERIALIZED (
                    SELECT ${sql.raw(codeSearchRawSelectColumns)}
                    FROM atlas.file_chunks AS file_chunks
                    INNER JOIN atlas.file_versions AS file_versions
                      ON file_versions.id = file_chunks.file_version_id
                    INNER JOIN atlas.file_keys AS file_keys
                      ON file_keys.id = file_versions.file_key_id
                    INNER JOIN atlas.repositories AS repositories
                      ON repositories.id = file_keys.repository_id
                    ${whereClause}
                    ORDER BY file_chunks.created_at DESC
                    LIMIT ${semanticCandidateLimit}
                  )
                  SELECT
                    candidate_chunks.*,
                    ${semanticDistanceExpr} AS semantic_distance
                  FROM candidate_chunks
                  INNER JOIN atlas.chunk_embeddings AS chunk_embeddings
                    ON chunk_embeddings.chunk_id = candidate_chunks.chunk_id
                   AND chunk_embeddings.model = ${embeddingConfig.model}
                   AND chunk_embeddings.dimension = ${embeddingConfig.dimension}
                  ORDER BY semantic_distance
                  LIMIT ${semanticLimit};
                `.execute(db)

                return rows as AtlasCodeSearchRow[]
              })(),
              semanticTimeoutMs,
              `semantic code search timed out after ${semanticTimeoutMs}ms`,
            )
          } catch (error) {
            console.warn('[atlas] semantic code search unavailable; falling back to lexical only', {
              error: error instanceof Error ? error.message : String(error),
            })
            return []
          }
        })()

    const merged = new Map<
      string,
      {
        row: AtlasCodeSearchRow
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
      const semanticScore = semanticDistance === null ? 0 : 1 / (1 + Math.max(0, semanticDistance))
      const lexicalScore = lexicalRank === null ? 0 : Math.max(0, lexicalRank)
      const identifierBoost = matched.length > 0 ? 1 + Math.min(0.5, matched.length * 0.1) : 0

      results.push(
        rowToMatch(row, semanticScore + lexicalScore + identifierBoost, semanticDistance, lexicalRank, matched),
      )
    }

    return results.sort((a, b) => b.score - a.score).slice(0, resolvedLimit)
  }

  return { codeSearch, codeSearchHealth }
}
