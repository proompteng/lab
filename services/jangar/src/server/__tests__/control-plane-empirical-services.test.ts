import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveEmpiricalServices } from '~/server/control-plane-empirical-services'

const originalEnv = { ...process.env }

const buildTorghutStatusPayload = () => ({
  forecast_service: {
    status: 'healthy',
    authority: 'empirical',
    message: 'forecast service ready',
    calibration_status: 'healthy',
    promotion_authority_eligible_models: ['chronos-prod'],
  },
  lean_authority: {
    status: 'healthy',
    authority: 'empirical',
    message: 'LEAN runner ready',
    authoritative_modes: ['shadow'],
  },
  empirical_jobs: {
    status: 'healthy',
    authority: 'empirical',
    message: 'empirical jobs fresh',
    jobs: {
      benchmark_parity: {
        promotion_authority_eligible: true,
        stale: false,
      },
    },
  },
})

const buildJsonResponse = (payload: unknown) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

describe('control-plane-empirical-services', () => {
  afterEach(() => {
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('allows a slow Torghut status response within the rollout-safe default timeout', async () => {
    vi.useFakeTimers()
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/status',
    }

    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(buildJsonResponse(buildTorghutStatusPayload())), 8000)
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = resolveEmpiricalServices()
    await vi.advanceTimersByTimeAsync(8000)
    const result = await resultPromise

    expect(fetchMock).toHaveBeenCalledWith(
      'http://torghut.torghut.svc.cluster.local/trading/status',
      expect.objectContaining({
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: expect.any(AbortSignal),
      }),
    )
    expect(result.forecast).toMatchObject({
      status: 'healthy',
      authoritative: true,
      calibration_status: 'healthy',
      eligible_models: ['chronos-prod'],
    })
    expect(result.lean).toMatchObject({
      status: 'healthy',
      authoritative: true,
      authoritative_modes: ['shadow'],
    })
    expect(result.jobs).toMatchObject({
      status: 'healthy',
      authoritative: true,
      eligible_jobs: ['benchmark_parity'],
      stale_jobs: [],
    })
  })

  it('returns degraded status when the configured Torghut status timeout expires', async () => {
    vi.useFakeTimers()
    process.env = {
      ...originalEnv,
      JANGAR_TORGHUT_STATUS_URL: 'http://torghut.torghut.svc.cluster.local/trading/status',
      JANGAR_TORGHUT_STATUS_TIMEOUT_MS: '1000',
    }

    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const signal = init?.signal
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          setTimeout(() => resolve(buildJsonResponse(buildTorghutStatusPayload())), 1500)
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const resultPromise = resolveEmpiricalServices()
    await vi.advanceTimersByTimeAsync(1000)
    const result = await resultPromise

    expect(result.forecast).toMatchObject({
      status: 'degraded',
      endpoint: 'http://torghut.torghut.svc.cluster.local/trading/status',
      message: 'torghut status unavailable',
      authoritative: false,
    })
    expect(result.lean.status).toBe('degraded')
    expect(result.jobs.status).toBe('degraded')
  })
})
