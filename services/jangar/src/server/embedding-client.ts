import type { EmbeddingConfig } from './memory-config'

type EmbeddingResponseJson = {
  data?: { embedding?: number[] }[]
  embeddings?: unknown
  embedding?: unknown
}

const normalizeEmbeddingMatrix = (raw: unknown): number[][] | null => {
  if (!Array.isArray(raw)) return null
  if (raw.length === 0) return []
  const first = raw[0]
  if (Array.isArray(first)) {
    const matrix = raw as unknown[][]
    for (const row of matrix) {
      if (!Array.isArray(row) || row.some((value) => typeof value !== 'number')) {
        return null
      }
    }
    return matrix as number[][]
  }
  if (raw.some((value) => typeof value !== 'number')) return null
  return [raw as number[]]
}

const isOllamaEmbedBaseUrl = (rawBaseUrl: string) => rawBaseUrl.replace(/\/+$/, '').endsWith('/api')

const toEmbeddingInput = (texts: readonly string[]) => (texts.length === 1 ? texts[0] : Array.from(texts))

export const requestEmbeddings = async (
  texts: readonly string[],
  config: Pick<EmbeddingConfig, 'apiBaseUrl' | 'apiKey' | 'model' | 'dimension' | 'timeoutMs' | 'maxInputChars'>,
): Promise<number[][]> => {
  for (const text of texts) {
    if (text.length > config.maxInputChars) {
      throw new Error(`embedding input too large (${text.length} chars; max ${config.maxInputChars})`)
    }
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`
  }

  const baseUrl = config.apiBaseUrl.replace(/\/+$/, '')
  const isOllamaEmbed = isOllamaEmbedBaseUrl(baseUrl)
  const response = await fetch(`${baseUrl}/${isOllamaEmbed ? 'embed' : 'embeddings'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.model,
      input: toEmbeddingInput(texts),
      dimensions: config.dimension,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`embedding request failed (${response.status}): ${body}`)
  }

  const json = (await response.json()) as EmbeddingResponseJson
  const rawEmbeddings = isOllamaEmbed ? (json.embeddings ?? json.embedding) : json.data?.map((entry) => entry.embedding)
  const embeddings = normalizeEmbeddingMatrix(rawEmbeddings)
  if (!embeddings) {
    throw new Error('embedding response missing embeddings')
  }
  if (embeddings.length !== texts.length) {
    throw new Error(`embedding response missing embeddings for ${texts.length} inputs`)
  }
  for (const embedding of embeddings) {
    if (embedding.length !== config.dimension) {
      throw new Error(`embedding dimension mismatch: expected ${config.dimension} but got ${embedding.length}`)
    }
  }

  return embeddings
}

export const requestEmbedding = async (
  text: string,
  config: Pick<EmbeddingConfig, 'apiBaseUrl' | 'apiKey' | 'model' | 'dimension' | 'timeoutMs' | 'maxInputChars'>,
): Promise<number[]> => {
  const embeddings = await requestEmbeddings([text], config)
  const embedding = embeddings[0]
  if (!embedding) {
    throw new Error('embedding response missing embeddings')
  }
  return embedding
}
