type EnvSource = Record<string, string | undefined>

export type MemoryProviderHealthStatus = 'healthy' | 'degraded' | 'blocked'

export type MemoryProviderHealthMode = 'agents-service'

export type MemoryProviderHealth = {
  status: MemoryProviderHealthStatus
  reason: string
  mode: MemoryProviderHealthMode
  fallbackActive: boolean
  config: {
    agentsServiceBaseUrl: string
    clientName: string
  } | null
}

const DEFAULT_AGENTS_SERVICE_BASE_URL = 'http://agents.agents.svc.cluster.local'
const DEFAULT_AGENTS_SERVICE_CLIENT_NAME = 'jangar'

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

export const getMemoryProviderHealth = (env: EnvSource = process.env): MemoryProviderHealth => {
  const agentsServiceBaseUrl = (
    normalizeNonEmpty(env.AGENTS_SERVICE_BASE_URL) ?? DEFAULT_AGENTS_SERVICE_BASE_URL
  ).replace(/\/+$/, '')
  return {
    status: 'healthy',
    reason: 'memory persistence and retrieval are delegated to the Agents service',
    mode: 'agents-service',
    fallbackActive: false,
    config: {
      agentsServiceBaseUrl,
      clientName: normalizeNonEmpty(env.AGENTS_SERVICE_CLIENT_NAME) ?? DEFAULT_AGENTS_SERVICE_CLIENT_NAME,
    },
  }
}

export const MEMORY_PROVIDER_MISSING_API_KEY_MESSAGE =
  'memory persistence and retrieval are delegated to the Agents service; Jangar no longer gates readiness on embedding provider API keys'
