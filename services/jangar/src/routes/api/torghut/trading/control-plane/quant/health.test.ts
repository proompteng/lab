import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getQuantLatestStoreStatus = vi.fn()
const listLatestQuantPipelineHealth = vi.fn()

vi.mock('~/server/torghut-quant-metrics-store', () => ({
  getQuantLatestStoreStatus,
  listLatestQuantPipelineHealth,
}))

describe('getQuantHealthHandler', () => {
  beforeEach(() => {
    getQuantLatestStoreStatus.mockReset()
    listLatestQuantPipelineHealth.mockReset()
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
  })

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
    })

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.status).toBe('degraded')
    expect(body.metricsPipelineLagSeconds).toBe(30)
    expect(body.missingUpdateAlarm).toBe(true)
    expect(body.stages).toHaveLength(1)
  })
})
