import { beforeEach, describe, expect, it, vi } from 'vitest'

const listQuantLatestMetrics = vi.fn()
const listQuantAlerts = vi.fn()
const startTorghutQuantRuntime = vi.fn()
const getTorghutQuantRuntimeStatus = vi.fn()
const materializeTorghutQuantFrameOnDemand = vi.fn()
const isTorghutQuantMaterializationNotFoundError = vi.fn()

vi.mock('~/server/torghut-quant-metrics-store', () => ({
  listQuantLatestMetrics,
  listQuantAlerts,
}))

vi.mock('~/server/torghut-quant-runtime', () => ({
  startTorghutQuantRuntime,
  getTorghutQuantRuntimeStatus,
  materializeTorghutQuantFrameOnDemand,
  isTorghutQuantMaterializationNotFoundError,
}))

describe('getQuantSnapshotHandler', () => {
  beforeEach(() => {
    listQuantLatestMetrics.mockReset()
    listQuantAlerts.mockReset()
    startTorghutQuantRuntime.mockReset()
    getTorghutQuantRuntimeStatus.mockReset()
    materializeTorghutQuantFrameOnDemand.mockReset()
    isTorghutQuantMaterializationNotFoundError.mockReset()
    getTorghutQuantRuntimeStatus.mockReturnValue({ enabled: true })
    isTorghutQuantMaterializationNotFoundError.mockReturnValue(false)
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
      {
        metricName: 'sharpe_annualized',
        window: '1d',
        status: 'ok',
        quality: 'good',
        unit: 'ratio',
        valueNumeric: 1.1,
        formulaVersion: 'v1',
        asOf: '2026-02-19T12:00:05.000Z',
        freshnessSeconds: 1,
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
    expect(startTorghutQuantRuntime).toHaveBeenCalledTimes(1)
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
    expect(body.frame.frameAsOf).toBe('2026-02-19T12:00:05.000Z')
    expect(body.frame.metrics).toHaveLength(2)
    expect(body.frame.alerts).toEqual([{ alertId: 'a-open', account: 'paper', window: '1d', state: 'open' }])
  })

  it('materializes and reloads metrics when latest store is empty', async () => {
    const { getQuantSnapshotHandler } = await import('./snapshot')

    listQuantLatestMetrics.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        metricName: 'trade_count',
        window: '1d',
        status: 'ok',
        quality: 'good',
        unit: 'count',
        valueNumeric: 0,
        formulaVersion: 'v1',
        asOf: '2026-02-19T12:00:00.000Z',
        freshnessSeconds: 1,
      },
    ])
    listQuantAlerts.mockResolvedValueOnce([])

    const url =
      'http://localhost/api/torghut/trading/control-plane/quant/snapshot?strategy_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&account=&window=1d'
    const response = await getQuantSnapshotHandler(new Request(url))

    expect(response.status).toBe(200)
    expect(materializeTorghutQuantFrameOnDemand).toHaveBeenCalledWith({
      strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      account: '',
      window: '1d',
    })
    expect(listQuantLatestMetrics).toHaveBeenCalledTimes(2)

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.frame.metrics).toHaveLength(1)
    expect(body.frame.metrics[0]?.metricName).toBe('trade_count')
  })

  it('skips on-demand materialization when runtime is disabled', async () => {
    const { getQuantSnapshotHandler } = await import('./snapshot')

    getTorghutQuantRuntimeStatus.mockReturnValueOnce({ enabled: false })
    listQuantLatestMetrics.mockResolvedValueOnce([])
    listQuantAlerts.mockResolvedValueOnce([])

    const url =
      'http://localhost/api/torghut/trading/control-plane/quant/snapshot?strategy_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&account=&window=1d'
    const response = await getQuantSnapshotHandler(new Request(url))

    expect(response.status).toBe(200)
    expect(materializeTorghutQuantFrameOnDemand).not.toHaveBeenCalled()
    expect(listQuantLatestMetrics).toHaveBeenCalledTimes(1)

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.frame.metrics).toEqual([])
  })

  it('keeps snapshot response successful when fallback misses strategy/account materialization', async () => {
    const { getQuantSnapshotHandler } = await import('./snapshot')

    const missingFrameError = new Error(
      'Account paper-live was not found for strategy aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    )
    listQuantLatestMetrics.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    materializeTorghutQuantFrameOnDemand.mockRejectedValueOnce(missingFrameError)
    isTorghutQuantMaterializationNotFoundError.mockReturnValueOnce(true)
    listQuantAlerts.mockResolvedValueOnce([])

    const url =
      'http://localhost/api/torghut/trading/control-plane/quant/snapshot?strategy_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&account=paper-live&window=1d'
    const response = await getQuantSnapshotHandler(new Request(url))

    expect(response.status).toBe(200)
    expect(listQuantLatestMetrics).toHaveBeenCalledTimes(2)
    expect(isTorghutQuantMaterializationNotFoundError).toHaveBeenCalledWith(missingFrameError)

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.frame.metrics).toEqual([])
    expect(body.frame.account).toBe('paper-live')
  })

  it('returns 503 when fallback materialization fails for non-not-found errors', async () => {
    const { getQuantSnapshotHandler } = await import('./snapshot')

    const materializationError = new Error('Torghut DB offline')
    listQuantLatestMetrics.mockResolvedValueOnce([])
    materializeTorghutQuantFrameOnDemand.mockRejectedValueOnce(materializationError)
    isTorghutQuantMaterializationNotFoundError.mockReturnValueOnce(false)

    const url =
      'http://localhost/api/torghut/trading/control-plane/quant/snapshot?strategy_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&account=&window=1d'
    const response = await getQuantSnapshotHandler(new Request(url))

    expect(response.status).toBe(503)
    expect(listQuantLatestMetrics).toHaveBeenCalledTimes(1)

    const body = await response.json()
    expect(body.ok).toBe(false)
    expect(body.message).toContain('Torghut DB offline')
  })
})
