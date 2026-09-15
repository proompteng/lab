import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveTorghutDb = vi.fn()
const listTorghutWhitepapers = vi.fn()

vi.mock('~/server/torghut-trading-db', () => ({
  resolveTorghutDb,
}))

vi.mock('~/server/torghut-whitepapers', () => ({
  listTorghutWhitepapers,
}))

describe('getWhitepapersHandler', () => {
  beforeEach(() => {
    resolveTorghutDb.mockReset()
    listTorghutWhitepapers.mockReset()
  })

  it('returns 503 when Torghut DB is disabled', async () => {
    resolveTorghutDb.mockReturnValueOnce({ ok: false, disabled: true, message: 'db disabled' })

    const { getWhitepapersHandler } = await import('./index')
    const response = await getWhitepapersHandler(new Request('http://localhost/api/whitepapers/'))

    expect(response.status).toBe(503)
    expect(listTorghutWhitepapers).not.toHaveBeenCalled()

    const body = await response.json()
    expect(body).toEqual({ ok: false, disabled: true, message: 'db disabled' })
  })

  it('returns list payload with parsed filters', async () => {
    const pool = {}
    resolveTorghutDb.mockReturnValueOnce({ ok: true, pool })
    listTorghutWhitepapers.mockResolvedValueOnce({
      items: [{ runId: 'wp-1' }],
      total: 1,
      limit: 30,
      offset: 0,
    })

    const { getWhitepapersHandler } = await import('./index')
    const response = await getWhitepapersHandler(
      new Request('http://localhost/api/whitepapers/?q=janus&status=completed&verdict=implement&limit=20&offset=5'),
    )

    expect(response.status).toBe(200)
    expect(listTorghutWhitepapers).toHaveBeenCalledWith({
      pool,
      query: 'janus',
      status: 'completed',
      verdict: 'implement',
      limit: 20,
      offset: 5,
    })

    const body = await response.json()
    expect(body).toEqual({
      ok: true,
      items: [{ runId: 'wp-1' }],
      total: 1,
      limit: 30,
      offset: 0,
    })
  })
})
