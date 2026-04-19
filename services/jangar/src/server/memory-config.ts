type EnvSource = Record<string, string | undefined>

const DEFAULT_OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small'
const DEFAULT_OPENAI_EMBEDDING_DIMENSION = 1536
const DEFAULT_SELF_HOSTED_EMBEDDING_MODEL = 'qwen3-embedding-saigak:8b'
const DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION = 4096
const DEFAULT_OPENAI_EMBEDDING_TIMEOUT_MS = 15_000
const DEFAULT_OPENAI_EMBEDDING_MAX_INPUT_CHARS = 60_000
const DEFAULT_MEMORIES_IVFFLAT_PROBES = 10
const MAX_MEMORIES_IVFFLAT_PROBES = 200

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parsePositiveInt = (name: string, value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return Math.floor(parsed)
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
    dimension: hosted ? DEFAULT_OPENAI_EMBEDDING_DIMENSION : DEFAULT_SELF_HOSTED_EMBEDDING_DIMENSION,
  }
}

export type EmbeddingConfig = {
  apiBaseUrl: string
  apiKey: string | null
  model: string
  dimension: number
  timeoutMs: number
  maxInputChars: number
  hosted: boolean
  hasExplicitBaseUrl: boolean
  allowDevFallback: boolean
}

export const resolveEmbeddingConfig = (env: EnvSource = process.env): EmbeddingConfig => {
  const explicitBaseUrl =
    normalizeNonEmpty(env.OPENAI_EMBEDDING_API_BASE_URL) ??
    normalizeNonEmpty(env.OPENAI_API_BASE_URL) ??
    normalizeNonEmpty(env.OPENAI_API_BASE)
  const apiBaseUrl = explicitBaseUrl ?? DEFAULT_OPENAI_API_BASE_URL
  const defaults = resolveEmbeddingDefaults(apiBaseUrl)
  return {
    apiBaseUrl,
    apiKey: normalizeNonEmpty(env.OPENAI_API_KEY),
    model: normalizeNonEmpty(env.OPENAI_EMBEDDING_MODEL) ?? defaults.model,
    dimension: parsePositiveInt('OPENAI_EMBEDDING_DIMENSION', env.OPENAI_EMBEDDING_DIMENSION, defaults.dimension),
    timeoutMs: parsePositiveInt(
      'OPENAI_EMBEDDING_TIMEOUT_MS',
      env.OPENAI_EMBEDDING_TIMEOUT_MS,
      DEFAULT_OPENAI_EMBEDDING_TIMEOUT_MS,
    ),
    maxInputChars: parsePositiveInt(
      'OPENAI_EMBEDDING_MAX_INPUT_CHARS',
      env.OPENAI_EMBEDDING_MAX_INPUT_CHARS,
      DEFAULT_OPENAI_EMBEDDING_MAX_INPUT_CHARS,
    ),
    hosted: isHostedOpenAiBaseUrl(apiBaseUrl),
    hasExplicitBaseUrl: explicitBaseUrl != null,
    allowDevFallback: env.NODE_ENV !== 'production',
  }
}

export const resolveMemoriesIvfflatProbes = (
  env: EnvSource = process.env,
  fallback = DEFAULT_MEMORIES_IVFFLAT_PROBES,
) =>
  Math.min(
    MAX_MEMORIES_IVFFLAT_PROBES,
    parsePositiveInt(
      'JANGAR_MEMORIES_IVFFLAT_PROBES',
      env.JANGAR_MEMORIES_IVFFLAT_PROBES ?? env.MEMORIES_IVFFLAT_PROBES,
      fallback,
    ),
  )

export const validateMemoryConfig = (
  env: EnvSource = process.env,
  options?: { requireApiKeyInProduction?: boolean },
) => {
  const config = resolveEmbeddingConfig(env)
  if ((options?.requireApiKeyInProduction ?? true) && config.hosted && !config.apiKey) {
    throw new Error(
      'missing OPENAI_API_KEY; set it or point OPENAI_EMBEDDING_API_BASE_URL/OPENAI_API_BASE_URL at an OpenAI-compatible endpoint',
    )
  }
  resolveMemoriesIvfflatProbes(env)
}
