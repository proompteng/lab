import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolveTorghutDb = vi.fn()
const getTorghutWhitepaperPdfLocator = vi.fn()
const streamTorghutWhitepaperPdf = vi.fn()

vi.mock('~/server/torghut-trading-db', () => ({
  resolveTorghutDb,
}))

vi.mock('~/server/torghut-whitepapers', () => ({
  getTorghutWhitepaperPdfLocator,
  streamTorghutWhitepaperPdf,
}))

describe('getWhitepaperPdfHandler', () => {
  beforeEach(() => {
    resolveTorghutDb.mockReset()
    getTorghutWhitepaperPdfLocator.mockReset()
    streamTorghutWhitepaperPdf.mockReset()
  })

  it('returns 404 when locator is missing', async () => {
    const pool = {}
    resolveTorghutDb.mockReturnValueOnce({ ok: true, pool })
    getTorghutWhitepaperPdfLocator.mockResolvedValueOnce(null)

    const { getWhitepaperPdfHandler } = await import('./pdf')
    const response = await getWhitepaperPdfHandler('wp-missing')

    expect(response.status).toBe(404)
    expect(getTorghutWhitepaperPdfLocator).toHaveBeenCalledWith({ pool, runId: 'wp-missing' })
    expect(streamTorghutWhitepaperPdf).not.toHaveBeenCalled()

    const body = await response.json()
    expect(body).toEqual({ ok: false, message: 'whitepaper run not found' })
  })

  it('returns pdf response when stream succeeds', async () => {
    const pool = {}
    resolveTorghutDb.mockReturnValueOnce({ ok: true, pool })
    getTorghutWhitepaperPdfLocator.mockResolvedValueOnce({
      runId: 'wp-1',
      fileName: 'source.pdf',
      cephBucket: 'bucket',
      cephObjectKey: 'key',
      sourceAttachmentUrl: null,
    })
    streamTorghutWhitepaperPdf.mockResolvedValueOnce(
      new Response('pdf', {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
        },
      }),
    )

    const { getWhitepaperPdfHandler } = await import('./pdf')
    const response = await getWhitepaperPdfHandler('wp-1')

    expect(response.status).toBe(200)
    expect(streamTorghutWhitepaperPdf).toHaveBeenCalledWith({
      runId: 'wp-1',
      fileName: 'source.pdf',
      cephBucket: 'bucket',
      cephObjectKey: 'key',
      sourceAttachmentUrl: null,
    })
    expect(await response.text()).toBe('pdf')
  })
})
