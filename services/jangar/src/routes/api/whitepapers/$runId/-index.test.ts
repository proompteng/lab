import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveTorghutDb = vi.fn()
const getTorghutWhitepaperDetail = vi.fn()

vi.mock('~/server/torghut-trading-db', () => ({
  resolveTorghutDb,
}))

vi.mock('~/server/torghut-whitepapers', () => ({
  getTorghutWhitepaperDetail,
}))

describe('getWhitepaperDetailHandler', () => {
  beforeEach(() => {
    resolveTorghutDb.mockReset()
    getTorghutWhitepaperDetail.mockReset()
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
})
