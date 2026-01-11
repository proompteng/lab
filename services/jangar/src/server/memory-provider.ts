import { createHash } from 'node:crypto'

import { Pool } from 'pg'

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

const DEFAULT_EMBEDDING_DIMENSION = 1536

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

const normalizeSchema = (value: string | null) => (value && value.trim().length > 0 ? value.trim() : null)

const buildConnectionString = (secret: Record<string, unknown>) => {
  const uri = asString(secret.uri)
  if (uri) return uri
  const endpoint = asString(secret.endpoint) ?? asString(secret.host)
  const database = asString(secret.database) ?? asString(secret.dbname)
  const username = asString(secret.username) ?? asString(secret.user)
  const password = asString(secret.password)

  if (!endpoint || !database || !username || !password) {
    throw new Error('connection secret missing endpoint/database/username/password')
  }

  const encodedUser = encodeURIComponent(username)
  const encodedPassword = encodeURIComponent(password)
  return `postgresql://${encodedUser}:${encodedPassword}@${endpoint}/${database}?sslmode=require`
}

const resolveEmbeddingDimension = (memorySpec: Record<string, unknown>) => {
  const embeddings = (memorySpec.embeddings ?? {}) as Record<string, unknown>
  const dimension = Number.parseInt(String(embeddings.dimension ?? DEFAULT_EMBEDDING_DIMENSION), 10)
  return Number.isFinite(dimension) && dimension > 0 ? dimension : DEFAULT_EMBEDDING_DIMENSION
}

const generateFallbackEmbedding = (text: string, dimension: number) => {
  const hash = createHash('sha256').update(text).digest()
  const vector = new Array<number>(dimension)
  for (let i = 0; i < dimension; i += 1) {
    const idx = i % hash.length
    const value = (hash[idx] ?? 0) / 255
    vector[i] = value * 2 - 1
  }
  return vector
}

const embedText = async (text: string, dimension: number) => {
  const apiBaseUrl = process.env.OPENAI_API_BASE_URL ?? process.env.OPENAI_API_BASE
  const apiKey = process.env.OPENAI_API_KEY
  const model = process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small'

  if (!apiBaseUrl || !apiKey) {
    return generateFallbackEmbedding(text, dimension)
  }

  const response = await fetch(`${apiBaseUrl.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
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
    return generateFallbackEmbedding(text, dimension)
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
  const status = (readNested(memory, ['status']) ?? {}) as Record<string, unknown>
  const dataset = asString(readNested(spec, ['dataset', 'name'])) ?? memoryName
  const specSchema = normalizeSchema(asString(readNested(spec, ['dataset', 'schema'])))
  const statusSchema = normalizeSchema(asString(readNested(status, ['schema'])))
  const schema = specSchema ?? statusSchema ?? 'public'

  if (specSchema && statusSchema && specSchema !== statusSchema) {
    throw new Error(`memory schema mismatch: spec=${specSchema} status=${statusSchema}`)
  }

  const connRef = readNested(status, ['connectionSecretRef']) as Record<string, unknown> | null
  const secretName = asString(connRef?.name)
  const secretNamespace = asString(connRef?.namespace) ?? namespace
  if (!secretName) {
    throw new Error(`memory ${memoryName} missing status.connectionSecretRef`)
  }

  const secret = await kube.get('secret', secretName, secretNamespace)
  if (!secret) {
    throw new Error(`secret ${secretNamespace}/${secretName} not found`)
  }

  const data = (readNested(secret, ['data']) ?? {}) as Record<string, unknown>
  const decodedSecret: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    const decoded = decodeBase64(asString(value))
    if (decoded != null) decodedSecret[key] = decoded
  }

  const connectionString = buildConnectionString(decodedSecret)
  const embeddingDimension = resolveEmbeddingDimension(spec)

  return { dataset, schema, embeddingDimension, connectionString }
}

export const writeMemoryEvent = async (
  connection: MemoryConnection,
  eventType: string,
  payload: Record<string, unknown>,
) => {
  const pool = new Pool({ connectionString: connection.connectionString, ssl: { rejectUnauthorized: false } })
  try {
    await pool.query(
      `INSERT INTO ${connection.schema}.memory_events (dataset, event_type, payload) VALUES ($1, $2, $3)`,
      [connection.dataset, eventType, payload],
    )
  } finally {
    await pool.end()
  }
}

export const writeMemoryKv = async (connection: MemoryConnection, key: string, value: Record<string, unknown>) => {
  const pool = new Pool({ connectionString: connection.connectionString, ssl: { rejectUnauthorized: false } })
  try {
    await pool.query(
      `INSERT INTO ${connection.schema}.memory_kv (dataset, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (dataset, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [connection.dataset, key, value],
    )
  } finally {
    await pool.end()
  }
}

export const writeMemoryEmbedding = async (
  connection: MemoryConnection,
  key: string,
  text: string,
  metadata: Record<string, unknown> = {},
) => {
  const embedding = await embedText(text, connection.embeddingDimension)
  const vector = vectorToPg(embedding)
  const pool = new Pool({ connectionString: connection.connectionString, ssl: { rejectUnauthorized: false } })
  try {
    await pool.query(
      `INSERT INTO ${connection.schema}.memory_embeddings (dataset, key, embedding, metadata)
       VALUES ($1, $2, $3::vector, $4)`,
      [connection.dataset, key, vector, metadata],
    )
  } finally {
    await pool.end()
  }
}

export const queryMemory = async (
  connection: MemoryConnection,
  query: string,
  limit = 10,
): Promise<MemoryQueryResult[]> => {
  const embedding = await embedText(query, connection.embeddingDimension)
  const vector = vectorToPg(embedding)
  const pool = new Pool({ connectionString: connection.connectionString, ssl: { rejectUnauthorized: false } })
  try {
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
  } finally {
    await pool.end()
  }
}
