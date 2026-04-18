import { sql } from 'kysely'

import { resolveStoreDb, type Db } from '~/server/db'
import { requestEmbedding } from '~/server/embedding-client'
import { ensureMigrations } from '~/server/kysely-migrations'
import { resolveEmbeddingConfig, resolveMemoriesIvfflatProbes } from './memory-config'

export type MemoryRecord = {
  id: string
  namespace: string
  content: string
  summary: string | null
  tags: string[]
  metadata: Record<string, unknown>
  createdAt: string
  distance?: number
}

export type PersistMemoryInput = {
  namespace?: string
  content: string
  summary?: string | null
  tags?: string[]
  metadata?: Record<string, unknown>
}

export type RetrieveMemoryInput = {
  namespace?: string
  query: string
  limit?: number
}

export type MemoriesStatsInput = {
  namespace?: string
  days?: number
  topNamespaces?: number
}

export type MemoriesStats = {
  range: {
    days: number
    from: string
    to: string
  }
  byDay: { day: string; count: number }[]
  topNamespaces: { namespace: string; count: number }[]
}

export type MemoriesStore = {
  persist: (input: PersistMemoryInput) => Promise<MemoryRecord>
  retrieve: (input: RetrieveMemoryInput) => Promise<MemoryRecord[]>
  count: (input?: { namespace?: string }) => Promise<number>
  stats: (input?: MemoriesStatsInput) => Promise<MemoriesStats>
  close: () => Promise<void>
}

type PostgresMemoriesStoreOptions = {
  url?: string
  embedText?: (text: string) => Promise<number[]>
  createDb?: (url: string) => Db
}

const DEFAULT_NAMESPACE = 'default'
const DEFAULT_LIMIT = 10

const DEFAULT_STATS_DAYS = 30
const MAX_STATS_DAYS = 365
const DEFAULT_STATS_TOP_NAMESPACES = 8
const MAX_STATS_TOP_NAMESPACES = 25

const SCHEMA = 'memories'
const TABLE = 'entries'

const DEFAULT_IVFFLAT_PROBES = 10
const RETRIEVE_CANDIDATE_MULTIPLIER = 4
const MAX_RETRIEVE_CANDIDATES = 200
const MAX_RELEVANT_DISTANCE = 0.62
const RELATIVE_RELEVANT_DISTANCE_WINDOW = 0.18
const MAX_LEXICAL_MATCH_DISTANCE = 0.72
const MIN_QUERY_TERM_LENGTH = 3

const vectorToPgArray = (values: number[]) => `[${values.join(',')}]`

const normalizeQueryTerms = (query: string) => {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length >= MIN_QUERY_TERM_LENGTH)
  return Array.from(new Set(terms))
}

const countQueryTermHits = (terms: readonly string[], text: string) => {
  if (terms.length === 0) return 0
  let hits = 0
  for (const term of terms) {
    if (text.includes(term)) hits += 1
  }
  return hits
}

const normalizeMetadata = (value?: Record<string, unknown>) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value
}

const loadIvfflatProbes = (fallback = DEFAULT_IVFFLAT_PROBES) => resolveMemoriesIvfflatProbes(process.env, fallback)

const loadEmbeddingConfig = () => {
  const config = resolveEmbeddingConfig(process.env)
  if (config.hosted && !config.apiKey) {
    throw new Error(
      'missing OPENAI_API_KEY; set it or point OPENAI_API_BASE_URL at an OpenAI-compatible endpoint (e.g. Ollama)',
    )
  }
  return config
}

const embedText = async (text: string): Promise<number[]> => {
  try {
    return await requestEmbedding(text, loadEmbeddingConfig())
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`embedding request timed out after ${loadEmbeddingConfig().timeoutMs}ms`)
    }
    throw error
  }
}

export const createPostgresMemoriesStore = (options: PostgresMemoriesStoreOptions = {}): MemoriesStore => {
  const resolved = resolveStoreDb(options)
  if (!resolved.db) {
    throw new Error('DATABASE_URL is required for MCP memories storage')
  }
  const db = resolved.db
  let schemaReady: Promise<void> | null = null
  const expectedEmbeddingDimension = resolveEmbeddingConfig(process.env).dimension
  const embed = options.embedText ?? embedText

  const ensureEmbeddingDimensionMatches = async () => {
    const { rows } = await sql<{ embedding_type: string | null }>`
      SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS embedding_type
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${SCHEMA}
        AND c.relname = ${TABLE}
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
        `embedding dimension mismatch in Postgres schema: ${SCHEMA}.${TABLE}.embedding is ${embeddingType} but OPENAI_EMBEDDING_DIMENSION is ${expectedEmbeddingDimension}.` +
          ' Update OPENAI_EMBEDDING_DIMENSION (and regenerate embeddings) or migrate the column type to match.',
      )
    }
  }

  const ensureSchema = async () => {
    if (!schemaReady) {
      schemaReady = (async () => {
        await ensureMigrations(db)
        await ensureEmbeddingDimensionMatches()
      })().catch((error) => {
        schemaReady = null
        throw error
      })
    }
    await schemaReady
  }

  const persist: MemoriesStore['persist'] = async ({ namespace, content, summary, tags, metadata }) => {
    await ensureSchema()

    const resolvedNamespace = (namespace && namespace.trim().length > 0 ? namespace.trim() : DEFAULT_NAMESPACE).slice(
      0,
      200,
    )
    const resolvedContent = content.trim()
    if (resolvedContent.length === 0) {
      throw new Error('content is required')
    }

    const resolvedSummary = summary == null ? null : summary.trim()
    const resolvedTags = (tags ?? [])
      .map((tag) => tag.trim())
      .filter((tag) => tag.length > 0)
      .slice(0, 50)

    const embedding = await embed(resolvedSummary ? `${resolvedSummary}\n\n${resolvedContent}` : resolvedContent)
    const vectorString = vectorToPgArray(embedding)
    const encoderModel = resolveEmbeddingConfig(process.env).model
    const derivedSummary = resolvedSummary ?? resolvedContent.slice(0, 300)
    const resolvedMetadata = {
      ...normalizeMetadata(metadata),
      namespace: resolvedNamespace,
    }
    const metadataJson = JSON.stringify(resolvedMetadata)
    const source = 'memories.mcp'

    const row = await db
      .insertInto('memories.entries')
      .values({
        task_name: resolvedNamespace,
        content: resolvedContent,
        summary: derivedSummary,
        tags: sql`${sql.value(resolvedTags)}::text[]`,
        metadata: sql`${metadataJson}::jsonb`,
        source,
        embedding: sql`${vectorString}::vector`,
        encoder_model: encoderModel,
      })
      .returning(['id', 'task_name', 'content', 'summary', 'tags', 'metadata', 'created_at'])
      .executeTakeFirst()

    if (!row) throw new Error('insert failed')

    return {
      id: row.id,
      namespace: row.task_name,
      content: row.content,
      summary: row.summary,
      tags: Array.isArray(row.tags) ? row.tags : [],
      metadata: (row.metadata as Record<string, unknown>) ?? resolvedMetadata,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    }
  }

  const retrieve: MemoriesStore['retrieve'] = async ({ namespace, query, limit }) => {
    await ensureSchema()

    const rawNamespace = typeof namespace === 'string' ? namespace.trim() : ''
    const resolvedNamespace = rawNamespace.length > 0 ? rawNamespace.slice(0, 200) : null
    const resolvedQuery = query.trim()
    if (resolvedQuery.length === 0) {
      throw new Error('query is required')
    }

    const resolvedLimit = Math.max(1, Math.min(50, limit ?? DEFAULT_LIMIT))
    const candidateLimit = Math.min(
      MAX_RETRIEVE_CANDIDATES,
      Math.max(resolvedLimit * RETRIEVE_CANDIDATE_MULTIPLIER, resolvedLimit),
    )
    const queryTerms = normalizeQueryTerms(resolvedQuery)

    const embedding = await embed(resolvedQuery)
    const vectorString = vectorToPgArray(embedding)

    const distanceExpr = sql<number>`embedding <=> ${vectorString}::vector`
    const ivfflatProbes = loadIvfflatProbes()
    const rows = await db.transaction().execute(async (trx) => {
      // pgvector's ivfflat index is approximate; with the default probes=1 it can return too few (or even zero)
      // results for some queries. Set a higher probes value for this retrieval call to improve recall.
      await sql`SET LOCAL ivfflat.probes = ${sql.raw(String(ivfflatProbes))}`.execute(trx)

      const baseQuery = trx
        .selectFrom('memories.entries')
        .select([
          'id',
          'task_name',
          'content',
          'summary',
          'tags',
          'metadata',
          'created_at',
          distanceExpr.as('distance'),
        ])
      const scopedQuery = resolvedNamespace ? baseQuery.where('task_name', '=', resolvedNamespace) : baseQuery
      return await scopedQuery.orderBy(distanceExpr).limit(candidateLimit).execute()
    })

    const bestDistance = rows[0] ? Number(rows[0].distance) : Number.POSITIVE_INFINITY
    const semanticDistanceCeiling = Math.min(MAX_RELEVANT_DISTANCE, bestDistance + RELATIVE_RELEVANT_DISTANCE_WINDOW)
    const relevantRows = rows
      .filter((row) => {
        const distance = Number(row.distance)
        if (!Number.isFinite(distance)) return false
        if (distance <= semanticDistanceCeiling) return true
        if (distance > MAX_LEXICAL_MATCH_DISTANCE || queryTerms.length === 0) return false

        const text =
          `${row.summary ?? ''}\n${row.content}\n${Array.isArray(row.tags) ? row.tags.join(' ') : ''}`.toLowerCase()
        return countQueryTermHits(queryTerms, text) > 0
      })
      .slice(0, resolvedLimit)

    const ids = relevantRows.map((row) => row.id)
    if (ids.length > 0) {
      await db
        .updateTable('memories.entries')
        .set({
          last_accessed_at: sql`now()`,
        })
        .where(sql<boolean>`id = ANY(${sql.value(ids)}::uuid[])`)
        .execute()
    }

    return relevantRows.map((row) => ({
      id: row.id,
      namespace: row.task_name,
      content: row.content,
      summary: row.summary,
      tags: Array.isArray(row.tags) ? row.tags : [],
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      distance: Number(row.distance),
    }))
  }

  const close: MemoriesStore['close'] = async () => {
    await db.destroy()
  }

  const count: MemoriesStore['count'] = async (input = {}) => {
    await ensureSchema()

    const rawNamespace = typeof input.namespace === 'string' ? input.namespace.trim() : ''
    const resolvedNamespace = rawNamespace.length > 0 ? rawNamespace.slice(0, 200) : null

    const baseQuery = db.selectFrom('memories.entries').select(sql<string>`count(*)::bigint`.as('count'))
    const query = resolvedNamespace ? baseQuery.where('task_name', '=', resolvedNamespace) : baseQuery
    const row = await query.executeTakeFirst()

    const raw = row?.count ?? 0
    const parsed = typeof raw === 'bigint' ? Number(raw) : Number.parseInt(String(raw), 10)
    return Number.isFinite(parsed) ? parsed : 0
  }

  const stats: MemoriesStore['stats'] = async (input = {}) => {
    await ensureSchema()

    const rawDays = typeof input.days === 'number' ? input.days : Number.parseInt(String(input.days ?? ''), 10)
    const days = Number.isFinite(rawDays)
      ? Math.max(1, Math.min(MAX_STATS_DAYS, Math.floor(rawDays)))
      : DEFAULT_STATS_DAYS

    const rawTop =
      typeof input.topNamespaces === 'number'
        ? input.topNamespaces
        : Number.parseInt(String(input.topNamespaces ?? ''), 10)
    const topNamespaces = Number.isFinite(rawTop)
      ? Math.max(1, Math.min(MAX_STATS_TOP_NAMESPACES, Math.floor(rawTop)))
      : DEFAULT_STATS_TOP_NAMESPACES

    const rawNamespace = typeof input.namespace === 'string' ? input.namespace.trim() : ''
    const resolvedNamespace = rawNamespace.length > 0 ? rawNamespace.slice(0, 200) : null

    const { rows: byDayRows } = await sql<{ day: string; count: string }>`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
             count(*)::bigint AS count
      FROM memories.entries
      WHERE created_at >= now() - make_interval(days => ${days})
        ${resolvedNamespace ? sql`AND task_name = ${resolvedNamespace}` : sql``}
      GROUP BY 1
      ORDER BY 1;
    `.execute(db)

    const countsByDay = new Map<string, number>()
    for (const row of byDayRows) {
      const day = row.day
      const parsed = Number.parseInt(row.count, 10)
      countsByDay.set(day, Number.isFinite(parsed) ? parsed : 0)
    }

    const toDate = new Date()
    const fromDate = new Date(toDate)
    fromDate.setUTCDate(fromDate.getUTCDate() - (days - 1))
    fromDate.setUTCHours(0, 0, 0, 0)

    const byDay: MemoriesStats['byDay'] = []
    for (let i = 0; i < days; i++) {
      const current = new Date(fromDate)
      current.setUTCDate(fromDate.getUTCDate() + i)
      const day = current.toISOString().slice(0, 10)
      byDay.push({ day, count: countsByDay.get(day) ?? 0 })
    }

    const { rows: namespaceRows } = await sql<{ namespace: string; count: string }>`
      SELECT task_name AS namespace,
             count(*)::bigint AS count
      FROM memories.entries
      WHERE created_at >= now() - make_interval(days => ${days})
        ${resolvedNamespace ? sql`AND task_name = ${resolvedNamespace}` : sql``}
      GROUP BY 1
      ORDER BY count(*) DESC
      LIMIT ${topNamespaces};
    `.execute(db)

    const topNamespacesRows = namespaceRows.map((row) => {
      const parsed = Number.parseInt(row.count, 10)
      return { namespace: row.namespace, count: Number.isFinite(parsed) ? parsed : 0 }
    })

    return {
      range: {
        days,
        from: byDay.at(0)?.day ?? fromDate.toISOString().slice(0, 10),
        to: byDay.at(-1)?.day ?? toDate.toISOString().slice(0, 10),
      },
      byDay,
      topNamespaces: topNamespacesRows,
    }
  }

  return { persist, retrieve, count, stats, close }
}
