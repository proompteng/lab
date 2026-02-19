import { beforeEach, describe, expect, it, vi } from 'vitest'

const listQuantLatestMetrics = vi.fn()
const listQuantAlerts = vi.fn()

vi.mock('~/server/torghut-quant-metrics-store', () => ({
  listQuantLatestMetrics,
  listQuantAlerts,
}))

describe('getQuantSnapshotHandler', () => {
  beforeEach(() => {
    listQuantLatestMetrics.mockReset()
    listQuantAlerts.mockReset()
  })

  it('returns 400 when strategy_id is invalid', async () => {
    const { getQuantSnapshotHandler } = await import('./snapshot')

    const response = await getQuantSnapshotHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/snapshot?strategy_id=bad'),
    )

    expect(response.status).toBe(400)
    expect(listQuantLatestMetrics).not.toHaveBeenCalled()
  })

  it('returns quant frame contract and filters alerts by account/window', async () => {
    const { getQuantSnapshotHandler } = await import('./snapshot')

    listQuantLatestMetrics.mockResolvedValueOnce([
      {
        metricName: 'net_pnl',
        window: '1d',
        status: 'ok',
        quality: 'good',
        unit: 'USD',
        valueNumeric: 12.5,
        formulaVersion: 'v1',
        asOf: '2026-02-19T12:00:00.000Z',
        freshnessSeconds: 3,
      },
    ])
    listQuantAlerts.mockResolvedValueOnce([
      { alertId: 'a-open', account: 'paper', window: '1d', state: 'open' },
      { alertId: 'a-other-account', account: 'other', window: '1d', state: 'open' },
      { alertId: 'a-other-window', account: 'paper', window: '5d', state: 'open' },
    ])

    const url =
      'http://localhost/api/torghut/trading/control-plane/quant/snapshot?strategy_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&account=paper&window=1d'
    const response = await getQuantSnapshotHandler(new Request(url))

    expect(response.status).toBe(200)
    expect(listQuantLatestMetrics).toHaveBeenCalledWith({
      strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      account: 'paper',
      window: '1d',
    })

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.frame.strategyId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(body.frame.account).toBe('paper')
    expect(body.frame.window).toBe('1d')
    expect(body.frame.metrics).toHaveLength(1)
    expect(body.frame.alerts).toEqual([{ alertId: 'a-open', account: 'paper', window: '1d', state: 'open' }])
  })
})
