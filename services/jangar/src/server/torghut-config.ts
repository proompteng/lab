import { normalizeTorghutSymbol } from './torghut-symbols'

type EnvSource = Record<string, string | undefined>

export type QuantPolicyConfig = {
  maxDrawdown1d: number
  minSharpe5d: number
  maxSlippageBps15m: number
  maxRejectRate15m: number
  maxPipelineLagSeconds: number
  maxTaFreshnessSeconds: number
  minRouteCoverage15m: number
  maxRouteUnknownRatio15m: number
}

export type TorghutQuantRuntimeConfig = {
  enabled: boolean
  enabledFlagKey: string
  computeIntervalMs: number
  heavyComputeIntervalMs: number
  seriesSamplingMs: number
  streamHeartbeatMs: number
  maxStalenessSeconds: number
  windowsLight: string[]
  windowsHeavy: string[]
  alertsEnabled: boolean
  alertsEnabledFlagKey: string
  policy: QuantPolicyConfig
}

export type TorghutEndpointsConfig = {
  apiBaseUrl: string
  statusUrl: string | null
  marketContextHealthDefaultSymbol: string
  quantHealthMissingUpdateSeconds: number
}

export type TorghutTradingDatabaseConfig = {
  dsn: string | null
  sslMode: string | null
  caCertPath: string | null
}

export type TorghutDecisionEngineConfig = {
  enabled: boolean
  enabledFlagKey: string
  runTimeoutMs: number
  heartbeatMs: number
  retentionMs: number
}

export type TorghutSimulationStorageConfig = {
  cacheBucket: string
  cachePrefix: string
}

const DEFAULT_TORGHUT_API_BASE_URL = 'http://torghut.torghut.svc.cluster.local'
const DEFAULT_QUANT_CONTROL_PLANE_ENABLED_FLAG_KEY = 'jangar.torghut.quant_control_plane.enabled'
const DEFAULT_QUANT_ALERTS_ENABLED_FLAG_KEY = 'jangar.torghut.quant_alerts.enabled'
const DEFAULT_MARKET_CONTEXT_HEALTH_SYMBOL = 'AAPL'
const DEFAULT_QUANT_HEALTH_MISSING_UPDATE_SECONDS = 15

const normalizeNonEmpty = (value: string | undefined | null) => {
  const normalized = value?.trim()
  return normalized && normalized.length > 0 ? normalized : null
}

const parseBoolean = (value: string | undefined, fallback: boolean) => {
  const normalized = normalizeNonEmpty(value)?.toLowerCase()
  if (!normalized) return fallback
  if (['1', 'true', 'yes', 'y', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number.parseInt(normalized, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return Math.floor(parsed)
}

const parseNumber = (value: string | undefined, fallback: number) => {
  const normalized = normalizeNonEmpty(value)
  if (!normalized) return fallback
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : fallback
}

const parseWindowList = (value: string | undefined, fallback: string[]) => {
  const normalized = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return normalized.length > 0 ? normalized : [...fallback]
}

const normalizeUrl = (value: string | undefined, fallback: string) =>
  (normalizeNonEmpty(value) ?? fallback).replace(/\/+$/, '')

export const resolveTorghutQuantRuntimeConfig = (
  env: EnvSource = process.env,
  overrides?: { enabled?: boolean; alertsEnabled?: boolean },
): TorghutQuantRuntimeConfig => ({
  enabled: overrides?.enabled ?? parseBoolean(env.JANGAR_TORGHUT_QUANT_CONTROL_PLANE_ENABLED, false),
  enabledFlagKey:
    normalizeNonEmpty(env.JANGAR_TORGHUT_QUANT_CONTROL_PLANE_ENABLED_FLAG_KEY) ??
    DEFAULT_QUANT_CONTROL_PLANE_ENABLED_FLAG_KEY,
  computeIntervalMs: parsePositiveInt(env.JANGAR_TORGHUT_QUANT_COMPUTE_INTERVAL_MS, 1000),
  heavyComputeIntervalMs: parsePositiveInt(env.JANGAR_TORGHUT_QUANT_HEAVY_COMPUTE_INTERVAL_MS, 30_000),
  seriesSamplingMs: parsePositiveInt(env.JANGAR_TORGHUT_QUANT_SERIES_SAMPLING_MS, 5000),
  streamHeartbeatMs: parsePositiveInt(env.JANGAR_TORGHUT_QUANT_STREAM_HEARTBEAT_MS, 15_000),
  maxStalenessSeconds: parsePositiveInt(env.JANGAR_TORGHUT_QUANT_MAX_STALENESS_SECONDS, 15),
  windowsLight: parseWindowList(env.JANGAR_TORGHUT_QUANT_WINDOWS_LIGHT, ['1m', '5m', '15m', '1h', '1d']),
  windowsHeavy: parseWindowList(env.JANGAR_TORGHUT_QUANT_WINDOWS_HEAVY, ['5d', '20d']),
  alertsEnabled: overrides?.alertsEnabled ?? parseBoolean(env.JANGAR_TORGHUT_QUANT_ALERTS_ENABLED, true),
  alertsEnabledFlagKey:
    normalizeNonEmpty(env.JANGAR_TORGHUT_QUANT_ALERTS_ENABLED_FLAG_KEY) ?? DEFAULT_QUANT_ALERTS_ENABLED_FLAG_KEY,
  policy: {
    maxDrawdown1d: parseNumber(env.JANGAR_TORGHUT_QUANT_POLICY_MAX_DRAWDOWN_1D, 0.05),
    minSharpe5d: parseNumber(env.JANGAR_TORGHUT_QUANT_POLICY_MIN_SHARPE_5D, 0),
    maxSlippageBps15m: parseNumber(env.JANGAR_TORGHUT_QUANT_POLICY_MAX_SLIPPAGE_BPS_15M, 50),
    maxRejectRate15m: parseNumber(env.JANGAR_TORGHUT_QUANT_POLICY_MAX_REJECT_RATE_15M, 0.02),
    maxPipelineLagSeconds: parseNumber(env.JANGAR_TORGHUT_QUANT_POLICY_MAX_PIPELINE_LAG_SECONDS, 15),
    maxTaFreshnessSeconds: parseNumber(env.JANGAR_TORGHUT_QUANT_POLICY_MAX_TA_FRESHNESS_SECONDS, 120),
    minRouteCoverage15m: parseNumber(env.JANGAR_TORGHUT_QUANT_POLICY_MIN_ROUTE_COVERAGE_15M, 0.99),
    maxRouteUnknownRatio15m: parseNumber(env.JANGAR_TORGHUT_QUANT_POLICY_MAX_ROUTE_UNKNOWN_RATIO_15M, 0.02),
  },
})

export const resolveTorghutEndpointsConfig = (env: EnvSource = process.env): TorghutEndpointsConfig => ({
  apiBaseUrl: normalizeUrl(env.TORGHUT_API_BASE_URL, DEFAULT_TORGHUT_API_BASE_URL),
  statusUrl: normalizeNonEmpty(env.JANGAR_TORGHUT_STATUS_URL)?.replace(/\/+$/, '') ?? null,
  marketContextHealthDefaultSymbol: normalizeTorghutSymbol(
    normalizeNonEmpty(env.JANGAR_MARKET_CONTEXT_HEALTH_DEFAULT_SYMBOL) ?? DEFAULT_MARKET_CONTEXT_HEALTH_SYMBOL,
  ),
  quantHealthMissingUpdateSeconds: parsePositiveInt(
    env.JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS,
    DEFAULT_QUANT_HEALTH_MISSING_UPDATE_SECONDS,
  ),
})

export const resolveTorghutTradingDatabaseConfig = (env: EnvSource = process.env): TorghutTradingDatabaseConfig => ({
  dsn: normalizeNonEmpty(env.TORGHUT_DB_DSN),
  sslMode: normalizeNonEmpty(env.TORGHUT_DB_SSLMODE) ?? normalizeNonEmpty(env.TORGHUT_PGSSLMODE),
  caCertPath: normalizeNonEmpty(env.TORGHUT_DB_CA_CERT),
})

export const resolveTorghutDecisionEngineConfig = (env: EnvSource = process.env): TorghutDecisionEngineConfig => ({
  enabled: parseBoolean(env.JANGAR_TORGHUT_DECISION_ENGINE_ENABLED, false),
  enabledFlagKey:
    normalizeNonEmpty(env.JANGAR_TORGHUT_DECISION_ENGINE_ENABLED_FLAG_KEY) ?? 'jangar.torghut.decision_engine.enabled',
  runTimeoutMs: parsePositiveInt(
    env.JANGAR_TORGHUT_DECISION_ENGINE_RUN_TIMEOUT_MS ?? env.JANGAR_TORGHUT_DECISION_RUN_TIMEOUT_MS,
    90_000,
  ),
  heartbeatMs: parsePositiveInt(
    env.JANGAR_TORGHUT_DECISION_ENGINE_HEARTBEAT_MS ?? env.JANGAR_TORGHUT_DECISION_HEARTBEAT_MS,
    5_000,
  ),
  retentionMs: parsePositiveInt(
    env.JANGAR_TORGHUT_DECISION_ENGINE_RETENTION_MS ?? env.JANGAR_TORGHUT_DECISION_RETENTION_MS,
    10 * 60_000,
  ),
})

export const resolveTorghutSimulationStorageConfig = (
  env: EnvSource = process.env,
): TorghutSimulationStorageConfig => ({
  cacheBucket: normalizeNonEmpty(env.TORGHUT_SIM_CACHE_BUCKET) ?? 'argo-workflows',
  cachePrefix: normalizeNonEmpty(env.TORGHUT_SIM_CACHE_PREFIX) ?? 'torghut-simulation-cache',
})

export const validateTorghutConfig = (env: EnvSource = process.env) => {
  const endpoints = resolveTorghutEndpointsConfig(env)
  new URL(endpoints.apiBaseUrl)
  if (endpoints.statusUrl) {
    new URL(endpoints.statusUrl)
  }

  resolveTorghutQuantRuntimeConfig(env)
  resolveTorghutTradingDatabaseConfig(env)
  resolveTorghutDecisionEngineConfig(env)
  resolveTorghutSimulationStorageConfig(env)
}
