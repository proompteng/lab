import { beforeEach, describe, expect, it, vi } from 'vitest'

const getDb = vi.fn()
const deleteTorghutSymbol = vi.fn()
const setTorghutSymbolEnabled = vi.fn()

vi.mock('~/server/db', () => ({
  getDb,
}))

vi.mock('~/server/torghut-symbols', () => ({
  deleteTorghutSymbol,
  setTorghutSymbolEnabled,
}))

describe('torghut symbol handlers', () => {
  beforeEach(() => {
    getDb.mockReset()
    deleteTorghutSymbol.mockReset()
    setTorghutSymbolEnabled.mockReset()
    getDb.mockReturnValue({} as never)
  })

  it('returns 404 when deleting a missing symbol', async () => {
    deleteTorghutSymbol.mockResolvedValueOnce(0)
    const { deleteSymbolHandler } = await import('./$symbol')

    const response = await deleteSymbolHandler(
      'MISSING',
      new Request('http://localhost/api/torghut/symbols/MISSING?assetClass=crypto'),
    )

    expect(response.status).toBe(404)
    expect(deleteTorghutSymbol).toHaveBeenCalledWith({ db: {}, symbol: 'MISSING', assetClass: 'crypto' })
    await expect(response.json()).resolves.toEqual({ error: 'MISSING was not found' })
  })

  it('returns deleted count on success', async () => {
    deleteTorghutSymbol.mockResolvedValueOnce(1)
    const { deleteSymbolHandler } = await import('./$symbol')

    const response = await deleteSymbolHandler('AAPL', new Request('http://localhost/api/torghut/symbols/AAPL'))

    expect(response.status).toBe(200)
    expect(deleteTorghutSymbol).toHaveBeenCalledWith({ db: {}, symbol: 'AAPL', assetClass: undefined })
    await expect(response.json()).resolves.toEqual({ ok: true, deleted: 1 })
  })
})
