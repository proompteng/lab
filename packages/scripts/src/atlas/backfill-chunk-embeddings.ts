#!/usr/bin/env bun

import { SQL } from 'bun'

import { fatal } from '../shared/cli'

type Options = {
  apply: boolean
  limit: number
  batchSize: number
  repository?: string
  ref?: string
  pathPrefix?: string
  model?: string
  dimension?: number
  baseUrl?: string
  json: boolean
}

type ChunkRow = {
  id: string
  content: string
  path: string
  repository: string
  ref: string
}

type EmbeddingConfig = {
  apiBaseUrl: string
  apiKey: string | null
  model: string
  dimension: number
  timeoutMs: number
  maxInputChars: number
  hosted: boolean
}

const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding-saigak:8b'
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 4096
const DEFAULT_OPENAI_EMBEDDING_TIMEOUT_MS = 15_000
const DEFAULT_OPENAI_EMBEDDING_MAX_INPUT_CHARS = 60_000

const usage = () =>
  `
Usage:
  bun run atlas:backfill-chunk-embeddings [options]

Options:
      --apply                Write embeddings. Without this, only reports matching chunks.
      --limit <n>            Max chunks to inspect/backfill (default: 100)
      --batch-size <n>       Embedding request batch size (default: 16)
      --repository <name>    Repository filter (e.g. proompteng/lab)
      --ref <ref>            Ref filter (e.g. main)
      --path-prefix <path>   Path prefix filter
      --model <name>         Embedding model override
      --dimension <n>        Embedding dimension override
      --base-url <url>       Embedding API base URL override
      --json                 Print JSON summary
  -h, --help                 Show this help message

Examples:
  bun run atlas:backfill-chunk-embeddings --repository proompteng/lab --path-prefix services/jangar
  bun run atlas:backfill-chunk-embeddings --apply --repository proompteng/lab --path-prefix services/jangar --limit 500
`.trim()

const readValue = (arg: string, argv: string[], index: number) => {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) fatal(`${arg} requires a value`)
  return value
}

const parsePositiveInt = (name: string, raw: string) => {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) fatal(`${name} must be a positive integer`)
  return Math.floor(parsed)
}

const parseArgs = (argv: string[]): Options => {
  const options: Options = {
    apply: false,
    limit: 100,
    batchSize: 16,
    json: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    }

    if (arg === '--apply') {
      options.apply = true
      continue
    }

    if (arg === '--json') {
      options.json = true
      continue
    }

    if (arg === '--limit') {
      options.limit = parsePositiveInt('--limit', readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInt('--limit', arg.slice('--limit='.length))
      continue
    }

    if (arg === '--batch-size') {
      options.batchSize = parsePositiveInt('--batch-size', readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--batch-size=')) {
      options.batchSize = parsePositiveInt('--batch-size', arg.slice('--batch-size='.length))
      continue
    }

    if (arg === '--repository') {
      options.repository = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--repository=')) {
      options.repository = arg.slice('--repository='.length)
      continue
    }

    if (arg === '--ref') {
      options.ref = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--ref=')) {
      options.ref = arg.slice('--ref='.length)
      continue
    }

    if (arg === '--path-prefix') {
      options.pathPrefix = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--path-prefix=')) {
      options.pathPrefix = arg.slice('--path-prefix='.length)
      continue
    }

    if (arg === '--model') {
      options.model = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--model=')) {
      options.model = arg.slice('--model='.length)
      continue
    }

    if (arg === '--dimension') {
      options.dimension = parsePositiveInt('--dimension', readValue(arg, argv, i))
      i += 1
      continue
    }

    if (arg.startsWith('--dimension=')) {
      options.dimension = parsePositiveInt('--dimension', arg.slice('--dimension='.length))
      continue
    }

    if (arg === '--base-url') {
      options.baseUrl = readValue(arg, argv, i)
      i += 1
      continue
    }

    if (arg.startsWith('--base-url=')) {
      options.baseUrl = arg.slice('--base-url='.length)
      continue
    }

    fatal(`Unknown option: ${arg}`)
  }

  return options
}

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const isHostedOpenAiBaseUrl = (rawBaseUrl: string) => {
  try {
    return new URL(rawBaseUrl).hostname === 'api.openai.com'
  } catch {
    return rawBaseUrl.includes('api.openai.com')
  }
}

const isOllamaApiBaseUrl = (rawBaseUrl: string) => {
  try {
    const url = new URL(rawBaseUrl)
    return url.pathname.replace(/\/+$/, '').endsWith('/api')
  } catch {
    return rawBaseUrl.replace(/\/+$/, '').endsWith('/api')
  }
}

const parseEnvPositiveInt = (name: string, fallback: number) => {
  const raw = normalizeNonEmpty(process.env[name])
  if (!raw) return fallback
  return parsePositiveInt(name, raw)
}

const resolveEmbeddingConfig = (options: Options): EmbeddingConfig => {
  const apiBaseUrl =
    normalizeNonEmpty(options.baseUrl) ??
    normalizeNonEmpty(process.env.OPENAI_EMBEDDING_API_BASE_URL) ??
    normalizeNonEmpty(process.env.OPENAI_API_BASE_URL) ??
    normalizeNonEmpty(process.env.OPENAI_API_BASE) ??
    DEFAULT_OPENAI_API_BASE_URL
  const hosted = isHostedOpenAiBaseUrl(apiBaseUrl)
  const model =
    normalizeNonEmpty(options.model) ??
    normalizeNonEmpty(process.env.OPENAI_EMBEDDING_MODEL) ??
    (hosted ? DEFAULT_OPENAI_EMBEDDING_MODEL : DEFAULT_SELF_HOSTED_EMBEDDING_MODEL)
  const dimension =
    options.dimension ??
    parseEnvPositiveInt(
      'OPENAI_EMBEDDING_DIMENSION',
      hosted ? DEFAULT_OPENAI_EMBEDDING_DIMENSION : DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION,
    )

  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
    apiKey: normalizeNonEmpty(process.env.OPENAI_API_KEY),
    model,
    dimension,
    timeoutMs: parseEnvPositiveInt('OPENAI_EMBEDDING_TIMEOUT_MS', DEFAULT_OPENAI_EMBEDDING_TIMEOUT_MS),
    maxInputChars: parseEnvPositiveInt('OPENAI_EMBEDDING_MAX_INPUT_CHARS', DEFAULT_OPENAI_EMBEDDING_MAX_INPUT_CHARS),
    hosted,
  }
}

const withDefaultSslMode = (rawUrl: string) => {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return rawUrl
  }
  if (!url.searchParams.get('sslmode')) {
    url.searchParams.set('sslmode', process.env.PGSSLMODE?.trim() || 'require')
  }
  return url.toString()
}

const vectorToPgArray = (values: number[]) => `[${values.join(',')}]`

const normalizeEmbeddings = (raw: unknown): number[][] | null => {
  if (!Array.isArray(raw)) return null
  if (raw.length === 0) return []
  const first = raw[0]
  if (Array.isArray(first)) {
    if (raw.some((row) => !Array.isArray(row) || row.some((value) => typeof value !== 'number'))) return null
    return raw as number[][]
  }
  if (raw.some((value) => typeof value !== 'number')) return null
  return [raw as number[]]
}

const requestEmbeddings = async (texts: string[], config: EmbeddingConfig): Promise<number[][]> => {
  for (const text of texts) {
    if (text.length > config.maxInputChars) {
      throw new Error(`embedding input too large (${text.length} chars; max ${config.maxInputChars})`)
    }
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`

  const ollama = isOllamaApiBaseUrl(config.apiBaseUrl)
  const url = `${config.apiBaseUrl}/${ollama ? 'embed' : 'embeddings'}`
  const body = ollama
    ? { model: config.model, input: texts, dimensions: config.dimension }
    : { model: config.model, input: texts, dimensions: config.dimension }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  })

  if (!response.ok) {
    throw new Error(`embedding request failed (${response.status}): ${await response.text()}`)
  }

  const json = (await response.json()) as {
    data?: { embedding?: number[] }[]
    embeddings?: unknown
    embedding?: unknown
  }
  const embeddings = normalizeEmbeddings(
    ollama ? (json.embeddings ?? json.embedding) : json.data?.map((row) => row.embedding),
  )
  if (!embeddings || embeddings.length !== texts.length) {
    throw new Error(`embedding response missing embeddings for ${texts.length} inputs`)
  }
  for (const embedding of embeddings) {
    if (embedding.length !== config.dimension) {
      throw new Error(`embedding dimension mismatch: expected ${config.dimension} but got ${embedding.length}`)
    }
  }
  return embeddings
}

const selectMissingChunks = async (db: SQL, options: Options, config: EmbeddingConfig) => {
  const repository = options.repository ?? null
  const ref = options.ref ?? null
  const pathLike = options.pathPrefix ? `${options.pathPrefix}%` : null

  return (await db`
    SELECT
      file_chunks.id,
      file_chunks.content,
      file_keys.path,
      repositories.name AS repository,
      file_versions.repository_ref AS ref
    FROM atlas.file_chunks AS file_chunks
    INNER JOIN atlas.file_versions AS file_versions ON file_versions.id = file_chunks.file_version_id
    INNER JOIN atlas.file_keys AS file_keys ON file_keys.id = file_versions.file_key_id
    INNER JOIN atlas.repositories AS repositories ON repositories.id = file_keys.repository_id
    LEFT JOIN atlas.chunk_embeddings AS chunk_embeddings
      ON chunk_embeddings.chunk_id = file_chunks.id
      AND chunk_embeddings.model = ${config.model}
      AND chunk_embeddings.dimension = ${config.dimension}
    WHERE file_chunks.content IS NOT NULL
      AND chunk_embeddings.chunk_id IS NULL
      AND (${repository}::text IS NULL OR repositories.name = ${repository})
      AND (${ref}::text IS NULL OR file_versions.repository_ref = ${ref})
      AND (${pathLike}::text IS NULL OR file_keys.path LIKE ${pathLike})
      AND file_versions.id IN (
        SELECT ranked.id
        FROM (
          SELECT
            fv.id,
            ROW_NUMBER() OVER (
              PARTITION BY fv.file_key_id, fv.repository_ref
              ORDER BY fv.updated_at DESC, fv.created_at DESC, fv.id DESC
            ) AS latest_rank
          FROM atlas.file_versions AS fv
          INNER JOIN atlas.file_keys AS scoped_file_keys ON scoped_file_keys.id = fv.file_key_id
          INNER JOIN atlas.repositories AS scoped_repositories ON scoped_repositories.id = scoped_file_keys.repository_id
          WHERE (${repository}::text IS NULL OR scoped_repositories.name = ${repository})
            AND (${ref}::text IS NULL OR fv.repository_ref = ${ref})
            AND (${pathLike}::text IS NULL OR scoped_file_keys.path LIKE ${pathLike})
        ) AS ranked
        WHERE ranked.latest_rank = 1
      )
    ORDER BY file_chunks.created_at DESC
    LIMIT ${options.limit};
  `) as ChunkRow[]
}

const markChunks = async (db: SQL, chunkIds: string[], metadata: Record<string, unknown>) => {
  if (chunkIds.length === 0) return
  const patch = JSON.stringify({
    ...metadata,
    embeddingUpdatedAt: new Date().toISOString(),
  })
  await db`
    UPDATE atlas.file_chunks
    SET metadata = COALESCE(metadata, '{}'::jsonb) || ${patch}::jsonb
    WHERE id = ANY(${db.array(chunkIds, 'uuid')});
  `
}

const upsertEmbeddings = async (db: SQL, rows: ChunkRow[], embeddings: number[][], config: EmbeddingConfig) => {
  const chunkIds = rows.map((row) => row.id)
  const vectors = embeddings.map(vectorToPgArray)
  await db`
    INSERT INTO atlas.chunk_embeddings (chunk_id, model, dimension, embedding)
    SELECT
      chunk_id,
      ${config.model},
      ${config.dimension},
      embedding::vector
    FROM UNNEST(
      ${db.array(chunkIds, 'uuid')},
      ${db.array(vectors, 'text')}
    ) AS row(chunk_id, embedding)
    ON CONFLICT (chunk_id) DO UPDATE
    SET model = EXCLUDED.model,
        dimension = EXCLUDED.dimension,
        embedding = EXCLUDED.embedding;
  `
  await markChunks(db, chunkIds, {
    embeddingStatus: 'embedded',
    embeddingFailureReason: null,
    embeddingError: null,
    embeddingModel: config.model,
    embeddingDimension: config.dimension,
  })
}

const main = async () => {
  const options = parseArgs(Bun.argv.slice(2))
  const databaseUrl = normalizeNonEmpty(process.env.DATABASE_URL)
  if (!databaseUrl) fatal('DATABASE_URL is required')

  const config = resolveEmbeddingConfig(options)
  if (options.apply && config.hosted && !config.apiKey) {
    fatal('OPENAI_API_KEY is required for hosted OpenAI embeddings; set OPENAI_EMBEDDING_API_BASE_URL for self-hosted')
  }

  const db = new SQL(withDefaultSslMode(databaseUrl))
  try {
    const rows = await selectMissingChunks(db, options, config)
    if (!options.apply) {
      const payload = {
        ok: true,
        dryRun: true,
        candidates: rows.length,
        model: config.model,
        dimension: config.dimension,
        filters: {
          repository: options.repository ?? null,
          ref: options.ref ?? null,
          pathPrefix: options.pathPrefix ?? null,
        },
        sample: rows.slice(0, 10).map((row) => ({
          repository: row.repository,
          ref: row.ref,
          path: row.path,
          chunkId: row.id,
          contentChars: row.content.length,
        })),
      }
      console.log(options.json ? JSON.stringify(payload) : JSON.stringify(payload, null, 2))
      return
    }

    let embedded = 0
    for (let index = 0; index < rows.length; index += options.batchSize) {
      const batch = rows.slice(index, index + options.batchSize)
      const embeddings = await requestEmbeddings(
        batch.map((row) => row.content),
        config,
      )
      await upsertEmbeddings(db, batch, embeddings, config)
      embedded += batch.length
      console.error(`embedded ${embedded}/${rows.length} chunks`)
    }

    const payload = {
      ok: true,
      dryRun: false,
      candidates: rows.length,
      embedded,
      model: config.model,
      dimension: config.dimension,
    }
    console.log(options.json ? JSON.stringify(payload) : JSON.stringify(payload, null, 2))
  } finally {
    await db.close()
  }
}

await main()
