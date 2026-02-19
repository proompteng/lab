import { type ClickHouseClient, resolveClickHouseClient } from '~/server/clickhouse'
import { normalizeTorghutSymbol } from '~/server/torghut-symbols'

type MarketContextDomainState = 'ok' | 'stale' | 'missing' | 'error'

type MarketContextCitation = {
  source: string
  publishedAt: string
  url: string | null
}

type MarketContextDomain = {
  domain: 'technicals' | 'fundamentals' | 'news' | 'regime'
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
    fundamentals: MarketContextDomain
    news: MarketContextDomain
    regime: MarketContextDomain
  }
}

export type TorghutMarketContextHealth = {
  enabled: boolean
  cacheSeconds: number
  maxStalenessSeconds: number
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

const FALLBACK_TECHNICAL_FRESHNESS_SECONDS = 60
const FALLBACK_NEWS_FRESHNESS_SECONDS = 300
const FALLBACK_FUNDAMENTALS_FRESHNESS_SECONDS = 24 * 60 * 60
const FALLBACK_REGIME_FRESHNESS_SECONDS = 120

const toBoolean = (value: string | undefined, fallback: boolean) => {
  if (!value) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off', 'disabled'].includes(normalized)) return false
  return fallback
}

const parsePositiveInt = (value: string | undefined, fallback: number) => {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return parsed
}

const resolveSettings = () => ({
  enabled: toBoolean(process.env.JANGAR_MARKET_CONTEXT_ENABLED, true),
  cacheSeconds: parsePositiveInt(process.env.JANGAR_MARKET_CONTEXT_CACHE_SECONDS, 60),
  maxStalenessSeconds: parsePositiveInt(process.env.JANGAR_MARKET_CONTEXT_MAX_STALENESS_SECONDS, 300),
})

type CacheEntry = {
  value: TorghutMarketContextBundle
  createdAtMs: number
}

const cache = new Map<string, CacheEntry>()

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

const technicalDomain = (params: { now: Date; row: Record<string, unknown> | null }): MarketContextDomain => {
  const asOf = parseTimestamp(params.row?.event_ts ?? params.row?.ts)
  const freshnessSeconds = resolveFreshnessSeconds(params.now, asOf)
  const maxFreshnessSeconds = FALLBACK_TECHNICAL_FRESHNESS_SECONDS
  const state = resolveState(freshnessSeconds, maxFreshnessSeconds)
  const sourceCount = params.row ? 1 : 0
  const riskFlags: string[] = []
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
    },
    citations: [],
    riskFlags,
  }
}

const regimeDomain = (params: { now: Date; row: Record<string, unknown> | null }): MarketContextDomain => {
  const asOf = parseTimestamp(params.row?.event_ts ?? params.row?.ts)
  const freshnessSeconds = resolveFreshnessSeconds(params.now, asOf)
  const maxFreshnessSeconds = FALLBACK_REGIME_FRESHNESS_SECONDS
  const state = resolveState(freshnessSeconds, maxFreshnessSeconds)
  const riskFlags: string[] = []
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
    },
    citations: [],
    riskFlags,
  }
}

const fundamentalsDomain = (now: Date): MarketContextDomain => {
  const maxFreshnessSeconds = FALLBACK_FUNDAMENTALS_FRESHNESS_SECONDS
  return {
    domain: 'fundamentals',
    state: 'missing',
    asOf: null,
    freshnessSeconds: null,
    maxFreshnessSeconds,
    sourceCount: 0,
    qualityScore: 0,
    payload: {
      asOfUtc: iso(now),
      provider: 'not_configured',
      factors: {},
    },
    citations: [],
    riskFlags: ['fundamentals_missing'],
  }
}

const newsDomain = (now: Date): MarketContextDomain => {
  const maxFreshnessSeconds = FALLBACK_NEWS_FRESHNESS_SECONDS
  return {
    domain: 'news',
    state: 'missing',
    asOf: null,
    freshnessSeconds: null,
    maxFreshnessSeconds,
    sourceCount: 0,
    qualityScore: 0,
    payload: {
      asOfUtc: iso(now),
      provider: 'not_configured',
      itemCount: 0,
      sentimentScore: null,
    },
    citations: [],
    riskFlags: ['news_missing'],
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
        c,
        vwap,
        spread,
        rsi14,
        rsi,
        macd,
        macd_signal,
        v,
        volatility,
        atr,
        imbalance,
        trend_strength,
        adx,
        liquidity_score
      FROM ta_signals
      WHERE symbol = {symbol:String}
      ORDER BY event_ts DESC
      LIMIT 1
    `,
    { symbol },
  )
  return rows[0] ?? null
}

const domainSetFrom = (domain: TorghutMarketContextBundle['domains']) => [
  domain.technicals,
  domain.fundamentals,
  domain.news,
  domain.regime,
]

const buildBundleFromDomains = (params: {
  symbol: string
  now: Date
  domains: TorghutMarketContextBundle['domains']
}): TorghutMarketContextBundle => {
  const domains = domainSetFrom(params.domains)
  const qualityScore = domains.reduce((acc, domain) => acc + domain.qualityScore, 0) / domains.length
  const riskFlags = domains.flatMap((domain) => domain.riskFlags)
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
  if (!settings.enabled) {
    const domains = {
      technicals: technicalDomain({ now, row: null }),
      fundamentals: fundamentalsDomain(now),
      news: newsDomain(now),
      regime: regimeDomain({ now, row: null }),
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
  if (clientResult.ok) {
    try {
      signalRow = await getLatestSignalRow(clientResult.client, symbol)
    } catch {
      signalRow = null
    }
  }

  const domains = {
    technicals: technicalDomain({ now, row: signalRow }),
    fundamentals: fundamentalsDomain(now),
    news: newsDomain(now),
    regime: regimeDomain({ now, row: signalRow }),
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
  const domainHealth = domainSetFrom(bundle.domains).map((domain) => ({
    domain: domain.domain,
    state: domain.state,
    freshnessSeconds: domain.freshnessSeconds,
    maxFreshnessSeconds: domain.maxFreshnessSeconds,
    qualityScore: domain.qualityScore,
    riskFlags: domain.riskFlags,
  }))

  let overallState: TorghutMarketContextHealth['overallState'] = 'ok'
  if (!settings.enabled) overallState = 'down'
  else if (domainHealth.some((domain) => domain.state !== 'ok')) overallState = 'degraded'

  return {
    enabled: settings.enabled,
    cacheSeconds: settings.cacheSeconds,
    maxStalenessSeconds: settings.maxStalenessSeconds,
    domainHealth,
    overallState,
  } satisfies TorghutMarketContextHealth
}
