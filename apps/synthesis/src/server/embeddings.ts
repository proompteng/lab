import { createHash } from 'node:crypto'

import type { SynthesisFactCheck, SynthesisSourcePost } from './schema'

type EnvSource = Record<string, string | undefined>

const DEFAULT_EMBEDDING_BASE_URL = 'http://saigak.saigak.svc.cluster.local:11434/v1'
const DEFAULT_EMBEDDING_MODEL = 'qwen3-embedding-saigak:8b'
const DEFAULT_EMBEDDING_DIMENSION = 4096
const DEFAULT_EMBEDDING_TIMEOUT_MS = 20_000
const DEFAULT_EMBEDDING_MAX_INPUT_CHARS = 60_000

type EmbeddingResponseJson = {
  data?: { embedding?: number[] }[]
  embeddings?: unknown
  embedding?: unknown
}

export type EmbeddingConfig = {
  apiBaseUrl: string
  apiKey: string | null
  model: string
  dimension: number
  timeoutMs: number
  maxInputChars: number
}

export type SynthesisEmbeddingRecord = {
  model: string
  dimension: number
  inputHash: string
  embedding: number[]
  createdAt: string
}

export type EmbeddingProvider = (input: {
  text: string
  config: EmbeddingConfig
}) => Promise<{ embedding: number[]; model?: string; dimension?: number }>

type EmbeddingTextItem = {
  title: string
  synthesis: string
  takeaways: string[]
  whyValuable: string | null
  topicTags: string[]
  factChecks: SynthesisFactCheck[]
  sourcePosts: SynthesisSourcePost[]
}

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parsePositiveInt = (name: string, value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return Math.floor(parsed)
}

export const resolveSynthesisEmbeddingConfig = (env: EnvSource = process.env): EmbeddingConfig => ({
  apiBaseUrl:
    normalizeNonEmpty(env.SYNTHESIS_EMBEDDING_BASE_URL) ??
    normalizeNonEmpty(env.OPENAI_EMBEDDING_API_BASE_URL) ??
    DEFAULT_EMBEDDING_BASE_URL,
  apiKey: normalizeNonEmpty(env.SYNTHESIS_EMBEDDING_API_KEY) ?? normalizeNonEmpty(env.OPENAI_API_KEY),
  model: normalizeNonEmpty(env.SYNTHESIS_EMBEDDING_MODEL) ?? DEFAULT_EMBEDDING_MODEL,
  dimension: parsePositiveInt(
    'SYNTHESIS_EMBEDDING_DIMENSION',
    env.SYNTHESIS_EMBEDDING_DIMENSION,
    DEFAULT_EMBEDDING_DIMENSION,
  ),
  timeoutMs: parsePositiveInt(
    'SYNTHESIS_EMBEDDING_TIMEOUT_MS',
    env.SYNTHESIS_EMBEDDING_TIMEOUT_MS,
    DEFAULT_EMBEDDING_TIMEOUT_MS,
  ),
  maxInputChars: parsePositiveInt(
    'SYNTHESIS_EMBEDDING_MAX_INPUT_CHARS',
    env.SYNTHESIS_EMBEDDING_MAX_INPUT_CHARS,
    DEFAULT_EMBEDDING_MAX_INPUT_CHARS,
  ),
})

const normalizeEmbeddingMatrix = (raw: unknown): number[][] | null => {
  if (!Array.isArray(raw)) return null
  if (raw.length === 0) return []
  const first = raw[0]
  if (Array.isArray(first)) {
    const matrix = raw as unknown[][]
    for (const row of matrix) {
      if (!Array.isArray(row) || row.some((value) => typeof value !== 'number')) return null
    }
    return matrix as number[][]
  }
  if (raw.some((value) => typeof value !== 'number')) return null
  return [raw as number[]]
}

const isOllamaEmbedBaseUrl = (rawBaseUrl: string) => rawBaseUrl.replace(/\/+$/, '').endsWith('/api')

const requestLocalEmbedding: EmbeddingProvider = async ({ text, config }) => {
  if (text.length > config.maxInputChars) {
    throw new Error(`embedding input too large (${text.length} chars; max ${config.maxInputChars})`)
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`

  const baseUrl = config.apiBaseUrl.replace(/\/+$/, '')
  const isOllamaEmbed = isOllamaEmbedBaseUrl(baseUrl)
  const response = await fetch(`${baseUrl}/${isOllamaEmbed ? 'embed' : 'embeddings'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      input: text,
      dimensions: config.dimension,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`local embedding request failed (${response.status}): ${body}`)
  }

  const json = (await response.json()) as EmbeddingResponseJson
  const rawEmbeddings = isOllamaEmbed ? (json.embeddings ?? json.embedding) : json.data?.map((entry) => entry.embedding)
  const embeddings = normalizeEmbeddingMatrix(rawEmbeddings)
  const embedding = embeddings?.[0]
  if (!embedding) throw new Error('local embedding response missing embedding')
  return { embedding }
}

let testEmbeddingProvider: EmbeddingProvider | null = null

export const setSynthesisEmbeddingProviderForTests = (provider: EmbeddingProvider | null) => {
  testEmbeddingProvider = provider
}

export const buildEmbeddingText = (item: EmbeddingTextItem) =>
  [
    `title: ${item.title}`,
    `synthesis: ${item.synthesis}`,
    `why valuable: ${item.whyValuable ?? ''}`,
    item.takeaways.length ? `takeaways:\n${item.takeaways.map((value) => `- ${value}`).join('\n')}` : '',
    item.topicTags.length ? `tags: ${item.topicTags.join(', ')}` : '',
    item.factChecks.length
      ? `fact checks:\n${item.factChecks
          .map((factCheck) => `- ${factCheck.status}: ${factCheck.claim}. ${factCheck.explanation}`)
          .join('\n')}`
      : '',
    item.sourcePosts.length
      ? `sources:\n${item.sourcePosts
          .map((source) =>
            [
              `- ${source.authorHandle ? `@${source.authorHandle.replace(/^@+/, '')}: ` : ''}${source.observedText}`,
              `  ${source.canonicalUrl}`,
            ].join('\n'),
          )
          .join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .trim()

export const hashEmbeddingInput = (text: string) => createHash('sha256').update(text).digest('hex')

export const createSynthesisEmbedding = async (text: string): Promise<SynthesisEmbeddingRecord> => {
  const config = resolveSynthesisEmbeddingConfig()
  const provider = testEmbeddingProvider ?? requestLocalEmbedding
  const result = await provider({ text, config })
  const embedding = result.embedding
  const dimension = result.dimension ?? embedding.length
  if (dimension !== config.dimension) {
    throw new Error(`embedding dimension mismatch: expected ${config.dimension} but got ${dimension}`)
  }
  if (embedding.length !== config.dimension) {
    throw new Error(`embedding dimension mismatch: expected ${config.dimension} but got ${embedding.length}`)
  }
  if (embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('embedding contains non-finite values')
  }

  return {
    model: result.model ?? config.model,
    dimension: config.dimension,
    inputHash: hashEmbeddingInput(text),
    embedding,
    createdAt: new Date().toISOString(),
  }
}

export const cosineSimilarity = (left: readonly number[], right: readonly number[]) => {
  if (left.length !== right.length || left.length === 0) return -1
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  if (!leftMagnitude || !rightMagnitude) return -1
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))
}
