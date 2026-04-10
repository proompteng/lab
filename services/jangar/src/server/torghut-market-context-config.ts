type EnvSource = Record<string, string | undefined>

const DEFAULT_MARKET_CONTEXT_ENABLED_FLAG_KEY = 'jangar.market_context.enabled'
const DEFAULT_ALLOWED_SERVICE_ACCOUNT_PREFIX = 'system:serviceaccount:torghut:'

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

const parseStringList = (value: string | undefined, fallback: string[]) => {
  const parsed = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return parsed.length > 0 ? parsed : [...fallback]
}

export type MarketContextRuntimeConfig = {
  requireTechnicalsSourceHealth: boolean
  enabledFallback: boolean
  enabledFlagKey: string
  cacheSeconds: number
  maxStalenessSeconds: number
  providerTimeoutMs: number
  fundamentalsSourceUrl: string
  newsSourceUrl: string
  technicalsMaxFreshnessSeconds: number
  fundamentalsMaxFreshnessSeconds: number
  newsMaxFreshnessSeconds: number
  newsTradingHoursMaxFreshnessSeconds: number
  regimeMaxFreshnessSeconds: number
  batchRequireOpenSession: boolean
  batchTradingStatusUrl: string
  batchTradingStatusTimeoutMs: number
  providerChain: string[]
  providerFailureThreshold: number
  providerCooldownSeconds: number
}

export type MarketContextIngestAuthConfig = {
  sharedIngestToken: string | null
  allowServiceAccountToken: boolean
  allowedServiceAccountPrefixes: string[]
  kubernetesServiceHost: string | null
  kubernetesServicePort: string
}

export const resolveMarketContextRuntimeConfig = (env: EnvSource = process.env): MarketContextRuntimeConfig => ({
  requireTechnicalsSourceHealth: parseBoolean(env.JANGAR_MARKET_CONTEXT_REQUIRE_TECHNICALS_SOURCE_HEALTH, true),
  enabledFallback: parseBoolean(env.JANGAR_MARKET_CONTEXT_ENABLED, true),
  enabledFlagKey:
    normalizeNonEmpty(env.JANGAR_MARKET_CONTEXT_ENABLED_FLAG_KEY) ?? DEFAULT_MARKET_CONTEXT_ENABLED_FLAG_KEY,
  cacheSeconds: parsePositiveInt(env.JANGAR_MARKET_CONTEXT_CACHE_SECONDS, 60),
  maxStalenessSeconds: parsePositiveInt(env.JANGAR_MARKET_CONTEXT_MAX_STALENESS_SECONDS, 300),
  providerTimeoutMs: parsePositiveInt(env.JANGAR_MARKET_CONTEXT_PROVIDER_TIMEOUT_MS, 10_000),
  fundamentalsSourceUrl: normalizeNonEmpty(env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_URL) ?? '',
  newsSourceUrl: normalizeNonEmpty(env.JANGAR_MARKET_CONTEXT_NEWS_URL) ?? '',
  technicalsMaxFreshnessSeconds: parsePositiveInt(env.JANGAR_MARKET_CONTEXT_TECHNICALS_MAX_FRESHNESS_SECONDS, 60),
  fundamentalsMaxFreshnessSeconds: parsePositiveInt(
    env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_MAX_FRESHNESS_SECONDS,
    24 * 60 * 60,
  ),
  newsMaxFreshnessSeconds: parsePositiveInt(env.JANGAR_MARKET_CONTEXT_NEWS_MAX_FRESHNESS_SECONDS, 300),
  newsTradingHoursMaxFreshnessSeconds: parsePositiveInt(
    env.JANGAR_MARKET_CONTEXT_NEWS_TRADING_HOURS_MAX_FRESHNESS_SECONDS,
    600,
  ),
  regimeMaxFreshnessSeconds: parsePositiveInt(env.JANGAR_MARKET_CONTEXT_REGIME_MAX_FRESHNESS_SECONDS, 120),
  batchRequireOpenSession: parseBoolean(env.JANGAR_MARKET_CONTEXT_BATCH_REQUIRE_OPEN_SESSION, true),
  batchTradingStatusUrl:
    normalizeNonEmpty(env.JANGAR_MARKET_CONTEXT_BATCH_TRADING_STATUS_URL) ??
    'http://torghut.torghut.svc.cluster.local/trading/status',
  batchTradingStatusTimeoutMs: parsePositiveInt(env.JANGAR_MARKET_CONTEXT_BATCH_TRADING_STATUS_TIMEOUT_MS, 2_000),
  providerChain: parseStringList(env.JANGAR_MARKET_CONTEXT_PROVIDER_CHAIN, ['codex-spark', 'codex']),
  providerFailureThreshold: parsePositiveInt(env.JANGAR_MARKET_CONTEXT_PROVIDER_FAILURE_THRESHOLD, 3),
  providerCooldownSeconds: parsePositiveInt(env.JANGAR_MARKET_CONTEXT_PROVIDER_COOLDOWN_SECONDS, 900),
})

export const resolveMarketContextIngestAuthConfig = (env: EnvSource = process.env): MarketContextIngestAuthConfig => ({
  sharedIngestToken: normalizeNonEmpty(env.JANGAR_MARKET_CONTEXT_INGEST_TOKEN),
  allowServiceAccountToken: parseBoolean(env.JANGAR_MARKET_CONTEXT_INGEST_ALLOW_SERVICE_ACCOUNT_TOKEN, true),
  allowedServiceAccountPrefixes: parseStringList(env.JANGAR_MARKET_CONTEXT_INGEST_ALLOWED_SERVICE_ACCOUNT_PREFIXES, [
    DEFAULT_ALLOWED_SERVICE_ACCOUNT_PREFIX,
  ]),
  kubernetesServiceHost: normalizeNonEmpty(env.KUBERNETES_SERVICE_HOST),
  kubernetesServicePort: normalizeNonEmpty(env.KUBERNETES_SERVICE_PORT) ?? '443',
})

export const validateMarketContextConfig = (env: EnvSource = process.env) => {
  const runtime = resolveMarketContextRuntimeConfig(env)
  if (runtime.fundamentalsSourceUrl) new URL(runtime.fundamentalsSourceUrl)
  if (runtime.newsSourceUrl) new URL(runtime.newsSourceUrl)
  new URL(runtime.batchTradingStatusUrl)
  resolveMarketContextIngestAuthConfig(env)
}
