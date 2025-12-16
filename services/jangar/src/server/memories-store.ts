import { SQL } from 'bun'

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
  close: () => Promise<void>
}

type PostgresMemoriesStoreOptions = {
  url?: string
}

const DEFAULT_NAMESPACE = 'default'
const DEFAULT_LIMIT = 10
const DEFAULT_SSLMODE = 'require'

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

  const sslrootcert = process.env.PGSSLROOTCERT?.trim()
  if (sslrootcert && sslrootcert.length > 0 && !params.get('sslrootcert')) {
    params.set('sslrootcert', sslrootcert)
  }

  url.search = params.toString()
  return url.toString()
}

const requireEnv = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`missing ${name}`)
  return value
}

const vectorToPgArray = (values: number[]) => `[${values.join(',')}]`

const loadEmbeddingDimension = () => {
  const dimension = Number.parseInt(process.env.OPENAI_EMBEDDING_DIMENSION ?? '1536', 10)
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

const loadEmbeddingConfig = () => {
  const apiKey = requireEnv('OPENAI_API_KEY')
  const apiBaseUrl = process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1'
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small'
  const dimension = loadEmbeddingDimension()
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
    const response = await fetch(`${apiBaseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
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

  const db = new SQL(withDefaultSslMode(url))
  let schemaReady: Promise<void> | null = null
  const expectedEmbeddingDimension = loadEmbeddingDimension()

  const ensureEmbeddingDimensionMatches = async () => {
    const rows = await db.unsafe<Array<{ embedding_type: string | null }>>(
      `
        SELECT pg_catalog.format_type(a.atttypid, a.atttypmod) AS embedding_type
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname = $2
          AND a.attname = 'embedding'
          AND a.attnum > 0
          AND NOT a.attisdropped;
      `,
      [SCHEMA, TABLE],
    )

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
          await db.unsafe('CREATE SCHEMA IF NOT EXISTS memories;')
          await db.unsafe('CREATE EXTENSION IF NOT EXISTS vector;')
          await db.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto;')
        } catch (error) {
          throw new Error(
            `failed to ensure Postgres prerequisites (pgvector/pgcrypto). Ensure the Postgres cluster uses a pgvector-enabled image and has CREATE EXTENSION permissions. Original error: ${String(
              error,
            )}`,
          )
        }

        await db.unsafe(`
          CREATE TABLE IF NOT EXISTS ${SCHEMA}.${TABLE} (
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
            embedding vector(${expectedEmbeddingDimension}) NOT NULL,
            encoder_model TEXT NOT NULL,
            encoder_version TEXT,
            last_accessed_at TIMESTAMPTZ,
            next_review_at TIMESTAMPTZ
          );
        `)

        await ensureEmbeddingDimensionMatches()

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS memories_entries_task_name_idx
          ON ${SCHEMA}.${TABLE} (task_name);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS memories_entries_tags_idx
          ON ${SCHEMA}.${TABLE} USING GIN (tags);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS memories_entries_metadata_idx
          ON ${SCHEMA}.${TABLE} USING GIN (metadata JSONB_PATH_OPS);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS memories_entries_encoder_idx
          ON ${SCHEMA}.${TABLE} (encoder_model, encoder_version);
        `)

        await db.unsafe(`
          CREATE INDEX IF NOT EXISTS memories_entries_embedding_idx
          ON ${SCHEMA}.${TABLE}
          USING ivfflat (embedding vector_cosine_ops)
          WITH (lists = 100);
        `)
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

    const embedding = await embedText(resolvedSummary ? `${resolvedSummary}\n\n${resolvedContent}` : resolvedContent)
    const vectorString = vectorToPgArray(embedding)
    const encoderModel = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small'
    const derivedSummary = resolvedSummary ?? resolvedContent.slice(0, 300)
    const metadata = JSON.stringify({ namespace: resolvedNamespace })
    const source = 'jangar.mcp'

    const rows = await db.unsafe<
      Array<{
        id: string
        task_name: string
        content: string
        summary: string
        tags: string[]
        created_at: string | Date
      }>
    >(
      `
        INSERT INTO ${SCHEMA}.${TABLE} (task_name, content, summary, tags, metadata, source, embedding, encoder_model)
        VALUES ($1, $2, $3, $4::text[], $5::jsonb, $6, $7::vector, $8)
        RETURNING id, task_name, content, summary, tags, created_at;
      `,
      [
        resolvedNamespace,
        resolvedContent,
        derivedSummary,
        db.array(resolvedTags),
        metadata,
        source,
        vectorString,
        encoderModel,
      ],
    )

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

    const embedding = await embedText(resolvedQuery)
    const vectorString = vectorToPgArray(embedding)

    const rows = await db.unsafe<
      Array<{
        id: string
        task_name: string
        content: string
        summary: string
        tags: string[]
        created_at: string | Date
        distance: number
      }>
    >(
      `
        SELECT
          id,
          task_name,
          content,
          summary,
          tags,
          created_at,
          embedding <=> $2::vector AS distance
        FROM ${SCHEMA}.${TABLE}
        WHERE task_name = $1
        ORDER BY distance ASC
        LIMIT $3;
      `,
      [resolvedNamespace, vectorString, resolvedLimit],
    )

    const ids = rows.map((row) => row.id)
    if (ids.length > 0) {
      await db.unsafe(
        `UPDATE ${SCHEMA}.${TABLE} SET last_accessed_at = now(), updated_at = now() WHERE id = ANY($1::uuid[])`,
        [db.array(ids)],
      )
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
    await db.close()
  }

  return { persist, retrieve, close }
}
