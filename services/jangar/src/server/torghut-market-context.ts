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

type ProviderHealthSignal = {
  provider: 'fundamentals' | 'news'
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
  providerHealth: ProviderHealthSignal[]
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

const parseOptionalInt = (value: string | undefined): number | null => {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

const resolveSettings = () => {
  const technicalsMaxFreshnessSeconds =
    parseOptionalInt(process.env.JANGAR_MARKET_CONTEXT_TECHNICALS_MAX_FRESHNESS_SECONDS) ??
    FALLBACK_TECHNICAL_FRESHNESS_SECONDS
  const fundamentalsMaxFreshnessSeconds =
    parseOptionalInt(process.env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_MAX_FRESHNESS_SECONDS) ??
    FALLBACK_FUNDAMENTALS_FRESHNESS_SECONDS
  const newsMaxFreshnessSeconds =
    parseOptionalInt(process.env.JANGAR_MARKET_CONTEXT_NEWS_MAX_FRESHNESS_SECONDS) ?? FALLBACK_NEWS_FRESHNESS_SECONDS
  const regimeMaxFreshnessSeconds =
    parseOptionalInt(process.env.JANGAR_MARKET_CONTEXT_REGIME_MAX_FRESHNESS_SECONDS) ??
    FALLBACK_REGIME_FRESHNESS_SECONDS

  return {
    enabled: toBoolean(process.env.JANGAR_MARKET_CONTEXT_ENABLED, true),
    cacheSeconds: parsePositiveInt(process.env.JANGAR_MARKET_CONTEXT_CACHE_SECONDS, 60),
    maxStalenessSeconds: parsePositiveInt(process.env.JANGAR_MARKET_CONTEXT_MAX_STALENESS_SECONDS, 300),
    providerTimeoutMs: parsePositiveInt(process.env.JANGAR_MARKET_CONTEXT_PROVIDER_TIMEOUT_MS, 2000),
    fundamentalsSourceUrl: process.env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_URL?.trim() || '',
    newsSourceUrl: process.env.JANGAR_MARKET_CONTEXT_NEWS_URL?.trim() || '',
    technicalsMaxFreshnessSeconds,
    fundamentalsMaxFreshnessSeconds,
    newsMaxFreshnessSeconds,
    regimeMaxFreshnessSeconds,
  }
}

type CacheEntry = {
  value: TorghutMarketContextBundle
  createdAtMs: number
}

const cache = new Map<string, CacheEntry>()

const providerHealth = new Map<'fundamentals' | 'news', ProviderHealthSignal>([
  [
    'fundamentals',
    {
      provider: 'fundamentals',
      configured: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
      latencyMs: null,
    },
  ],
  [
    'news',
    {
      provider: 'news',
      configured: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
      latencyMs: null,
    },
  ],
])

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

const coerceRiskFlags = (value: unknown) => {
  if (!Array.isArray(value)) return []
  return value
    .map((flag) => (typeof flag === 'string' ? flag.trim() : ''))
    .filter((flag): flag is string => flag.length > 0)
}

const coerceCitations = (value: unknown): MarketContextCitation[] => {
  if (!Array.isArray(value)) return []
  const citations: MarketContextCitation[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const source = typeof row.source === 'string' ? row.source : ''
    const publishedAt = parseTimestamp(row.publishedAt)
    if (!source || !publishedAt) continue
    citations.push({
      source,
      publishedAt: iso(publishedAt),
      url: typeof row.url === 'string' ? row.url : null,
    })
  }
  return citations
}

const recordProviderAttempt = (
  provider: 'fundamentals' | 'news',
  params: { configured: boolean; success: boolean; error?: string; latencyMs: number },
) => {
  const previous = providerHealth.get(provider)
  const nowIso = new Date().toISOString()
  providerHealth.set(provider, {
    provider,
    configured: params.configured,
    lastAttemptAt: nowIso,
    lastSuccessAt: params.success ? nowIso : (previous?.lastSuccessAt ?? null),
    lastError: params.success ? null : (params.error ?? 'provider_unknown_error'),
    consecutiveFailures: params.success ? 0 : (previous?.consecutiveFailures ?? 0) + 1,
    latencyMs: params.latencyMs,
  })
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

const technicalDomain = (params: {
  now: Date
  row: Record<string, unknown> | null
  maxFreshnessSeconds: number
}): MarketContextDomain => {
  const asOf = parseTimestamp(params.row?.event_ts ?? params.row?.ts)
  const freshnessSeconds = resolveFreshnessSeconds(params.now, asOf)
  const maxFreshnessSeconds = params.maxFreshnessSeconds
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

const regimeDomain = (params: {
  now: Date
  row: Record<string, unknown> | null
  maxFreshnessSeconds: number
}): MarketContextDomain => {
  const asOf = parseTimestamp(params.row?.event_ts ?? params.row?.ts)
  const freshnessSeconds = resolveFreshnessSeconds(params.now, asOf)
  const maxFreshnessSeconds = params.maxFreshnessSeconds
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

type ExternalDomainResponse = {
  asOf: Date | null
  sourceCount: number
  qualityScore: number
  payload: Record<string, unknown>
  citations: MarketContextCitation[]
  riskFlags: string[]
}

const fetchExternalDomainResponse = async (params: {
  provider: 'fundamentals' | 'news'
  symbol: string
  now: Date
  sourceUrl: string
  timeoutMs: number
}): Promise<ExternalDomainResponse | null> => {
  if (!params.sourceUrl) {
    providerHealth.set(params.provider, {
      provider: params.provider,
      configured: false,
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
      latencyMs: null,
    })
    return null
  }

  const start = Date.now()
  try {
    const url = new URL(params.sourceUrl)
    url.searchParams.set('symbol', params.symbol)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs)
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!response.ok) {
      recordProviderAttempt(params.provider, {
        configured: true,
        success: false,
        error: `provider_http_${response.status}`,
        latencyMs: Date.now() - start,
      })
      return {
        asOf: null,
        sourceCount: 0,
        qualityScore: 0,
        payload: {},
        citations: [],
        riskFlags: [`${params.provider}_provider_http_${response.status}`],
      }
    }

    const body = (await response.json()) as Record<string, unknown>
    const data =
      body.ok === true && typeof body.context === 'object' && body.context
        ? (body.context as Record<string, unknown>)
        : body
    const asOf = parseTimestamp(data.asOfUtc ?? data.asOf ?? data.publishedAt)
    const sourceCount = Math.max(0, Math.trunc(toNumber(data.sourceCount) ?? toNumber(data.itemCount) ?? 0))
    const rawQuality = toNumber(data.qualityScore)
    const qualityScore = rawQuality === null ? 1 : Math.max(0, Math.min(1, rawQuality))
    const payload = data.payload && typeof data.payload === 'object' ? (data.payload as Record<string, unknown>) : data
    const citations = coerceCitations(data.citations)
    const riskFlags = coerceRiskFlags(data.riskFlags)
    recordProviderAttempt(params.provider, {
      configured: true,
      success: true,
      latencyMs: Date.now() - start,
    })
    return {
      asOf,
      sourceCount,
      qualityScore,
      payload,
      citations,
      riskFlags,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'provider_fetch_failed'
    recordProviderAttempt(params.provider, {
      configured: true,
      success: false,
      error: message,
      latencyMs: Date.now() - start,
    })
    return {
      asOf: null,
      sourceCount: 0,
      qualityScore: 0,
      payload: {},
      citations: [],
      riskFlags: [`${params.provider}_provider_error`],
    }
  }
}

const emptyDomain = (params: {
  now: Date
  domain: 'fundamentals' | 'news'
  maxFreshnessSeconds: number
  provider: string
}): MarketContextDomain => ({
  domain: params.domain,
  state: 'missing',
  asOf: null,
  freshnessSeconds: null,
  maxFreshnessSeconds: params.maxFreshnessSeconds,
  sourceCount: 0,
  qualityScore: 0,
  payload: {
    asOfUtc: iso(params.now),
    provider: params.provider,
    itemCount: 0,
  },
  citations: [],
  riskFlags: [`${params.domain}_missing`],
})

const externalDomain = (params: {
  now: Date
  domain: 'fundamentals' | 'news'
  maxFreshnessSeconds: number
  response: ExternalDomainResponse | null
}): MarketContextDomain => {
  if (!params.response) {
    return emptyDomain({
      now: params.now,
      domain: params.domain,
      maxFreshnessSeconds: params.maxFreshnessSeconds,
      provider: 'not_configured',
    })
  }

  const freshnessSeconds = resolveFreshnessSeconds(params.now, params.response.asOf)
  let state = resolveState(freshnessSeconds, params.maxFreshnessSeconds)
  const riskFlags = [...params.response.riskFlags]
  if (riskFlags.some((flag) => flag.includes('provider_error') || flag.includes('provider_http_'))) {
    state = 'error'
  }
  if (state !== 'ok' && !riskFlags.includes(`${params.domain}_${state}`)) {
    riskFlags.push(`${params.domain}_${state}`)
  }

  return {
    domain: params.domain,
    state,
    asOf: params.response.asOf ? iso(params.response.asOf) : null,
    freshnessSeconds,
    maxFreshnessSeconds: params.maxFreshnessSeconds,
    sourceCount: params.response.sourceCount,
    qualityScore: state === 'error' ? 0 : params.response.qualityScore,
    payload: params.response.payload,
    citations: params.response.citations,
    riskFlags,
  }
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
  if (!settings.enabled) {
    const domains = {
      technicals: technicalDomain({ now, row: null, maxFreshnessSeconds: settings.technicalsMaxFreshnessSeconds }),
      fundamentals: emptyDomain({
        now,
        domain: 'fundamentals',
        maxFreshnessSeconds: settings.fundamentalsMaxFreshnessSeconds,
        provider: 'feature_disabled',
      }),
      news: emptyDomain({
        now,
        domain: 'news',
        maxFreshnessSeconds: settings.newsMaxFreshnessSeconds,
        provider: 'feature_disabled',
      }),
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
  if (clientResult.ok) {
    try {
      signalRow = await getLatestSignalRow(clientResult.client, symbol)
    } catch {
      signalRow = null
    }
  }

  const [fundamentalsResponse, newsResponse] = await Promise.all([
    fetchExternalDomainResponse({
      provider: 'fundamentals',
      symbol,
      now,
      sourceUrl: settings.fundamentalsSourceUrl,
      timeoutMs: settings.providerTimeoutMs,
    }),
    fetchExternalDomainResponse({
      provider: 'news',
      symbol,
      now,
      sourceUrl: settings.newsSourceUrl,
      timeoutMs: settings.providerTimeoutMs,
    }),
  ])

  const domains = {
    technicals: technicalDomain({ now, row: signalRow, maxFreshnessSeconds: settings.technicalsMaxFreshnessSeconds }),
    fundamentals: externalDomain({
      now,
      domain: 'fundamentals',
      maxFreshnessSeconds: settings.fundamentalsMaxFreshnessSeconds,
      response: fundamentalsResponse,
    }),
    news: externalDomain({
      now,
      domain: 'news',
      maxFreshnessSeconds: settings.newsMaxFreshnessSeconds,
      response: newsResponse,
    }),
    regime: regimeDomain({ now, row: signalRow, maxFreshnessSeconds: settings.regimeMaxFreshnessSeconds }),
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
  else if (domainHealth.some((domain) => domain.state === 'error')) overallState = 'down'
  else if (domainHealth.some((domain) => domain.state !== 'ok')) overallState = 'degraded'

  return {
    enabled: settings.enabled,
    cacheSeconds: settings.cacheSeconds,
    maxStalenessSeconds: settings.maxStalenessSeconds,
    bundleFreshnessSeconds: bundle.freshnessSeconds,
    bundleQualityScore: bundle.qualityScore,
    providerHealth: Array.from(providerHealth.values()),
    domainHealth,
    overallState,
  } satisfies TorghutMarketContextHealth
}
