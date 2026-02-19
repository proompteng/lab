import { beforeEach, describe, expect, it, vi } from 'vitest'

const listQuantSeriesMetrics = vi.fn()

vi.mock('~/server/torghut-quant-metrics-store', () => ({
  listQuantSeriesMetrics,
}))

describe('getQuantSeriesHandler', () => {
  beforeEach(() => {
    listQuantSeriesMetrics.mockReset()
  })

  it('returns 400 when metrics query param is missing', async () => {
    const { getQuantSeriesHandler } = await import('./series')

    const response = await getQuantSeriesHandler(
      new Request(
        'http://localhost/api/torghut/trading/control-plane/quant/series?strategy_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    )

    expect(response.status).toBe(400)
    expect(listQuantSeriesMetrics).not.toHaveBeenCalled()
  })

  it('returns grouped series by metric contract', async () => {
    const { getQuantSeriesHandler } = await import('./series')

    listQuantSeriesMetrics.mockResolvedValueOnce([
      {
        metricName: 'net_pnl',
        asOf: '2026-02-19T12:00:00.000Z',
        valueNumeric: 5,
        quality: 'good',
        status: 'ok',
      },
      {
        metricName: 'net_pnl',
        asOf: '2026-02-19T12:01:00.000Z',
        valueNumeric: 7,
        quality: 'good',
        status: 'ok',
      },
      {
        metricName: 'sharpe_annualized',
        asOf: '2026-02-19T12:01:00.000Z',
        valueNumeric: 1.2,
        quality: 'good',
        status: 'ok',
      },
    ])

    const url =
      'http://localhost/api/torghut/trading/control-plane/quant/series?strategy_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&account=paper&window=1d&metrics=net_pnl,sharpe_annualized&from=2026-02-19T11:00:00.000Z&to=2026-02-19T13:00:00.000Z'
    const response = await getQuantSeriesHandler(new Request(url))

    expect(response.status).toBe(200)
    expect(listQuantSeriesMetrics).toHaveBeenCalledWith({
      strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      account: 'paper',
      window: '1d',
      metricNames: ['net_pnl', 'sharpe_annualized'],
      fromUtc: '2026-02-19T11:00:00.000Z',
      toUtc: '2026-02-19T13:00:00.000Z',
    })

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.series.net_pnl).toHaveLength(2)
    expect(body.series.sharpe_annualized).toHaveLength(1)
  })
})
