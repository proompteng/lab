import { sql } from 'kysely'

import { createKyselyDb, type Db } from './db'

export type MemoryRecord = {
  id: string
  namespace: string
  content: string
  summary: string | null
  tags: string[]
  createdAt: string
  distance?: number
}

export type PersistMemoryInput = {
  namespace?: string
  content: string
  summary?: string | null
  tags?: string[]
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
const DEFAULT_SSLMODE = 'require'
const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding:0.6b'
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 1024

const SCHEMA = 'memories'
const TABLE = 'entries'

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

export const __private = { withDefaultSslMode }

const isHostedOpenAiBaseUrl = (rawBaseUrl: string) => {
  try {
    return new URL(rawBaseUrl).hostname === 'api.openai.com'
  } catch {
    return rawBaseUrl.includes('api.openai.com')
  }
}

const vectorToPgArray = (values: number[]) => `[${values.join(',')}]`

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

  const db = (options.createDb ?? createKyselyDb)(withDefaultSslMode(url))
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
        try {
          await sql`CREATE SCHEMA IF NOT EXISTS memories;`.execute(db)
        } catch (error) {
          throw new Error(`failed to ensure Postgres prerequisites (schema). Original error: ${String(error)}`)
        }

        const { rows: extensionRows } = await sql<{ extname: string }>`
          SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto')
        `.execute(db)
        const installed = new Set(extensionRows.map((row) => row.extname))
        const missing = ['vector', 'pgcrypto'].filter((ext) => !installed.has(ext))
        if (missing.length > 0) {
          throw new Error(
            `missing required Postgres extensions: ${missing.join(', ')}. ` +
              'Install them as a privileged user (e.g. `CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;`) ' +
              'or configure CNPG bootstrap.initdb.postInitApplicationSQL to create them at cluster init.',
          )
        }

        await sql`
          CREATE TABLE IF NOT EXISTS ${sql.raw(`${SCHEMA}.${TABLE}`)} (
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
            embedding vector(${sql.raw(String(expectedEmbeddingDimension))}) NOT NULL,
            encoder_model TEXT NOT NULL,
            encoder_version TEXT,
            last_accessed_at TIMESTAMPTZ,
            next_review_at TIMESTAMPTZ
          );
        `.execute(db)

        await ensureEmbeddingDimensionMatches()

        await sql`
          CREATE INDEX IF NOT EXISTS memories_entries_task_name_idx
          ON ${sql.raw(`${SCHEMA}.${TABLE}`)} (task_name);
        `.execute(db)

        await sql`
          CREATE INDEX IF NOT EXISTS memories_entries_tags_idx
          ON ${sql.raw(`${SCHEMA}.${TABLE}`)} USING GIN (tags);
        `.execute(db)

        await sql`
          CREATE INDEX IF NOT EXISTS memories_entries_metadata_idx
          ON ${sql.raw(`${SCHEMA}.${TABLE}`)} USING GIN (metadata JSONB_PATH_OPS);
        `.execute(db)

        await sql`
          CREATE INDEX IF NOT EXISTS memories_entries_encoder_idx
          ON ${sql.raw(`${SCHEMA}.${TABLE}`)} (encoder_model, encoder_version);
        `.execute(db)

        await sql`
          CREATE INDEX IF NOT EXISTS memories_entries_embedding_idx
          ON ${sql.raw(`${SCHEMA}.${TABLE}`)}
          USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100);
        `.execute(db)
      })()
    }
    await schemaReady
  }

  const persist: MemoriesStore['persist'] = async ({ namespace, content, summary, tags }) => {
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
    const metadata = JSON.stringify({ namespace: resolvedNamespace })
    const source = 'memories.mcp'

    const { rows } = await sql<{
      id: string
      task_name: string
      content: string
      summary: string
      tags: string[]
      created_at: string | Date
    }>`
      INSERT INTO memories.entries (task_name, content, summary, tags, metadata, source, embedding, encoder_model)
      VALUES (
        ${resolvedNamespace},
        ${resolvedContent},
        ${derivedSummary},
        ${resolvedTags}::text[],
        ${metadata}::jsonb,
        ${source},
        ${vectorString}::vector,
        ${encoderModel}
      )
      RETURNING id, task_name, content, summary, tags, created_at;
    `.execute(db)

    const row = rows[0]
    if (!row) throw new Error('insert failed')

    return {
      id: row.id,
      namespace: row.task_name,
      content: row.content,
      summary: row.summary,
      tags: Array.isArray(row.tags) ? row.tags : [],
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

    const { rows } = await sql<{
      id: string
      task_name: string
      content: string
      summary: string
      tags: string[]
      created_at: string | Date
      distance: number
    }>`
      SELECT
        id,
        task_name,
        content,
        summary,
        tags,
        created_at,
        embedding <=> ${vectorString}::vector AS distance
      FROM memories.entries
      WHERE task_name = ${resolvedNamespace}
      ORDER BY distance ASC
      LIMIT ${resolvedLimit};
    `.execute(db)

    const ids = rows.map((row) => row.id)
    if (ids.length > 0) {
      await sql`
        UPDATE memories.entries
        SET last_accessed_at = now(), updated_at = now()
        WHERE id = ANY(${ids}::uuid[])
      `.execute(db)
    }

    return rows.map((row) => ({
      id: row.id,
      namespace: row.task_name,
      content: row.content,
      summary: row.summary,
      tags: Array.isArray(row.tags) ? row.tags : [],
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

    const rows = resolvedNamespace
      ? (
          await sql<{ count: bigint | number | string }>`
            SELECT count(*)::bigint AS count
            FROM memories.entries
            WHERE task_name = ${resolvedNamespace};
          `.execute(db)
        ).rows
      : (
          await sql<{ count: bigint | number | string }>`
            SELECT count(*)::bigint AS count
            FROM memories.entries;
          `.execute(db)
        ).rows

    const raw = rows[0]?.count ?? 0
    const parsed = typeof raw === 'bigint' ? Number(raw) : Number.parseInt(String(raw), 10)
    return Number.isFinite(parsed) ? parsed : 0
  }

  return { persist, retrieve, count, close }
}
