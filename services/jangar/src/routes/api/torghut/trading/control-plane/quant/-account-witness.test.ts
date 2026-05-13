import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getQuantLatestStoreStatus = vi.fn()
const listLatestQuantPipelineHealth = vi.fn()

vi.mock('~/server/torghut-quant-metrics-store', () => ({
  getQuantLatestStoreStatus,
  listLatestQuantPipelineHealth,
}))

describe('getQuantAccountWitnessHandler', () => {
  beforeEach(() => {
    getQuantLatestStoreStatus.mockReset()
    listLatestQuantPipelineHealth.mockReset()
    process.env.JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS = '15'
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS
    delete process.env.JANGAR_QUANT_ACCOUNT_WITNESS_TIMEOUT_MS
  })

  it('returns 400 when account scope is missing', async () => {
    const { getQuantAccountWitnessHandler } = await import('./account-witness')

    const response = await getQuantAccountWitnessHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/account-witness?window=15m'),
    )

    expect(response.status).toBe(400)
    expect(getQuantLatestStoreStatus).not.toHaveBeenCalled()
  })

  it('keeps aggregate health advisory when the account latest store is empty', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T15:00:00.000Z'))
    const { getQuantAccountWitnessHandler } = await import('./account-witness')

    getQuantLatestStoreStatus
      .mockResolvedValueOnce({
        updatedAt: '2026-05-13T14:59:58.000Z',
        count: 4536,
      })
      .mockResolvedValueOnce({
        updatedAt: null,
        count: 0,
      })
    listLatestQuantPipelineHealth.mockResolvedValueOnce([])

    const response = await getQuantAccountWitnessHandler(
      new Request('http://localhost/api/torghut/trading/control-plane/quant/account-witness?account=paper&window=15m'),
    )

    expect(response.status).toBe(200)
    expect(getQuantLatestStoreStatus).toHaveBeenNthCalledWith(1, {})
    expect(getQuantLatestStoreStatus).toHaveBeenNthCalledWith(2, {
      account: 'paper',
      window: '15m',
    })
    expect(listLatestQuantPipelineHealth).toHaveBeenCalledWith({
      account: 'paper',
      window: '15m',
      minCreatedAt: '2026-05-13T14:59:00.000Z',
    })

    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.witness.schema_version).toBe('jangar.quant-account-witness.v1')
    expect(body.witness.aggregate_latest_store.status).toBe('current')
    expect(body.witness.account_latest_store.status).toBe('empty')
    expect(body.witness.route_warrant_usability).toMatchObject({
      state: 'empty',
      reason_codes: expect.arrayContaining([
        'quant_account_witness_latest_store_empty',
        'quant_pipeline_ingestion_missing',
        'quant_pipeline_compute_missing',
        'quant_pipeline_materialization_missing',
        'quant_account_witness_not_current',
      ]),
    })
    expect(body.witness.capital_safety).toEqual({
      max_notional: '0',
      can_clear_routeability: false,
      reason_codes: ['zero_notional_safe', 'quant_account_witness_not_current'],
    })
  })

  it('returns a stale timeout witness instead of failing the request', async () => {
    const { getQuantAccountWitnessHandler } = await import('./account-witness')

    getQuantLatestStoreStatus
      .mockResolvedValueOnce({
        updatedAt: '2026-05-13T14:59:58.000Z',
        count: 4536,
      })
      .mockImplementationOnce(() => new Promise(() => {}))
    listLatestQuantPipelineHealth.mockImplementationOnce(() => new Promise(() => {}))

    const response = await getQuantAccountWitnessHandler(
      new Request(
        'http://localhost/api/torghut/trading/control-plane/quant/account-witness?account=PA3SX7FYNUTF&window=15m&timeout_ms=1',
      ),
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.witness.service_budget_ms).toBe(1)
    expect(body.witness.account_latest_store).toMatchObject({
      status: 'timeout',
      timeout_observed: true,
      reason_codes: ['quant_account_witness_timeout'],
    })
    expect(body.witness.pipeline_health).toMatchObject({
      status: 'timeout',
      timeout_observed: true,
      reason_codes: ['quant_account_witness_timeout'],
    })
    expect(body.witness.route_warrant_usability.state).toBe('timeout')
    expect(body.witness.capital_safety.can_clear_routeability).toBe(false)
  })

  it('keeps aggregate latest-store timeout advisory when scoped account evidence is current', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T15:00:00.000Z'))
    process.env.JANGAR_TORGHUT_QUANT_HEALTH_MISSING_UPDATE_SECONDS = '3600'
    const { getQuantAccountWitnessHandler } = await import('./account-witness')

    getQuantLatestStoreStatus
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({
        updatedAt: '2026-05-13T14:59:59.000Z',
        count: 24,
      })
    listLatestQuantPipelineHealth.mockResolvedValueOnce([
      {
        strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        account: 'paper',
        stage: 'ingestion',
        ok: true,
        lagSeconds: 1,
        asOf: '2026-05-13T14:59:59.000Z',
      },
      {
        strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        account: 'paper',
        stage: 'compute',
        ok: true,
        lagSeconds: 2,
        asOf: '2026-05-13T14:59:58.000Z',
      },
      {
        strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        account: 'paper',
        stage: 'materialization',
        ok: true,
        lagSeconds: 1,
        asOf: '2026-05-13T14:59:59.000Z',
      },
    ])

    const responsePromise = getQuantAccountWitnessHandler(
      new Request(
        'http://localhost/api/torghut/trading/control-plane/quant/account-witness?account=paper&window=15m&timeout_ms=1',
      ),
    )
    await vi.advanceTimersByTimeAsync(1)
    const response = await responsePromise

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.witness.aggregate_latest_store).toMatchObject({
      status: 'unavailable',
      reason_codes: ['quant_aggregate_latest_store_timeout'],
    })
    expect(body.witness.account_latest_store.status).toBe('current')
    expect(body.witness.pipeline_health.status).toBe('current')
    expect(body.witness.route_warrant_usability.state).toBe('current')
  })

  it('returns current route-warrant usability only when account store and required stages are current', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-13T15:00:00.000Z'))
    const { getQuantAccountWitnessHandler } = await import('./account-witness')

    getQuantLatestStoreStatus
      .mockResolvedValueOnce({
        updatedAt: '2026-05-13T14:59:58.000Z',
        count: 4536,
      })
      .mockResolvedValueOnce({
        updatedAt: '2026-05-13T14:59:59.000Z',
        count: 24,
      })
    listLatestQuantPipelineHealth.mockResolvedValueOnce([
      {
        strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        account: 'paper',
        stage: 'ingestion',
        ok: true,
        lagSeconds: 1,
        asOf: '2026-05-13T14:59:59.000Z',
        recordedAt: '2026-05-13T14:59:59.500Z',
        details: { window: '15m' },
      },
      {
        strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        account: 'paper',
        stage: 'compute',
        ok: true,
        lagSeconds: 2,
        asOf: '2026-05-13T14:59:58.000Z',
        recordedAt: '2026-05-13T14:59:59.500Z',
        details: { window: '15m' },
      },
      {
        strategyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        account: 'paper',
        stage: 'materialization',
        ok: true,
        lagSeconds: 1,
        asOf: '2026-05-13T14:59:59.000Z',
        recordedAt: '2026-05-13T14:59:59.500Z',
        details: { window: '15m' },
      },
    ])

    const response = await getQuantAccountWitnessHandler(
      new Request(
        'http://localhost/api/torghut/trading/control-plane/quant/account-witness?strategy_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&account=paper&account_alias=paper-main&account_aliases=paper-shadow&window=15m',
      ),
    )

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.witness.account_aliases).toEqual(['paper', 'paper-main', 'paper-shadow'])
    expect(body.witness.strategy_scope).toEqual({
      strategy_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      scope: 'strategy',
    })
    expect(body.witness.account_latest_store.status).toBe('current')
    expect(body.witness.pipeline_health.status).toBe('current')
    expect(body.witness.route_warrant_usability).toEqual({
      state: 'current',
      reason_codes: [],
      target_value_gates: ['zero_notional_or_stale_evidence_rate', 'routeable_candidate_count', 'capital_gate_safety'],
    })
    expect(body.witness.capital_safety).toEqual({
      max_notional: '0',
      can_clear_routeability: true,
      reason_codes: ['zero_notional_quant_witness_only'],
    })
  })
})
