import { resolveEmbeddingConfig } from './memory-config'

type EnvSource = Record<string, string | undefined>

export type MemoryProviderHealthStatus = 'healthy' | 'degraded' | 'blocked'

export type MemoryProviderHealthMode = 'hosted' | 'self-hosted' | 'development-fallback' | 'invalid'

export type MemoryProviderHealth = {
  status: MemoryProviderHealthStatus
  reason: string
  mode: MemoryProviderHealthMode
  fallbackActive: boolean
  config: {
    apiBaseUrl: string
    model: string
    dimension: number
    timeoutMs: number
    maxInputChars: number
    hosted: boolean
  } | null
}

const MISSING_API_KEY_MESSAGE =
  'missing OPENAI_API_KEY; set it or point OPENAI_EMBEDDING_API_BASE_URL/OPENAI_API_BASE_URL at an OpenAI-compatible endpoint'

export const getMemoryProviderHealth = (env: EnvSource = process.env): MemoryProviderHealth => {
  try {
    const config = resolveEmbeddingConfig(env)
    const summary = {
      apiBaseUrl: config.apiBaseUrl,
      model: config.model,
      dimension: config.dimension,
      timeoutMs: config.timeoutMs,
      maxInputChars: config.maxInputChars,
      hosted: config.hosted,
    }

    if (!config.hasExplicitBaseUrl && !config.apiKey && config.allowDevFallback) {
      return {
        status: 'degraded',
        reason:
          'memory embeddings are running in development fallback mode; configure OPENAI_API_KEY or OPENAI_EMBEDDING_API_BASE_URL for live embeddings',
        mode: 'development-fallback',
        fallbackActive: true,
        config: summary,
      }
    }

    if (config.hosted && !config.apiKey) {
      return {
        status: 'blocked',
        reason: MISSING_API_KEY_MESSAGE,
        mode: 'hosted',
        fallbackActive: false,
        config: summary,
      }
    }

    return {
      status: 'healthy',
      reason: config.hosted
        ? 'memory embeddings configured for the hosted OpenAI endpoint'
        : 'memory embeddings configured for an explicit OpenAI-compatible endpoint',
      mode: config.hosted ? 'hosted' : 'self-hosted',
      fallbackActive: false,
      config: summary,
    }
  } catch (error) {
    return {
      status: 'blocked',
      reason: error instanceof Error ? error.message : 'invalid memory provider configuration',
      mode: 'invalid',
      fallbackActive: false,
      config: null,
    }
  }
}

export const MEMORY_PROVIDER_MISSING_API_KEY_MESSAGE = MISSING_API_KEY_MESSAGE
