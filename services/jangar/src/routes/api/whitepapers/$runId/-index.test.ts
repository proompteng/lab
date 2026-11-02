import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveTorghutDb = vi.fn()
const getTorghutWhitepaperDetail = vi.fn()
const approveTorghutWhitepaperForImplementation = vi.fn()

vi.mock('~/server/torghut-trading-db', () => ({
  resolveTorghutDb,
}))

vi.mock('~/server/torghut-whitepapers', () => ({
  getTorghutWhitepaperDetail,
  approveTorghutWhitepaperForImplementation,
}))

describe('getWhitepaperDetailHandler', () => {
  beforeEach(() => {
    resolveTorghutDb.mockReset()
    getTorghutWhitepaperDetail.mockReset()
    approveTorghutWhitepaperForImplementation.mockReset()
  })

  it('returns 404 when run is missing', async () => {
    const pool = {}
    resolveTorghutDb.mockReturnValueOnce({ ok: true, pool })
    getTorghutWhitepaperDetail.mockResolvedValueOnce(null)

    const { getWhitepaperDetailHandler } = await import('./index')
    const response = await getWhitepaperDetailHandler('wp-missing')

    expect(response.status).toBe(404)
    expect(getTorghutWhitepaperDetail).toHaveBeenCalledWith({ pool, runId: 'wp-missing' })

    const body = await response.json()
    expect(body).toEqual({ ok: false, message: 'whitepaper run not found' })
  })

  it('returns detail payload for run id', async () => {
    const pool = {}
    resolveTorghutDb.mockReturnValueOnce({ ok: true, pool })
    getTorghutWhitepaperDetail.mockResolvedValueOnce({ run: { runId: 'wp-1' } })

    const { getWhitepaperDetailHandler } = await import('./index')
    const response = await getWhitepaperDetailHandler(' wp-1 ')

    expect(response.status).toBe(200)
    expect(getTorghutWhitepaperDetail).toHaveBeenCalledWith({ pool, runId: 'wp-1' })

    const body = await response.json()
    expect(body).toEqual({ ok: true, item: { run: { runId: 'wp-1' } } })
  })

  it('approves run for implementation via POST handler', async () => {
    approveTorghutWhitepaperForImplementation.mockResolvedValueOnce({ run_id: 'wp-1', status: 'completed' })
    const { approveWhitepaperImplementationHandler } = await import('./index')
    const response = await approveWhitepaperImplementationHandler(
      'wp-1',
      new Request('http://localhost/api/whitepapers/wp-1/', {
        method: 'POST',
        body: JSON.stringify({
          approvedBy: 'operator@example.com',
          approvalReason: 'Manual override after reviewing gate evidence',
          rolloutProfile: 'automatic',
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(approveTorghutWhitepaperForImplementation).toHaveBeenCalledWith({
      runId: 'wp-1',
      approvedBy: 'operator@example.com',
      approvalReason: 'Manual override after reviewing gate evidence',
      targetScope: null,
      repository: null,
      base: null,
      head: null,
      rolloutProfile: 'automatic',
    })
    const body = await response.json()
    expect(body).toEqual({ ok: true, result: { run_id: 'wp-1', status: 'completed' } })
  })

  it('validates required manual approval fields', async () => {
    const { approveWhitepaperImplementationHandler } = await import('./index')
    const response = await approveWhitepaperImplementationHandler(
      'wp-1',
      new Request('http://localhost/api/whitepapers/wp-1/', {
        method: 'POST',
        body: JSON.stringify({ approvedBy: '', approvalReason: '' }),
      }),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toEqual({ ok: false, message: 'approvedBy is required' })
  })
})
