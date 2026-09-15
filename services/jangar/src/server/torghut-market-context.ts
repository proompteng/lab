import { type ClickHouseClient, resolveClickHouseClient } from '~/server/clickhouse'
import { getBooleanFeatureFlag } from '~/server/feature-flags'
import { resolveMarketContextRuntimeConfig } from './torghut-market-context-config'
import { normalizeTorghutSymbol } from '~/server/torghut-symbols'

type MarketContextDomainState = 'ok' | 'stale' | 'missing' | 'error'

type MarketContextCitation = {
  source: string
  publishedAt: string
  url: string | null
}

type MarketContextDomain = {
  domain: 'technicals' | 'regime'
  state: MarketContextDomainState
  asOf: string | null
  freshnessSeconds: number | null
  maxFreshnessSeconds: number
  sourceCount: number
  qualityScore: number
  payload: Record<string, unknown>
  citations: MarketContextCitation[]
  riskFlags: string[]
}

export type TorghutMarketContextBundle = {
  contextVersion: 'torghut.market-context.v1'
  symbol: string
  asOfUtc: string
  freshnessSeconds: number
  qualityScore: number
  sourceCount: number
  riskFlags: string[]
  domains: {
    technicals: MarketContextDomain
    regime: MarketContextDomain
  }
}

type ClickHouseHealthSignal = {
  configured: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  consecutiveFailures: number
  latencyMs: number | null
}

export type TorghutMarketContextHealth = {
  enabled: boolean
  cacheSeconds: number
  maxStalenessSeconds: number
  bundleFreshnessSeconds: number
  bundleQualityScore: number
  providerHealth: []
  ingestionHealth: {
    clickhouse: ClickHouseHealthSignal
  }
  domainHealth: Array<{
    domain: MarketContextDomain['domain']
    state: MarketContextDomainState
    freshnessSeconds: number | null
    maxFreshnessSeconds: number
    qualityScore: number
    riskFlags: string[]
  }>
  overallState: 'ok' | 'degraded' | 'down'
}

export type MarketContextOptions = {
  asOf?: Date
  maxStalenessSeconds?: number
  client?: ClickHouseClient
}

const resolveSettings = () => resolveMarketContextRuntimeConfig(process.env)

const resolveMarketContextEnabled = (params: { settings: ReturnType<typeof resolveSettings> }) =>
  getBooleanFeatureFlag({
    key: params.settings.enabledFlagKey,
    defaultValue: params.settings.enabledFallback,
  })

type CacheEntry = {
  value: TorghutMarketContextBundle
  createdAtMs: number
}

const cache = new Map<string, CacheEntry>()

let clickHouseHealth: ClickHouseHealthSignal = {
  configured: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
  latencyMs: null,
}

const iso = (value: Date) => value.toISOString()

const parseTimestamp = (value: unknown) => {
  if (value instanceof Date) return value
  if (typeof value === 'string') {
    const normalized = value.includes('T') ? value : value.replace(' ', 'T')
    const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`
    const parsed = new Date(withZone)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return null
}

const toNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const qualityFromState = (state: MarketContextDomainState) => {
  if (state === 'ok') return 1
  if (state === 'stale') return 0.5
  return 0
}

const resolveState = (freshnessSeconds: number | null, maxFreshnessSeconds: number): MarketContextDomainState => {
  if (freshnessSeconds === null) return 'missing'
  if (freshnessSeconds > maxFreshnessSeconds) return 'stale'
  return 'ok'
}

const resolveFreshnessSeconds = (now: Date, asOf: Date | null) => {
  if (!asOf) return null
  const seconds = Math.floor((now.getTime() - asOf.getTime()) / 1000)
  return Math.max(0, seconds)
}

const recordClickHouseAttempt = (params: {
  configured: boolean
  success: boolean
  error?: string
  latencyMs: number
}) => {
  const nowIso = new Date().toISOString()
  clickHouseHealth = {
    configured: params.configured,
    lastAttemptAt: nowIso,
    lastSuccessAt: params.success ? nowIso : clickHouseHealth.lastSuccessAt,
    lastError: params.success ? null : (params.error ?? 'clickhouse_unknown_error'),
    consecutiveFailures: params.success ? 0 : clickHouseHealth.consecutiveFailures + 1,
    latencyMs: params.latencyMs,
  }
}

const resolveClickHouse = (client?: ClickHouseClient) => {
  if (client) return { ok: true as const, client }
  return resolveClickHouseClient()
}

const getLatestSignalRow = async (client: ClickHouseClient, symbol: string) => {
  const rows = await client.queryJson<Record<string, unknown>>(
    `
      SELECT
        event_ts,
        coalesce(vwap_session, vwap_w5m) AS vwap,
        rsi14,
        macd,
        macd_signal,
        vol_realized_w60s AS volatility,
        imbalance_spread AS imbalance,
        macd_hist AS trend_strength
      FROM ta_signals
      WHERE symbol = {symbol:String}
      ORDER BY event_ts DESC
      LIMIT 1
    `,
    { symbol },
  )
  return rows[0] ?? null
}

const technicalDomain = (params: {
  now: Date
  row: Record<string, unknown> | null
  maxFreshnessSeconds: number
  sourceError?: string | null
  sourceLatencyMs?: number | null
}): MarketContextDomain => {
  const asOf = parseTimestamp(params.row?.event_ts ?? params.row?.ts)
  const freshnessSeconds = resolveFreshnessSeconds(params.now, asOf)
  const maxFreshnessSeconds = params.maxFreshnessSeconds
  let state = resolveState(freshnessSeconds, maxFreshnessSeconds)
  const sourceCount = params.row ? 1 : 0
  const riskFlags: string[] = []
  if (params.sourceError) {
    state = 'error'
    riskFlags.push('technicals_source_error')
  }
  if (state !== 'ok') riskFlags.push(`technicals_${state}`)
  return {
    domain: 'technicals',
    state,
    asOf: asOf ? iso(asOf) : null,
    freshnessSeconds,
    maxFreshnessSeconds,
    sourceCount,
    qualityScore: qualityFromState(state),
    payload: {
      price: toNumber(params.row?.c ?? params.row?.vwap),
      spread: toNumber(params.row?.spread),
      rsi14: toNumber(params.row?.rsi14 ?? params.row?.rsi),
      macd: toNumber(params.row?.macd),
      macdSignal: toNumber(params.row?.macd_signal),
      volume: toNumber(params.row?.v),
      sourceError: params.sourceError ?? null,
      sourceLatencyMs: params.sourceLatencyMs ?? null,
    },
    citations: [],
    riskFlags,
  }
}

const regimeDomain = (params: {
  now: Date
  row: Record<string, unknown> | null
  maxFreshnessSeconds: number
  sourceError?: string | null
  sourceLatencyMs?: number | null
}): MarketContextDomain => {
  const asOf = parseTimestamp(params.row?.event_ts ?? params.row?.ts)
  const freshnessSeconds = resolveFreshnessSeconds(params.now, asOf)
  const maxFreshnessSeconds = params.maxFreshnessSeconds
  let state = resolveState(freshnessSeconds, maxFreshnessSeconds)
  const riskFlags: string[] = []
  if (params.sourceError) {
    state = 'error'
    riskFlags.push('regime_source_error')
  }
  if (state !== 'ok') riskFlags.push(`regime_${state}`)
  return {
    domain: 'regime',
    state,
    asOf: asOf ? iso(asOf) : null,
    freshnessSeconds,
    maxFreshnessSeconds,
    sourceCount: params.row ? 1 : 0,
    qualityScore: qualityFromState(state),
    payload: {
      volatility: toNumber(params.row?.volatility ?? params.row?.atr),
      imbalance: toNumber(params.row?.imbalance),
      trend: toNumber(params.row?.trend_strength ?? params.row?.adx),
      liquidityScore: toNumber(params.row?.liquidity_score),
      sourceError: params.sourceError ?? null,
      sourceLatencyMs: params.sourceLatencyMs ?? null,
    },
    citations: [],
    riskFlags,
  }
}

const domainSetFrom = (domain: TorghutMarketContextBundle['domains']) => [domain.technicals, domain.regime]

const buildBundleFromDomains = (params: {
  symbol: string
  now: Date
  domains: TorghutMarketContextBundle['domains']
}): TorghutMarketContextBundle => {
  const domains = domainSetFrom(params.domains)
  const qualityScore = domains.reduce((acc, domain) => acc + domain.qualityScore, 0) / domains.length
  const riskFlags = Array.from(new Set(domains.flatMap((domain) => domain.riskFlags)))
  const asOfCandidates = domains
    .map((domain) => (domain.asOf ? Date.parse(domain.asOf) : Number.NaN))
    .filter((value) => Number.isFinite(value))
  const latestAsOfMs = asOfCandidates.length > 0 ? Math.max(...asOfCandidates) : params.now.getTime()
  const freshnessSeconds = Math.max(0, Math.floor((params.now.getTime() - latestAsOfMs) / 1000))
  const sourceCount = domains.reduce((acc, domain) => acc + domain.sourceCount, 0)
  return {
    contextVersion: 'torghut.market-context.v1',
    symbol: params.symbol,
    asOfUtc: new Date(latestAsOfMs).toISOString(),
    freshnessSeconds,
    qualityScore: Number(qualityScore.toFixed(4)),
    sourceCount,
    riskFlags,
    domains: params.domains,
  }
}

const bundleCacheKey = (params: { symbol: string; asOf: Date | undefined; maxStalenessSeconds: number }) => {
  const asOfKey = params.asOf ? params.asOf.toISOString() : 'latest'
  return `${params.symbol.toUpperCase()}|${asOfKey}|${params.maxStalenessSeconds}`
}

export const clearMarketContextCache = () => {
  cache.clear()
}

export const getTorghutMarketContext = async (
  symbolInput: string,
  options: MarketContextOptions = {},
): Promise<TorghutMarketContextBundle> => {
  const settings = resolveSettings()
  const symbol = normalizeTorghutSymbol(symbolInput)
  const now = options.asOf ?? new Date()
  const maxStalenessSeconds = options.maxStalenessSeconds ?? settings.maxStalenessSeconds
  const enabled = await resolveMarketContextEnabled({ settings })
  if (!enabled) {
    const domains = {
      technicals: technicalDomain({ now, row: null, maxFreshnessSeconds: settings.technicalsMaxFreshnessSeconds }),
      regime: regimeDomain({ now, row: null, maxFreshnessSeconds: settings.regimeMaxFreshnessSeconds }),
    }
    const disabledBundle = buildBundleFromDomains({ symbol, now, domains })
    return { ...disabledBundle, riskFlags: [...disabledBundle.riskFlags, 'market_context_disabled'] }
  }

  const cacheKey = bundleCacheKey({
    symbol,
    asOf: options.asOf,
    maxStalenessSeconds,
  })
  const cached = cache.get(cacheKey)
  if (cached) {
    const ageMs = Date.now() - cached.createdAtMs
    if (ageMs <= settings.cacheSeconds * 1000) return cached.value
  }

  const clientResult = resolveClickHouse(options.client)
  let signalRow: Record<string, unknown> | null = null
  let signalSourceError: string | null = null
  let signalSourceLatencyMs: number | null = null
  if (clientResult.ok) {
    const start = Date.now()
    try {
      signalRow = await getLatestSignalRow(clientResult.client, symbol)
      signalSourceLatencyMs = Date.now() - start
      recordClickHouseAttempt({
        configured: true,
        success: true,
        latencyMs: signalSourceLatencyMs,
      })
    } catch {
      signalRow = null
      signalSourceLatencyMs = Date.now() - start
      signalSourceError = 'clickhouse_query_failed'
      recordClickHouseAttempt({
        configured: true,
        success: false,
        error: signalSourceError,
        latencyMs: signalSourceLatencyMs,
      })
    }
  } else {
    signalSourceError = clientResult.message
    signalSourceLatencyMs = 0
    recordClickHouseAttempt({
      configured: false,
      success: false,
      error: clientResult.message,
      latencyMs: 0,
    })
  }

  const domains = {
    technicals: technicalDomain({
      now,
      row: signalRow,
      maxFreshnessSeconds: settings.technicalsMaxFreshnessSeconds,
      sourceError: settings.requireTechnicalsSourceHealth ? signalSourceError : null,
      sourceLatencyMs: signalSourceLatencyMs,
    }),
    regime: regimeDomain({
      now,
      row: signalRow,
      maxFreshnessSeconds: settings.regimeMaxFreshnessSeconds,
      sourceError: settings.requireTechnicalsSourceHealth ? signalSourceError : null,
      sourceLatencyMs: signalSourceLatencyMs,
    }),
  }
  const bundle = buildBundleFromDomains({ symbol, now, domains })
  if (bundle.freshnessSeconds > maxStalenessSeconds) {
    bundle.riskFlags.push('market_context_stale')
  }
  cache.set(cacheKey, { value: bundle, createdAtMs: Date.now() })
  return bundle
}

export const getTorghutMarketContextHealth = async (symbol = 'SPY', options: MarketContextOptions = {}) => {
  const settings = resolveSettings()
  const bundle = await getTorghutMarketContext(symbol, options)
  const enabled = !bundle.riskFlags.includes('market_context_disabled')
  const domainHealth = domainSetFrom(bundle.domains).map((domain) => ({
    domain: domain.domain,
    state: domain.state,
    freshnessSeconds: domain.freshnessSeconds,
    maxFreshnessSeconds: domain.maxFreshnessSeconds,
    qualityScore: domain.qualityScore,
    riskFlags: domain.riskFlags,
  }))

  let overallState: TorghutMarketContextHealth['overallState'] = 'ok'
  if (!enabled) overallState = 'down'
  else if (domainHealth.some((domain) => domain.state === 'error')) overallState = 'down'
  else if (domainHealth.some((domain) => domain.state !== 'ok')) overallState = 'degraded'

  return {
    enabled,
    cacheSeconds: settings.cacheSeconds,
    maxStalenessSeconds: settings.maxStalenessSeconds,
    bundleFreshnessSeconds: bundle.freshnessSeconds,
    bundleQualityScore: bundle.qualityScore,
    providerHealth: [],
    ingestionHealth: {
      clickhouse: clickHouseHealth,
    },
    domainHealth,
    overallState,
  } satisfies TorghutMarketContextHealth
}
