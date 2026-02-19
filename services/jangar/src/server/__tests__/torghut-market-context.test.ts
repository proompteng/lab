import { afterEach, describe, expect, it } from 'vitest'

import {
  clearMarketContextCache,
  getTorghutMarketContext,
  getTorghutMarketContextHealth,
} from '../torghut-market-context'

const restoreEnv = () => {
  delete process.env.JANGAR_MARKET_CONTEXT_ENABLED
  delete process.env.JANGAR_MARKET_CONTEXT_CACHE_SECONDS
  delete process.env.JANGAR_MARKET_CONTEXT_MAX_STALENESS_SECONDS
}

afterEach(() => {
  restoreEnv()
  clearMarketContextCache()
})

describe('torghut market context', () => {
  it('builds v1 bundle with freshness and domain contracts', async () => {
    const now = new Date('2026-02-19T12:00:00.000Z')
    const context = await getTorghutMarketContext('nvda', {
      asOf: now,
      client: {
        queryJson: async () => [
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
        ],
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
        queryJson: async () => [
          {
            event_ts: '2026-02-19 11:59:30.000',
            c: '210.02',
          },
        ],
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
})
