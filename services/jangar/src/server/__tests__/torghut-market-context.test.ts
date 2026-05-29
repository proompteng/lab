import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearMarketContextCache,
  getTorghutMarketContext,
  getTorghutMarketContextHealth,
} from '../torghut-market-context'

const restoreEnv = () => {
  delete process.env.JANGAR_MARKET_CONTEXT_ENABLED
  delete process.env.JANGAR_MARKET_CONTEXT_ENABLED_FLAG_KEY
  delete process.env.JANGAR_MARKET_CONTEXT_CACHE_SECONDS
  delete process.env.JANGAR_MARKET_CONTEXT_MAX_STALENESS_SECONDS
  delete process.env.JANGAR_MARKET_CONTEXT_PROVIDER_CHAIN
  delete process.env.JANGAR_MARKET_CONTEXT_REQUIRE_TECHNICALS_SOURCE_HEALTH
  delete process.env.JANGAR_MARKET_CONTEXT_TECHNICALS_MAX_FRESHNESS_SECONDS
  delete process.env.JANGAR_MARKET_CONTEXT_NEWS_MAX_FRESHNESS_SECONDS
  delete process.env.JANGAR_MARKET_CONTEXT_REGIME_MAX_FRESHNESS_SECONDS
  delete process.env.JANGAR_FEATURE_FLAGS_ENABLED
  delete process.env.JANGAR_FEATURE_FLAGS_URL
  delete process.env.JANGAR_FEATURE_FLAGS_TIMEOUT_MS
}

afterEach(() => {
  restoreEnv()
  clearMarketContextCache()
  vi.unstubAllGlobals()
})

describe('torghut market context', () => {
  it('builds v1 bundle with freshness and domain contracts', async () => {
    const now = new Date('2026-02-19T12:00:00.000Z')
    const context = await getTorghutMarketContext('nvda', {
      asOf: now,
      client: {
        queryJson: async <T>() =>
          [
            {
              event_ts: '2026-02-19 11:59:30.000',
              c: '142.51',
              spread: '0.04',
              rsi14: '57.2',
              macd: '1.2',
              macd_signal: '0.8',
              v: '210000',
              volatility: '0.14',
            },
          ] as T[],
      },
    })

    expect(context.contextVersion).toBe('torghut.market-context.v1')
    expect(context.symbol).toBe('NVDA')
    expect(context.freshnessSeconds).toBe(30)
    expect(context.domains.technicals.state).toBe('ok')
    expect(context.domains.regime.state).toBe('ok')
    expect(context.domains.technicals.payload.price).toBe(142.51)
    expect(context.domains).not.toHaveProperty('fundamentals')
    expect(context.domains).not.toHaveProperty('news')
    expect(context.riskFlags).not.toContain('news_missing')
    expect(context.riskFlags).not.toContain('fundamentals_missing')
  })

  it('uses canonical ta_signals columns and avoids legacy identifiers', async () => {
    const now = new Date('2026-02-19T12:00:00.000Z')
    const context = await getTorghutMarketContext('nvda', {
      asOf: now,
      client: {
        queryJson: async <T>(query: string) => {
          const forbiddenTokens = [' c,', ' spread,', ' rsi,', ' v,', ' atr,', ' adx,', ' liquidity_score']
          for (const token of forbiddenTokens) {
            if (query.includes(token)) throw new Error(`legacy_column_in_query:${token.trim()}`)
          }
          expect(query).toContain('coalesce(vwap_session, vwap_w5m) AS vwap')
          expect(query).toContain('vol_realized_w60s AS volatility')
          expect(query).toContain('imbalance_spread AS imbalance')
          expect(query).toContain('macd_hist AS trend_strength')
          return [
            {
              event_ts: '2026-02-19 11:59:30.000',
              vwap: '142.51',
              rsi14: '57.2',
              macd: '1.2',
              macd_signal: '0.8',
              volatility: '0.14',
              imbalance: '0.02',
              trend_strength: '0.9',
            },
          ] as T[]
        },
      },
    })

    expect(context.domains.technicals.state).toBe('ok')
    expect(context.domains.regime.state).toBe('ok')
    expect(context.domains.technicals.payload.price).toBe(142.51)
  })

  it('marks stale bundle when max staleness exceeded', async () => {
    const now = new Date('2026-02-19T12:00:00.000Z')
    const context = await getTorghutMarketContext('AAPL', {
      asOf: now,
      maxStalenessSeconds: 10,
      client: {
        queryJson: async <T>() =>
          [
            {
              event_ts: '2026-02-19 11:59:30.000',
              c: '210.02',
            },
          ] as T[],
      },
    })

    expect(context.freshnessSeconds).toBe(30)
    expect(context.riskFlags).toContain('market_context_stale')
  })

  it('returns disabled state and health down when feature flag is off', async () => {
    process.env.JANGAR_MARKET_CONTEXT_ENABLED = 'false'

    const context = await getTorghutMarketContext('SPY', { asOf: new Date('2026-02-19T12:00:00.000Z') })
    const health = await getTorghutMarketContextHealth('SPY', { asOf: new Date('2026-02-19T12:00:00.000Z') })

    expect(context.riskFlags).toContain('market_context_disabled')
    expect(health.enabled).toBe(false)
    expect(health.overallState).toBe('down')
  })

  it('uses feature-flags service for market context enablement when configured', async () => {
    process.env.JANGAR_MARKET_CONTEXT_ENABLED = 'true'
    process.env.JANGAR_MARKET_CONTEXT_ENABLED_FLAG_KEY = 'jangar.market_context.enabled'
    process.env.JANGAR_FEATURE_FLAGS_URL = 'http://feature-flags.feature-flags.svc.cluster.local:8013'

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        enabled: false,
        reason: 'DEFAULT_EVALUATION_REASON',
        requestId: 'test-request-id',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const context = await getTorghutMarketContext('SPY', { asOf: new Date('2026-02-19T12:00:00.000Z') })

    expect(context.riskFlags).toContain('market_context_disabled')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://feature-flags.feature-flags.svc.cluster.local:8013/evaluate/v1/boolean',
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('scopes cache entries by asOf and staleness options', async () => {
    process.env.JANGAR_MARKET_CONTEXT_CACHE_SECONDS = '600'

    let queryCount = 0
    const client = {
      queryJson: async <T>() => {
        queryCount += 1
        return [
          {
            event_ts: '2026-02-19 11:59:30.000',
            c: '210.02',
          },
        ] as T[]
      },
    }

    const contextA = await getTorghutMarketContext('AAPL', {
      asOf: new Date('2026-02-19T12:00:00.000Z'),
      maxStalenessSeconds: 120,
      client,
    })
    const contextB = await getTorghutMarketContext('AAPL', {
      asOf: new Date('2026-02-19T12:01:00.000Z'),
      maxStalenessSeconds: 120,
      client,
    })
    const contextC = await getTorghutMarketContext('AAPL', {
      asOf: new Date('2026-02-19T12:01:00.000Z'),
      maxStalenessSeconds: 10,
      client,
    })

    expect(queryCount).toBe(3)
    expect(contextA.freshnessSeconds).toBe(30)
    expect(contextB.freshnessSeconds).toBe(90)
    expect(contextB.riskFlags).not.toContain('market_context_stale')
    expect(contextC.riskFlags).toContain('market_context_stale')
  })

  it('marks technical and regime domains as error when clickhouse is unavailable', async () => {
    delete process.env.CH_HOST
    delete process.env.CH_USER
    delete process.env.CH_PASSWORD

    const health = await getTorghutMarketContextHealth('AAPL', {
      asOf: new Date('2026-02-19T12:00:00.000Z'),
    })

    expect(health.overallState).toBe('down')
    expect(health.domainHealth.find((d) => d.domain === 'technicals')?.state).toBe('error')
    expect(health.domainHealth.find((d) => d.domain === 'regime')?.state).toBe('error')
    expect(health.ingestionHealth.clickhouse.configured).toBe(false)
    expect(health.ingestionHealth.clickhouse.lastError).toBe('CH_HOST is not configured')
  })

  it('allows opt-out from strict technical source health enforcement', async () => {
    process.env.JANGAR_MARKET_CONTEXT_REQUIRE_TECHNICALS_SOURCE_HEALTH = 'false'
    delete process.env.CH_HOST
    delete process.env.CH_USER
    delete process.env.CH_PASSWORD

    const context = await getTorghutMarketContext('AAPL', {
      asOf: new Date('2026-02-19T12:00:00.000Z'),
    })

    expect(context.domains.technicals.state).toBe('missing')
    expect(context.domains.regime.state).toBe('missing')
    expect(context.riskFlags).not.toContain('technicals_source_error')
    expect(context.riskFlags).not.toContain('regime_source_error')
  })
})
