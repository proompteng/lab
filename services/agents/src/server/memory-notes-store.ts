import { type Selectable, sql } from 'kysely'

import type {
  AgentsMemoryNoteRecord as MemoryRecord,
  AgentsMemoryNotesStats as MemoriesStats,
  AgentsMemoryNotesStatsInput as MemoriesStatsInput,
  AgentsPersistMemoryNoteInput as PersistMemoryInput,
  AgentsRetrieveMemoryNotesInput as RetrieveMemoryInput,
  AgentsMemoryNoteFilters,
  AgentsRetireMemoryNoteInput,
} from '@proompteng/agent-contracts'

import { resolveStoreDb, type AgentsDatabase, type Db } from './db'
import { requestEmbedding } from './embedding-client'
import { ensureMigrations } from './kysely-migrations'
import { resolveEmbeddingConfig, resolveMemoriesIvfflatProbes } from './memory-config'

export type { MemoriesStats, MemoriesStatsInput, MemoryRecord, PersistMemoryInput, RetrieveMemoryInput }

export type MemoriesStore = {
  persist: (input: PersistMemoryInput) => Promise<MemoryRecord>
  retrieve: (input: RetrieveMemoryInput) => Promise<MemoryRecord[]>
  list: (input: AgentsMemoryNoteFilters) => Promise<MemoryRecord[]>
  retire: (input: AgentsRetireMemoryNoteInput) => Promise<MemoryRecord>
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
const MAX_RELEVANT_DISTANCE = 0.32
const MAX_LEXICAL_MATCH_DISTANCE = 0.72
const MIN_QUERY_TERM_LENGTH = 3
const QUERY_STOP_WORDS = new Set([
  'the',
  'and',
  'but',
  'are',
  'was',
  'were',
  'has',
  'have',
  'can',
  'for',
  'with',
  'from',
  'that',
  'this',
  'what',
  'why',
  'how',
  'does',
  'when',
  'into',
  'must',
  'should',
  'another',
  'gets',
])

const vectorToPgArray = (values: number[]) => `[${values.join(',')}]`

const normalizeQueryTerms = (query: string) => {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length >= MIN_QUERY_TERM_LENGTH && !QUERY_STOP_WORDS.has(term))
  return Array.from(new Set(terms)).slice(0, 64)
}

const countQueryTermHits = (terms: readonly string[], text: string) => {
  if (terms.length === 0) return 0
  let hits = 0
  const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/g))
  for (const term of terms) {
    if (words.has(term)) hits += 1
  }
  return hits
}

const normalizeMetadata = (value?: Record<string, unknown>) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value
}

const noteColumns = [
  'id',
  'task_name',
  'content',
  'summary',
  'tags',
  'metadata',
  'created_at',
  'retired_at',
  'retirement_reason',
  'replacement_id',
] as const
type NoteRow = Pick<Selectable<AgentsDatabase['memories.entries']>, (typeof noteColumns)[number]> & {
  distance?: number
}
const timestamp = (value: Date | string | null) => (value instanceof Date ? value.toISOString() : value)

const memoryRecord = (row: NoteRow): MemoryRecord => ({
  id: row.id,
  namespace: row.task_name,
  content: row.content,
  summary: row.summary,
  tags: row.tags,
  metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {},
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  retiredAt: timestamp(row.retired_at),
  retirementReason: row.retirement_reason,
  replacementId: row.replacement_id,
  ...(row.distance === undefined ? {} : { distance: Number(row.distance) }),
})

const selectNotes = (db: Pick<Db, 'selectFrom'>, input: AgentsMemoryNoteFilters) => {
  let query = db.selectFrom('memories.entries').select(noteColumns)
  if (!input.includeRetired) query = query.where('retired_at', 'is', null)
  if (input.namespace) query = query.where('task_name', '=', input.namespace)
  if (input.repository) query = query.where(sql<string>`metadata->>'repository'`, '=', input.repository)
  if (input.model) query = query.where(sql<string>`metadata->>'noteModel'`, '=', input.model)
  if (input.createdAfter) query = query.where('created_at', '>=', new Date(input.createdAfter))
  if (input.createdBefore) query = query.where('created_at', '<', new Date(input.createdBefore))
  if (input.tags?.length) query = query.where(sql<boolean>`tags @> ${sql.value(input.tags)}::text[]`)
  return query
}

export const rankMemoryNotes = (records: MemoryRecord[], query: string, limit: number) => {
  const terms = normalizeQueryTerms(query)
  return records
    .flatMap((record) => {
      const distance = record.distance ?? Number.POSITIVE_INFINITY
      if (!Number.isFinite(distance)) return []
      const hits = countQueryTermHits(terms, `${record.summary ?? ''}\n${record.content}\n${record.tags.join(' ')}`)
      const coverage = terms.length ? hits / terms.length : 0
      const relevant =
        distance <= MAX_RELEVANT_DISTANCE ||
        (distance <= MAX_LEXICAL_MATCH_DISTANCE &&
          (coverage >= 0.6 || (distance <= 0.55 && hits >= Math.min(2, terms.length) && coverage >= 0.25)))
      return relevant ? [{ record, score: (1 - distance + coverage) / 2 }] : []
    })
    .sort((left, right) => right.score - left.score || right.record.createdAt.localeCompare(left.record.createdAt))
    .slice(0, limit)
    .map(({ record }) => record)
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
    throw new Error('DATABASE_URL is required for Agents memory notes storage')
  }
  const db = resolved.db
  const closeDb = resolved.shared ? async () => undefined : () => db.destroy()
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
    const source = 'agents.memory-notes'

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
      .returning(noteColumns)
      .executeTakeFirst()

    if (!row) throw new Error('insert failed')

    return memoryRecord(row)
  }

  const retrieve: MemoriesStore['retrieve'] = async (input) => {
    await ensureSchema()
    const resolvedQuery = input.query.trim()
    if (resolvedQuery.length === 0) {
      throw new Error('query is required')
    }

    const resolvedLimit = Math.max(1, Math.min(50, input.limit ?? DEFAULT_LIMIT))
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

      const candidates = selectNotes(trx, input).select(distanceExpr.as('distance'))
      const semantic = await candidates.orderBy(distanceExpr).limit(candidateLimit).execute()
      if (queryTerms.length === 0) return semantic
      const vector = sql`to_tsvector('simple', coalesce(summary, '') || ' ' || content)`
      const terms = sql`to_tsquery('simple', ${queryTerms.join(' | ')})`
      const lexical = await candidates
        .where(sql<boolean>`${vector} @@ ${terms}`)
        .orderBy(sql`ts_rank_cd(${vector}, ${terms})`, 'desc')
        .limit(candidateLimit)
        .execute()
      return Array.from(new Map([...semantic, ...lexical].map((row) => [row.id, row])).values())
    })

    const relevantRows = rankMemoryNotes(rows.map(memoryRecord), resolvedQuery, resolvedLimit)

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

    return relevantRows
  }

  const list: MemoriesStore['list'] = async (input) => {
    await ensureSchema()
    const rows = await selectNotes(db, input)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(input.limit ?? DEFAULT_LIMIT)
      .execute()
    return rows.map(memoryRecord)
  }

  const retire: MemoriesStore['retire'] = async (input) => {
    const id = input.id.toLowerCase()
    const replacementId = input.replacementId?.toLowerCase()
    const reason = input.reason
    await ensureSchema()
    return db.transaction().execute(async (trx) => {
      const rows = await trx
        .selectFrom('memories.entries')
        .select(noteColumns)
        .where('id', 'in', replacementId ? [id, replacementId] : [id])
        .orderBy('id')
        .forUpdate()
        .execute()
      const note = rows.find((row) => row.id === id)
      if (!note) throw new Error('Memory note not found.')
      if (note.retired_at !== null) {
        if (note.retirement_reason === reason && note.replacement_id === (replacementId ?? null))
          return memoryRecord(note)
        throw new Error('Memory note is already retired with a different reason or replacement.')
      }
      if (replacementId) {
        const replacement = rows.find((row) => row.id === replacementId)
        if (!replacement || replacement.retired_at !== null || replacementId === id) {
          throw new Error('Replacement must be a different active memory note.')
        }
        if (memoryRecord(note).metadata.repository !== memoryRecord(replacement).metadata.repository) {
          throw new Error('Replacement must belong to the same repository.')
        }
      }
      const updated = await trx
        .updateTable('memories.entries')
        .set({
          retired_at: sql`now()`,
          updated_at: sql`now()`,
          retirement_reason: reason,
          replacement_id: replacementId ?? null,
        })
        .where('id', '=', id)
        .returning(noteColumns)
        .executeTakeFirstOrThrow()
      return memoryRecord(updated)
    })
  }

  const close: MemoriesStore['close'] = async () => {
    await closeDb()
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

  return { persist, retrieve, list, retire, count, stats, close }
}
