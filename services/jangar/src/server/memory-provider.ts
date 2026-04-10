import { createHash } from 'node:crypto'

import { Pool } from 'pg'

import { resolveEmbeddingConfig } from './memory-config'
import { type KubernetesClient, RESOURCE_MAP } from '~/server/primitives-kube'

type MemoryConnection = {
  dataset: string
  schema: string
  embeddingDimension: number
  connectionString: string
}

type MemoryQueryResult = {
  key: string
  score: number | null
  metadata: Record<string, unknown>
}

type EnvSource = Record<string, string | undefined>

const DEFAULT_EMBEDDING_DIMENSION = 1536
const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding-saigak:0.6b'
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 1024

const globalState = globalThis as typeof globalThis & {
  __jangarMemoryProviderPools?: Map<string, Pool>
}

const asString = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

const readNested = (obj: Record<string, unknown>, path: string[]) => {
  let cursor: unknown = obj
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return cursor ?? null
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

const isHostedOpenAiBaseUrl = (rawBaseUrl: string) => {
  try {
    return new URL(rawBaseUrl).hostname === 'api.openai.com'
  } catch {
    return rawBaseUrl.includes('api.openai.com')
  }
}

const resolveEmbeddingDefaults = (apiBaseUrl: string) => {
  const hosted = isHostedOpenAiBaseUrl(apiBaseUrl)
  return {
    model: hosted ? DEFAULT_OPENAI_EMBEDDING_MODEL : DEFAULT_SELF_HOSTED_EMBEDDING_MODEL,
    dimension: hosted ? DEFAULT_EMBEDDING_DIMENSION : DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION,
  }
}

const loadEmbeddingDimension = (env: EnvSource, fallback: number) => {
  const dimension = Number.parseInt(env.OPENAI_EMBEDDING_DIMENSION ?? String(fallback), 10)
  if (!Number.isFinite(dimension) || dimension <= 0) {
    throw new Error('OPENAI_EMBEDDING_DIMENSION must be a positive integer')
  }
  return dimension
}

const resolveEmbeddingApiBaseUrl = (env: EnvSource) =>
  env.OPENAI_EMBEDDING_API_BASE_URL ?? env.OPENAI_API_BASE_URL ?? env.OPENAI_API_BASE ?? DEFAULT_OPENAI_API_BASE_URL

export const loadEmbeddingConfig = (env: EnvSource = process.env) => resolveEmbeddingConfig(env)

const getPoolCache = () => {
  if (!globalState.__jangarMemoryProviderPools) {
    globalState.__jangarMemoryProviderPools = new Map<string, Pool>()
  }
  return globalState.__jangarMemoryProviderPools
}

const getMemoryPool = (connectionString: string) => {
  const pools = getPoolCache()
  const existing = pools.get(connectionString)
  if (existing) return existing

  const created = new Pool({ connectionString, ssl: { rejectUnauthorized: false } })
  pools.set(connectionString, created)
  return created
}

export const closeMemoryProviderPools = async () => {
  const pools = getPoolCache()
  const activePools = [...pools.values()]
  pools.clear()
  await Promise.all(activePools.map((pool) => pool.end()))
}

const embedText = async (text: string, dimension: number) => {
  const embeddingConfig = resolveEmbeddingConfig(process.env)
  if (!embeddingConfig.hasExplicitBaseUrl && !embeddingConfig.apiKey && embeddingConfig.allowDevFallback) {
    return generateFallbackEmbedding(text, dimension)
  }

  const { apiBaseUrl, apiKey, model, dimension: configuredDimension } = embeddingConfig
  if (embeddingConfig.hosted && !apiKey) {
    throw new Error(
      'missing OPENAI_API_KEY; set it or point OPENAI_EMBEDDING_API_BASE_URL/OPENAI_API_BASE_URL at an OpenAI-compatible endpoint',
    )
  }
  if (configuredDimension !== dimension) {
    const error = new Error(
      `memory embedding dimension mismatch: expected ${dimension} but OPENAI_EMBEDDING_DIMENSION is ${configuredDimension}`,
    )
    if (embeddingConfig.allowDevFallback) {
      console.warn('[jangar] memory provider using fallback embeddings', error.message)
      return generateFallbackEmbedding(text, dimension)
    }
    throw error
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }

  const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, input: text }),
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
      console.warn('[jangar] memory provider using fallback embeddings', error.message)
      return generateFallbackEmbedding(text, dimension)
    }
    throw error
  }
  return embedding
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

  const spec = (readNested(memory, ['spec']) ?? {}) as Record<string, unknown>
  const memoryType = asString(readNested(spec, ['type'])) ?? 'custom'
  if (memoryType !== 'postgres') {
    throw new Error(`memory ${memoryName} uses unsupported type ${memoryType}`)
  }

  const dataset = memoryName
  const schema = 'public'

  const connRef = readNested(spec, ['connection', 'secretRef']) as Record<string, unknown> | null
  const secretName = asString(connRef?.name)
  const secretKey = asString(connRef?.key)
  if (!secretName) {
    throw new Error(`memory ${memoryName} missing spec.connection.secretRef.name`)
  }

  const secret = await kube.get('secret', secretName, namespace)
  if (!secret) {
    throw new Error(`secret ${namespace}/${secretName} not found`)
  }

  const data = (readNested(secret, ['data']) ?? {}) as Record<string, unknown>
  const decodedSecret: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const decoded = decodeBase64(asString(value))
    if (decoded != null) decodedSecret[key] = decoded
  }

  const connectionString = buildConnectionString(decodedSecret, secretKey)
  const embeddingDimension = loadEmbeddingDimension(
    process.env,
    resolveEmbeddingDefaults(resolveEmbeddingApiBaseUrl(process.env)).dimension,
  )

  return { dataset, schema, embeddingDimension, connectionString }
}

export const writeMemoryEvent = async (
  connection: MemoryConnection,
  eventType: string,
  payload: Record<string, unknown>,
) => {
  const pool = getMemoryPool(connection.connectionString)
  await pool.query(
    `INSERT INTO ${connection.schema}.memory_events (dataset, event_type, payload) VALUES ($1, $2, $3)`,
    [connection.dataset, eventType, payload],
  )
}

export const writeMemoryKv = async (connection: MemoryConnection, key: string, value: Record<string, unknown>) => {
  const pool = getMemoryPool(connection.connectionString)
  await pool.query(
    `INSERT INTO ${connection.schema}.memory_kv (dataset, key, value)
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
  await pool.query(
    `INSERT INTO ${connection.schema}.memory_embeddings (dataset, key, embedding, metadata)
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
  const { rows } = await pool.query(
    `SELECT key, metadata, (1 - (embedding <=> $1::vector)) as score
     FROM ${connection.schema}.memory_embeddings
     WHERE dataset = $2
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vector, connection.dataset, limit],
  )
  return rows.map((row: { key: string; score: number | null; metadata: Record<string, unknown> }) => ({
    key: row.key,
    score: row.score,
    metadata: row.metadata ?? {},
  }))
}
