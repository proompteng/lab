import { beforeEach, describe, expect, it, vi } from 'vitest'

const getTorghutMarketContextHealth = vi.fn()

vi.mock('~/server/torghut-market-context', () => ({
  getTorghutMarketContextHealth,
}))

describe('getMarketContextHealthHandler', () => {
  beforeEach(() => {
    getTorghutMarketContextHealth.mockReset()
  })

  it('returns health payload for requested symbol', async () => {
    getTorghutMarketContextHealth.mockResolvedValueOnce({
      enabled: true,
      cacheSeconds: 60,
      maxStalenessSeconds: 300,
      bundleFreshnessSeconds: 12,
      bundleQualityScore: 0.7,
      providerHealth: [],
      ingestionHealth: {
        clickhouse: {
          configured: true,
          lastAttemptAt: '2026-02-19T12:00:00.000Z',
          lastSuccessAt: '2026-02-19T12:00:00.000Z',
          lastError: null,
          consecutiveFailures: 0,
          latencyMs: 24,
        },
      },
      domainHealth: [],
      overallState: 'ok',
    })

    const { getMarketContextHealthHandler } = await import('./health')
    const response = await getMarketContextHealthHandler(
      new Request('http://localhost/api/torghut/market-context/health?symbol=AAPL'),
    )

    expect(response.status).toBe(200)
    expect(getTorghutMarketContextHealth).toHaveBeenCalledWith('AAPL')
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.health.overallState).toBe('ok')
  })

  it('returns 503 when health query fails', async () => {
    getTorghutMarketContextHealth.mockRejectedValueOnce(new Error('upstream_health_failed'))

    const { getMarketContextHealthHandler } = await import('./health')
    const response = await getMarketContextHealthHandler(
      new Request('http://localhost/api/torghut/market-context/health'),
    )

    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.message).toBe('upstream_health_failed')
  })
})
