import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  clearMarketContextCache,
  getTorghutMarketContext,
  getTorghutMarketContextHealth,
} from '../torghut-market-context'

const restoreEnv = () => {
  delete process.env.JANGAR_MARKET_CONTEXT_ENABLED
  delete process.env.JANGAR_MARKET_CONTEXT_CACHE_SECONDS
  delete process.env.JANGAR_MARKET_CONTEXT_MAX_STALENESS_SECONDS
  delete process.env.JANGAR_MARKET_CONTEXT_PROVIDER_TIMEOUT_MS
  delete process.env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_URL
  delete process.env.JANGAR_MARKET_CONTEXT_NEWS_URL
  delete process.env.JANGAR_MARKET_CONTEXT_REQUIRE_TECHNICALS_SOURCE_HEALTH
  delete process.env.JANGAR_MARKET_CONTEXT_TECHNICALS_MAX_FRESHNESS_SECONDS
  delete process.env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_MAX_FRESHNESS_SECONDS
  delete process.env.JANGAR_MARKET_CONTEXT_NEWS_MAX_FRESHNESS_SECONDS
  delete process.env.JANGAR_MARKET_CONTEXT_REGIME_MAX_FRESHNESS_SECONDS
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
    expect(context.domains.technicals.payload.price).toBe(142.51)
    expect(context.domains.news.state).toBe('missing')
    expect(context.riskFlags).toContain('news_missing')
    expect(context.riskFlags).toContain('fundamentals_missing')
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

  it('ingests fundamentals and news providers with freshness contracts', async () => {
    process.env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_URL = 'https://fundamentals.test/context'
    process.env.JANGAR_MARKET_CONTEXT_NEWS_URL = 'https://news.test/context'
    process.env.JANGAR_MARKET_CONTEXT_PROVIDER_TIMEOUT_MS = '500'

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          asOfUtc: '2026-02-19T11:00:00.000Z',
          sourceCount: 2,
          qualityScore: 0.9,
          payload: { peRatio: 28.1 },
          citations: [{ source: 'sec', publishedAt: '2026-02-18T21:00:00.000Z', url: 'https://sec.test/10q' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          asOfUtc: '2026-02-19T11:58:00.000Z',
          sourceCount: 4,
          qualityScore: 0.7,
          payload: { sentimentScore: 0.12, itemCount: 4 },
          citations: [{ source: 'wire', publishedAt: '2026-02-19T11:57:00.000Z', url: 'https://wire.test/n1' }],
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const context = await getTorghutMarketContext('AAPL', {
      asOf: new Date('2026-02-19T12:00:00.000Z'),
      client: {
        queryJson: async <T>() => [{ event_ts: '2026-02-19 11:59:30.000', c: '210.02' }] as T[],
      },
    })

    expect(context.domains.fundamentals.state).toBe('ok')
    expect(context.domains.fundamentals.sourceCount).toBe(2)
    expect(context.domains.fundamentals.payload.peRatio).toBe(28.1)
    expect(context.domains.news.state).toBe('ok')
    expect(context.domains.news.freshnessSeconds).toBe(120)
    expect(context.domains.news.payload.sentimentScore).toBe(0.12)
    expect(context.riskFlags).not.toContain('fundamentals_missing')
    expect(context.riskFlags).not.toContain('news_missing')
  })

  it('reports provider failures in health and domain state', async () => {
    process.env.JANGAR_MARKET_CONTEXT_FUNDAMENTALS_URL = 'https://fundamentals.test/context'
    process.env.JANGAR_MARKET_CONTEXT_NEWS_URL = 'https://news.test/context'

    const fetchMock = vi.fn().mockRejectedValue(new Error('upstream timeout'))
    vi.stubGlobal('fetch', fetchMock)

    const health = await getTorghutMarketContextHealth('AAPL', {
      asOf: new Date('2026-02-19T12:00:00.000Z'),
      client: {
        queryJson: async <T>() => [{ event_ts: '2026-02-19 11:59:30.000', c: '210.02' }] as T[],
      },
    })

    expect(health.overallState).toBe('down')
    expect(health.domainHealth.find((d) => d.domain === 'fundamentals')?.state).toBe('error')
    expect(health.domainHealth.find((d) => d.domain === 'news')?.state).toBe('error')
    expect(health.providerHealth.find((d) => d.provider === 'fundamentals')?.lastError).toBe('upstream timeout')
    expect(health.providerHealth.find((d) => d.provider === 'news')?.consecutiveFailures).toBe(1)
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
