import { createHash } from 'node:crypto'

import { Pool } from 'pg'

import { type KubernetesClient, RESOURCE_MAP } from './kube-types'
import { resolveEmbeddingConfig } from './memory-config'
import {
  createMemoryProviderAnnIndexIfReady,
  ensureMemoryProviderSchema,
  qualifyMemoryProviderTable,
  type MemoryProviderQueryable,
} from './memory-provider-schema'
import { asRecord, asString, readNested } from './primitives'

export type MemoryConnection = {
  dataset: string
  schema: string
  embeddingDimension: number
  connectionString: string
}

export type MemoryQueryResult = {
  key: string
  score: number | null
  metadata: Record<string, unknown>
}

type EnvSource = Record<string, string | undefined>

const DEFAULT_MEMORY_DATABASE_POOL_MAX = 2

const globalState = globalThis as typeof globalThis & {
  __agentsMemoryProviderPoolFactory?: (connectionString: string) => MemoryProviderQueryable
  __agentsMemoryProviderPools?: Map<string, Pool>
  __agentsMemoryProviderSchemaReady?: Map<string, Promise<void>>
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = asString(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

const decodeBase64 = (value: string | null) => {
  if (!value) return null
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return null
  }
}

const buildConnectionString = (secret: Record<string, unknown>, preferredKey?: string | null) => {
  if (preferredKey) {
    const preferred = asString(secret[preferredKey])
    if (preferred) return preferred
  }
  const url = asString(secret.url) ?? asString(secret.uri) ?? asString(secret.connectionString)
  if (url) return url
  const endpoint = asString(secret.endpoint) ?? asString(secret.host)
  const database = asString(secret.database) ?? asString(secret.dbname)
  const username = asString(secret.username) ?? asString(secret.user)
  const password = asString(secret.password)

  if (!endpoint || !database || !username || !password) {
    throw new Error('connection secret missing url/endpoint/database/username/password')
  }

  const encodedUser = encodeURIComponent(username)
  const encodedPassword = encodeURIComponent(password)
  return `postgresql://${encodedUser}:${encodedPassword}@${endpoint}/${database}?sslmode=require`
}

const generateFallbackEmbedding = (text: string, dimension: number) => {
  const hash = createHash('sha256').update(text).digest()
  const vector = Array.from({ length: dimension }, () => 0)
  for (let i = 0; i < dimension; i += 1) {
    const idx = i % hash.length
    const value = (hash[idx] ?? 0) / 255
    vector[i] = value * 2 - 1
  }
  return vector
}

export const loadEmbeddingConfig = (env: EnvSource = process.env) => resolveEmbeddingConfig(env)

const getPoolCache = () => {
  if (!globalState.__agentsMemoryProviderPools) {
    globalState.__agentsMemoryProviderPools = new Map<string, Pool>()
  }
  return globalState.__agentsMemoryProviderPools
}

const getMemoryPool = (connectionString: string): MemoryProviderQueryable => {
  const testPoolFactory = globalState.__agentsMemoryProviderPoolFactory
  if (testPoolFactory) return testPoolFactory(connectionString)

  const pools = getPoolCache()
  const existing = pools.get(connectionString)
  if (existing) return existing

  const max = parsePositiveInt(
    process.env.AGENTS_MEMORY_DB_POOL_MAX ?? process.env.AGENTS_DB_POOL_MAX,
    DEFAULT_MEMORY_DATABASE_POOL_MAX,
  )
  const created = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max })
  pools.set(connectionString, created)
  return created
}

const getSchemaReadyCache = () => {
  if (!globalState.__agentsMemoryProviderSchemaReady) {
    globalState.__agentsMemoryProviderSchemaReady = new Map<string, Promise<void>>()
  }
  return globalState.__agentsMemoryProviderSchemaReady
}

const memoryProviderSchemaCacheKey = (connection: MemoryConnection) =>
  `${connection.connectionString}\0${connection.schema}\0${connection.embeddingDimension}`

const ensureProviderSchemaReady = async (connection: MemoryConnection, pool: MemoryProviderQueryable) => {
  const cache = getSchemaReadyCache()
  const key = memoryProviderSchemaCacheKey(connection)
  let ready = cache.get(key)
  if (!ready) {
    ready = ensureMemoryProviderSchema(pool, connection)
    cache.set(key, ready)
  }

  try {
    await ready
  } catch (error) {
    cache.delete(key)
    throw error
  }
}

export const closeMemoryProviderPools = async () => {
  const pools = getPoolCache()
  const activePools = [...pools.values()]
  pools.clear()
  globalState.__agentsMemoryProviderSchemaReady?.clear()
  await Promise.all(activePools.map((pool) => pool.end()))
}

const embedText = async (text: string, dimension: number) => {
  const embeddingConfig = resolveEmbeddingConfig(process.env)
  if (!embeddingConfig.hasExplicitBaseUrl && !embeddingConfig.apiKey && embeddingConfig.allowDevFallback) {
    return generateFallbackEmbedding(text, dimension)
  }

  const { apiBaseUrl, apiKey, model, dimension: configuredDimension, timeoutMs, maxInputChars } = embeddingConfig
  if (embeddingConfig.hosted && !apiKey) {
    throw new Error(
      'missing OPENAI_API_KEY; set it or point OPENAI_EMBEDDING_API_BASE_URL/OPENAI_API_BASE_URL at an OpenAI-compatible endpoint',
    )
  }
  if (text.length > maxInputChars) {
    throw new Error(`embedding input too large (${text.length} chars; max ${maxInputChars})`)
  }
  if (configuredDimension !== dimension) {
    const error = new Error(
      `memory embedding dimension mismatch: expected ${dimension} but OPENAI_EMBEDDING_DIMENSION is ${configuredDimension}`,
    )
    if (embeddingConfig.allowDevFallback) {
      console.warn('[agents] memory provider using fallback embeddings', error.message)
      return generateFallbackEmbedding(text, dimension)
    }
    throw error
  }

  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }

  try {
    const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/embeddings`, {
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
      const error = new Error(`embedding dimension mismatch: expected ${dimension} but got ${embedding.length}`)
      if (embeddingConfig.allowDevFallback) {
        console.warn('[agents] memory provider using fallback embeddings', error.message)
        return generateFallbackEmbedding(text, dimension)
      }
      throw error
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

const vectorToPg = (vector: number[]) => `[${vector.join(',')}]`

export const resolveMemoryConnection = async (
  memoryName: string,
  namespace: string,
  kube: KubernetesClient,
): Promise<MemoryConnection> => {
  const memory = await kube.get(RESOURCE_MAP.Memory, memoryName, namespace)
  if (!memory) {
    throw new Error(`memory ${memoryName} not found in ${namespace}`)
  }

  const spec = asRecord(readNested(memory, ['spec'])) ?? {}
  const memoryType = asString(readNested(spec, ['type'])) ?? 'custom'
  if (memoryType !== 'postgres') {
    throw new Error(`memory ${memoryName} uses unsupported type ${memoryType}`)
  }

  const dataset = memoryName
  const schema = 'public'

  const connRef = asRecord(readNested(spec, ['connection', 'secretRef']))
  const secretName = asString(connRef?.name)
  const secretKey = asString(connRef?.key)
  if (!secretName) {
    throw new Error(`memory ${memoryName} missing spec.connection.secretRef.name`)
  }

  const secret = await kube.get('secret', secretName, namespace)
  if (!secret) {
    throw new Error(`secret ${namespace}/${secretName} not found`)
  }

  const data = asRecord(readNested(secret, ['data'])) ?? {}
  const decodedSecret: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const decoded = decodeBase64(asString(value))
    if (decoded != null) decodedSecret[key] = decoded
  }

  const connectionString = buildConnectionString(decodedSecret, secretKey)
  const embeddingDimension = resolveEmbeddingConfig(process.env).dimension

  return { dataset, schema, embeddingDimension, connectionString }
}

export const writeMemoryEvent = async (
  connection: MemoryConnection,
  eventType: string,
  payload: Record<string, unknown>,
) => {
  const pool = getMemoryPool(connection.connectionString)
  await ensureProviderSchemaReady(connection, pool)
  await pool.query(
    `INSERT INTO ${qualifyMemoryProviderTable(connection.schema, 'memory_events')} (dataset, event_type, payload)
     VALUES ($1, $2, $3)`,
    [connection.dataset, eventType, payload],
  )
}

export const writeMemoryKv = async (connection: MemoryConnection, key: string, value: Record<string, unknown>) => {
  const pool = getMemoryPool(connection.connectionString)
  await ensureProviderSchemaReady(connection, pool)
  await pool.query(
    `INSERT INTO ${qualifyMemoryProviderTable(connection.schema, 'memory_kv')} (dataset, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (dataset, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [connection.dataset, key, value],
  )
}

export const writeMemoryEmbedding = async (
  connection: MemoryConnection,
  key: string,
  text: string,
  metadata: Record<string, unknown> = {},
) => {
  const embedding = await embedText(text, connection.embeddingDimension)
  const vector = vectorToPg(embedding)
  const pool = getMemoryPool(connection.connectionString)
  await ensureProviderSchemaReady(connection, pool)
  await pool.query(
    `INSERT INTO ${qualifyMemoryProviderTable(connection.schema, 'memory_embeddings')} (dataset, key, embedding, metadata)
     VALUES ($1, $2, $3::vector, $4)`,
    [connection.dataset, key, vector, metadata],
  )
}

export const queryMemory = async (
  connection: MemoryConnection,
  query: string,
  limit = 10,
): Promise<MemoryQueryResult[]> => {
  const embedding = await embedText(query, connection.embeddingDimension)
  const vector = vectorToPg(embedding)
  const pool = getMemoryPool(connection.connectionString)
  await ensureProviderSchemaReady(connection, pool)
  const { rows } = await pool.query(
    `SELECT key, metadata, (1 - (embedding <=> $1::vector)) as score
     FROM ${qualifyMemoryProviderTable(connection.schema, 'memory_embeddings')}
     WHERE dataset = $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vector, connection.dataset, limit],
  )
  return rows.map((row) => ({
    key: row.key,
    score: row.score,
    metadata: row.metadata ?? {},
  }))
}

export const createMemoryEmbeddingIndexIfReady = async (connection: MemoryConnection) => {
  const pool = getMemoryPool(connection.connectionString)
  await ensureProviderSchemaReady(connection, pool)
  return createMemoryProviderAnnIndexIfReady(pool, connection)
}

export const __test__ = {
  resetMemoryProviderState: () => {
    delete globalState.__agentsMemoryProviderPoolFactory
    globalState.__agentsMemoryProviderSchemaReady?.clear()
  },
  setMemoryProviderPoolFactory: (factory: (connectionString: string) => MemoryProviderQueryable) => {
    globalState.__agentsMemoryProviderPoolFactory = factory
  },
}
