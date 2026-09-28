import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getQuantLatestStoreStatus = vi.fn()
const listLatestQuantPipelineHealth = vi.fn()
const startTorghutQuantRuntime = vi.fn()
const getTorghutQuantRuntimeStatus = vi.fn()

vi.mock('~/server/torghut-quant-metrics-store', () => ({
  getQuantLatestStoreStatus,
  listLatestQuantPipelineHealth,
}))

vi.mock('~/server/torghut-quant-runtime', () => ({
  startTorghutQuantRuntime,
  getTorghutQuantRuntimeStatus,
}))

describe('getQuantHealthHandler', () => {
  beforeEach(() => {
    getQuantLatestStoreStatus.mockReset()
    listLatestQuantPipelineHealth.mockReset()
    startTorghutQuantRuntime.mockReset()
    getTorghutQuantRuntimeStatus.mockReset()
    getTorghutQuantRuntimeStatus.mockReturnValue({
      started: true,
      enabled: true,
      alertsEnabled: true,
      computeIntervalMs: 1000,
      heavyComputeIntervalMs: 30000,
      streamHeartbeatMs: 15000,
      lastErrorAt: null,
      lastErrorStage: null,
      lastErrorMessage: null,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS
  })

  it('returns 400 when strategy_id is invalid', async () => {
    const { getQuantHealthHandler } = await import('./health')

    const response = await getQuantHealthHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/health?strategy_id=bad'),
    )

    expect(response.status).toBe(400)
    expect(getQuantLatestStoreStatus).not.toHaveBeenCalled()
  }, 30_000)

  it('returns degraded status when materialization lag breaches threshold during market hours', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-18T15:00:00.000Z'))
    process.env.JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS = '15'

    const { getQuantHealthHandler } = await import('./health')

    getQuantLatestStoreStatus.mockResolvedValueOnce({
      updatedAt: '2026-02-18T14:59:30.000Z',
      count: 42,
    })
    listLatestQuantPipelineHealth.mockResolvedValueOnce([
      {
        strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        account: 'paper',
        stage: 'ingestion',
        ok: true,
        lagSeconds: 7,
        asOf: '2026-02-18T14:59:58.000Z',
        details: { window: '1d' },
      },
    ])

    const response = await getQuantHealthHandler(
      new Request(
        'http://localhost/api/torghut/trading/control-plane/quant/health?strategy_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&account=paper&window=1d',
      ),
    )

    expect(response.status).toBe(200)
    expect(listLatestQuantPipelineHealth).toHaveBeenCalledWith({
      strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      account: 'paper',
      window: '1d',
      minCreatedAt: '2026-02-18T14:59:00.000Z',
    })
    expect(getQuantLatestStoreStatus).toHaveBeenCalledWith({
      strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      account: 'paper',
      window: '1d',
    })

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('degraded')
    expect(body.metricsPipelineLagSeconds).toBe(30)
    expect(body.missingUpdateAlarm).toBe(true)
    expect(body.emptyLatestStoreAlarm).toBe(false)
    expect(body.runtimeStarted).toBe(true)
    expect(body.runtimeEnabled).toBe(true)
    expect(body.stages).toHaveLength(1)
    expect(startTorghutQuantRuntime).toHaveBeenCalledTimes(1)
  })

  it('returns degraded status when the runtime reports a recent compute error', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-18T15:00:00.000Z'))
    process.env.JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS = '15'

    getTorghutQuantRuntimeStatus.mockReturnValueOnce({
      started: true,
      enabled: true,
      alertsEnabled: true,
      computeIntervalMs: 1000,
      heavyComputeIntervalMs: 30000,
      streamHeartbeatMs: 15000,
      lastErrorAt: '2026-02-18T14:59:45.000Z',
      lastErrorStage: 'light-cycle',
      lastErrorMessage: 'Error: boom',
    })

    const { getQuantHealthHandler } = await import('./health')

    getQuantLatestStoreStatus.mockResolvedValueOnce({
      updatedAt: '2026-02-18T14:59:58.000Z',
      count: 42,
    })

    const response = await getQuantHealthHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/health'),
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.status).toBe('degraded')
    expect(body.runtimeRecentErrorAlarm).toBe(true)
    expect(body.runtimeLastErrorStage).toBe('light-cycle')
    expect(body.runtimeLastErrorMessage).toBe('Error: boom')
  })

  it('suppresses missing-update alarm outside market hours and skips unscoped pipeline health', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-22T15:00:00.000Z')) // Sunday
    process.env.JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS = '15'

    const { getQuantHealthHandler } = await import('./health')

    getQuantLatestStoreStatus.mockResolvedValueOnce({
      updatedAt: '2026-02-22T14:58:00.000Z',
      count: 7,
    })
    const response = await getQuantHealthHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/health'),
    )

    expect(response.status).toBe(200)
    expect(getQuantLatestStoreStatus).toHaveBeenCalledWith({})
    expect(listLatestQuantPipelineHealth).not.toHaveBeenCalled()
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('ok')
    expect(body.missingUpdateAlarm).toBe(false)
    expect(body.emptyLatestStoreAlarm).toBe(false)
    expect(body.pipelineHealthScoped).toBe(false)
    expect(body.pipelineHealthSkippedReason).toBe('account_and_window_required')
    expect(body.stageScopeOmitted).toBe(true)
  })

  it('skips unscoped pipeline health when only a window is requested', async () => {
    const { getQuantHealthHandler } = await import('./health')

    getQuantLatestStoreStatus.mockResolvedValueOnce({
      updatedAt: '2026-02-22T14:58:00.000Z',
      count: 7,
    })

    const response = await getQuantHealthHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/health?window=1h'),
    )

    expect(response.status).toBe(200)
    expect(getQuantLatestStoreStatus).toHaveBeenCalledWith({ window: '1h' })
    expect(listLatestQuantPipelineHealth).not.toHaveBeenCalled()
    const body = await response.json()
    expect(body.pipelineHealthScoped).toBe(false)
    expect(body.pipelineHealthSkippedReason).toBe('account_and_window_required')
    expect(body.stages).toEqual([])
    expect(body.stageScopeOmitted).toBe(true)
  })

  it('returns degraded status when latest store is empty', async () => {
    const { getQuantHealthHandler } = await import('./health')

    getQuantLatestStoreStatus.mockResolvedValueOnce({
      updatedAt: null,
      count: 0,
    })
    listLatestQuantPipelineHealth.mockResolvedValueOnce([])

    const response = await getQuantHealthHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/health?account=paper&window=1d'),
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('degraded')
    expect(body.emptyLatestStoreAlarm).toBe(true)
    expect(body.latestMetricsCount).toBe(0)
  })

  it('returns degraded status when scoped pipeline health has no stage receipts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-22T15:00:00.000Z')) // Sunday

    const { getQuantHealthHandler } = await import('./health')

    getQuantLatestStoreStatus.mockResolvedValueOnce({
      updatedAt: '2026-02-22T14:59:55.000Z',
      count: 7,
    })
    listLatestQuantPipelineHealth.mockResolvedValueOnce([])

    const response = await getQuantHealthHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/health?account=paper&window=1d'),
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('degraded')
    expect(body.missingUpdateAlarm).toBe(false)
    expect(body.emptyLatestStoreAlarm).toBe(false)
    expect(body.missingPipelineHealthStages).toBe(true)
    expect(body.pipelineHealthScoped).toBe(true)
    expect(body.stageScopeOmitted).toBe(false)
  })

  it('returns degraded status when any stage is not ok', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-18T15:00:00.000Z'))
    process.env.JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS = '60'

    const { getQuantHealthHandler } = await import('./health')

    getQuantLatestStoreStatus.mockResolvedValueOnce({
      updatedAt: '2026-02-18T14:59:50.000Z',
      count: 42,
    })
    listLatestQuantPipelineHealth.mockResolvedValueOnce([
      {
        strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        account: 'paper',
        stage: 'compute',
        ok: false,
        lagSeconds: 9,
        asOf: '2026-02-18T14:59:58.000Z',
        details: { window: '1d' },
      },
    ])

    const response = await getQuantHealthHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/health?account=paper&window=1d'),
    )

    expect(response.status).toBe(200)
    expect(getQuantLatestStoreStatus).toHaveBeenCalledWith({ account: 'paper', window: '1d' })
    expect(listLatestQuantPipelineHealth).toHaveBeenCalledWith({
      strategyId: undefined,
      account: 'paper',
      window: '1d',
      minCreatedAt: '2026-02-18T14:56:00.000Z',
    })
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('degraded')
    expect(body.missingUpdateAlarm).toBe(false)
    expect(body.maxStageLagSeconds).toBe(9)
    expect(body.pipelineHealthScoped).toBe(true)
    expect(body.stageScopeOmitted).toBe(false)
  })

  it('scopes latest metric freshness check by requested strategy/account/window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-18T15:00:00.000Z'))
    process.env.JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS = '15'

    const { getQuantHealthHandler } = await import('./health')

    getQuantLatestStoreStatus.mockResolvedValueOnce({
      updatedAt: '2026-02-18T14:58:00.000Z',
      count: 7,
    })
    listLatestQuantPipelineHealth.mockResolvedValueOnce([
      {
        strategyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        account: 'paper',
        stage: 'materialization',
        ok: true,
        lagSeconds: 5,
        asOf: '2026-02-18T14:59:58.000Z',
        details: { window: '1d', strategy_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      },
    ])

    const response = await getQuantHealthHandler(
      new Request(
        'http://localhost/api/torghut/trading/control-plane/quant/health?strategy_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&account=paper&window=1d',
      ),
    )

    expect(response.status).toBe(200)
    expect(listLatestQuantPipelineHealth).toHaveBeenCalledWith({
      strategyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      account: 'paper',
      window: '1d',
      minCreatedAt: '2026-02-18T14:59:00.000Z',
    })
    expect(getQuantLatestStoreStatus).toHaveBeenCalledWith({
      strategyId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      account: 'paper',
      window: '1d',
    })

    const body = await response.json()
    expect(body.metricsPipelineLagSeconds).toBe(120)
    expect(body.missingUpdateAlarm).toBe(true)
  })
})
