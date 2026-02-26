import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveBooleanFeatureToggle = vi.fn()
const recordTorghutQuantComputeDurationMs = vi.fn()
const recordTorghutQuantComputeError = vi.fn()
const recordTorghutQuantFrame = vi.fn()
const computeTorghutQuantMetrics = vi.fn()
const listTorghutStrategyAccounts = vi.fn()
const appendQuantPipelineHealth = vi.fn()
const appendQuantSeriesMetrics = vi.fn()
const upsertQuantAlerts = vi.fn()
const upsertQuantLatestMetrics = vi.fn()
const listTorghutTradingStrategies = vi.fn()
const resolveTorghutDb = vi.fn()

vi.mock('../feature-flags', () => ({
  resolveBooleanFeatureToggle,
}))

vi.mock('../metrics', () => ({
  recordTorghutQuantComputeDurationMs,
  recordTorghutQuantComputeError,
  recordTorghutQuantFrame,
}))

vi.mock('../torghut-quant-metrics', () => ({
  computeTorghutQuantMetrics,
  listTorghutStrategyAccounts,
}))

vi.mock('../torghut-quant-metrics-store', () => ({
  appendQuantPipelineHealth,
  appendQuantSeriesMetrics,
  upsertQuantAlerts,
  upsertQuantLatestMetrics,
}))

vi.mock('../torghut-trading', () => ({
  listTorghutTradingStrategies,
}))

vi.mock('../torghut-trading-db', () => ({
  resolveTorghutDb,
}))

describe('materializeTorghutQuantFrameOnDemand', () => {
  beforeEach(() => {
    vi.resetModules()
    resolveBooleanFeatureToggle.mockReset()
    recordTorghutQuantComputeDurationMs.mockReset()
    recordTorghutQuantComputeError.mockReset()
    recordTorghutQuantFrame.mockReset()
    computeTorghutQuantMetrics.mockReset()
    listTorghutStrategyAccounts.mockReset()
    appendQuantPipelineHealth.mockReset()
    appendQuantSeriesMetrics.mockReset()
    upsertQuantAlerts.mockReset()
    upsertQuantLatestMetrics.mockReset()
    listTorghutTradingStrategies.mockReset()
    resolveTorghutDb.mockReset()

    process.env.JANGAR_TORGHUT_QUANT_CONTROL_PLANE_ENABLED = 'true'
    resolveTorghutDb.mockReturnValue({ ok: true, pool: {} })
    listTorghutTradingStrategies.mockResolvedValue([
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'alpha', enabled: true },
    ])
    listTorghutStrategyAccounts.mockResolvedValue(['paper'])
    computeTorghutQuantMetrics.mockResolvedValue({
      strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      account: 'paper',
      window: '1d',
      frameAsOf: '2026-02-26T12:00:00.000Z',
      metrics: [
        {
          metricName: 'metrics_pipeline_lag_seconds',
          window: '1d',
          status: 'ok',
          quality: 'good',
          unit: 'seconds',
          valueNumeric: 1,
          formulaVersion: 'v1',
          asOf: '2026-02-26T12:00:00.000Z',
          freshnessSeconds: 1,
        },
      ],
    })
    appendQuantSeriesMetrics.mockResolvedValue(undefined)
    appendQuantPipelineHealth.mockResolvedValue(undefined)
    upsertQuantLatestMetrics.mockResolvedValue(undefined)
    upsertQuantAlerts.mockResolvedValue(undefined)

    const runtimeGlobal = globalThis as typeof globalThis & { __torghutQuantRuntime?: unknown }
    delete runtimeGlobal.__torghutQuantRuntime
  })

  it('updates series append timestamp map after on-demand materialization', async () => {
    const { materializeTorghutQuantFrameOnDemand } = await import('../torghut-quant-runtime')

    await materializeTorghutQuantFrameOnDemand({
      strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      account: 'paper',
      window: '1d',
    })

    const runtimeGlobal = globalThis as typeof globalThis & {
      __torghutQuantRuntime?: { lastSeriesAppendAtMs: Map<string, number> }
    }
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:paper:1d'
    expect(appendQuantSeriesMetrics).toHaveBeenCalledTimes(1)
    expect(runtimeGlobal.__torghutQuantRuntime?.lastSeriesAppendAtMs.get(key)).toEqual(expect.any(Number))
  })
})
