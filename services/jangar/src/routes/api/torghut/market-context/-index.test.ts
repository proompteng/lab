import { beforeEach, describe, expect, it, vi } from 'vitest'

const getTorghutMarketContext = vi.fn()

vi.mock('~/server/torghut-market-context', () => ({
  getTorghutMarketContext,
}))

describe('getMarketContextHandler', () => {
  beforeEach(() => {
    getTorghutMarketContext.mockReset()
  })

  it('returns 400 when symbol is missing', async () => {
    const { getMarketContextHandler } = await import('./index')
    const response = await getMarketContextHandler(new Request('http://localhost/api/torghut/market-context/'))
    expect(response.status).toBe(400)
    expect(getTorghutMarketContext).not.toHaveBeenCalled()
  })

  it('returns context payload for valid request', async () => {
    getTorghutMarketContext.mockResolvedValueOnce({
      contextVersion: 'torghut.market-context.v1',
      symbol: 'AAPL',
      asOfUtc: '2026-02-19T12:00:00.000Z',
      freshnessSeconds: 10,
      qualityScore: 0.8,
      sourceCount: 2,
      riskFlags: [],
      domains: {
        technicals: {},
        fundamentals: {},
        news: {},
        regime: {},
      },
    })

    const { getMarketContextHandler } = await import('./index')
    const response = await getMarketContextHandler(
      new Request('http://localhost/api/torghut/market-context/?symbol=AAPL&asOf=2026-02-19T12:00:00.000Z'),
    )
    expect(response.status).toBe(200)
    expect(getTorghutMarketContext).toHaveBeenCalled()
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.context.symbol).toBe('AAPL')
  })

  it('returns 500 on market context service errors', async () => {
    getTorghutMarketContext.mockRejectedValueOnce(new Error('query_failed'))
    const { getMarketContextHandler } = await import('./index')
    const response = await getMarketContextHandler(
      new Request('http://localhost/api/torghut/market-context/?symbol=MSFT'),
    )
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.message).toBe('query_failed')
  })
})
