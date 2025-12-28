import { sql } from 'kysely'

import { createKyselyDb, type Db } from '~/server/db'
import { ensureMigrations } from '~/server/kysely-migrations'

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

export type MemoriesStore = {
  persist: (input: PersistMemoryInput) => Promise<MemoryRecord>
  retrieve: (input: RetrieveMemoryInput) => Promise<MemoryRecord[]>
  count: (input?: { namespace?: string }) => Promise<number>
  close: () => Promise<void>
}

type PostgresMemoriesStoreOptions = {
  url?: string
  embedText?: (text: string) => Promise<number[]>
  createDb?: (url: string) => Db
}

const DEFAULT_NAMESPACE = 'default'
const DEFAULT_LIMIT = 10
const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding:0.6b'
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 1024

const SCHEMA = 'memories'
const TABLE = 'entries'

const isHostedOpenAiBaseUrl = (rawBaseUrl: string) => {
  try {
    return new URL(rawBaseUrl).hostname === 'api.openai.com'
  } catch {
    return rawBaseUrl.includes('api.openai.com')
  }
}

const vectorToPgArray = (values: number[]) => `[${values.join(',')}]`

const normalizeMetadata = (value?: Record<string, unknown>) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value
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

const embedText = async (text: string): Promise<number[]> => {
  const { apiKey, apiBaseUrl, model, dimension, timeoutMs, maxInputChars } = loadEmbeddingConfig()
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

export const createPostgresMemoriesStore = (options: PostgresMemoriesStoreOptions = {}): MemoriesStore => {
  const url = options.url ?? process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is required for MCP memories storage')
  }

  const db = (options.createDb ?? createKyselyDb)(url)
  let schemaReady: Promise<void> | null = null
  const defaults = resolveEmbeddingDefaults(
    process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_API_BASE ?? DEFAULT_OPENAI_API_BASE_URL,
  )
  const expectedEmbeddingDimension = loadEmbeddingDimension(defaults.dimension)
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
      })()
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
    const encoderModel = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small'
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

    const resolvedNamespace = (namespace && namespace.trim().length > 0 ? namespace.trim() : DEFAULT_NAMESPACE).slice(
      0,
      200,
    )
    const resolvedQuery = query.trim()
    if (resolvedQuery.length === 0) {
      throw new Error('query is required')
    }

    const resolvedLimit = Math.max(1, Math.min(50, limit ?? DEFAULT_LIMIT))

    const embedding = await embed(resolvedQuery)
    const vectorString = vectorToPgArray(embedding)

    const distanceExpr = sql<number>`embedding <=> ${vectorString}::vector`
    const rows = await db
      .selectFrom('memories.entries')
      .select(['id', 'task_name', 'content', 'summary', 'tags', 'metadata', 'created_at', distanceExpr.as('distance')])
      .where('task_name', '=', resolvedNamespace)
      .orderBy(distanceExpr)
      .limit(resolvedLimit)
      .execute()

    const ids = rows.map((row) => row.id)
    if (ids.length > 0) {
      await db
        .updateTable('memories.entries')
        .set({
          last_accessed_at: sql`now()`,
          updated_at: sql`now()`,
        })
        .where(sql<boolean>`id = ANY(${sql.value(ids)}::uuid[])`)
        .execute()
    }

    return rows.map((row) => ({
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

  return { persist, retrieve, count, close }
}
