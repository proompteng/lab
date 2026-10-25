import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchTorghutWhitepapersSemantic = vi.fn()

vi.mock('~/server/torghut-whitepapers', () => ({
  searchTorghutWhitepapersSemantic,
}))

describe('getWhitepaperSemanticSearchHandler', () => {
  beforeEach(() => {
    searchTorghutWhitepapersSemantic.mockReset()
  })

  it('requires q parameter', async () => {
    const { getWhitepaperSemanticSearchHandler } = await import('./search')
    const response = await getWhitepaperSemanticSearchHandler(
      new Request('http://localhost/api/whitepapers/search?scope=all'),
    )

    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body).toEqual({ ok: false, message: 'q is required' })
    expect(searchTorghutWhitepapersSemantic).not.toHaveBeenCalled()
  })

  it('returns proxied search payload and parses filters', async () => {
    searchTorghutWhitepapersSemantic.mockResolvedValueOnce({
      items: [{ runId: 'wp-1', chunk: { sourceScope: 'synthesis', sectionKey: null, chunkIndex: 0, snippet: 's' } }],
      total: 1,
      limit: 15,
      offset: 3,
      query: 'alpha',
      scope: 'all',
      status: 'completed',
      subject: null,
    })

    const { getWhitepaperSemanticSearchHandler } = await import('./search')
    const response = await getWhitepaperSemanticSearchHandler(
      new Request(
        'http://localhost/api/whitepapers/search?q=alpha&limit=15&offset=3&status=completed&scope=all&subject=ml',
      ),
    )

    expect(response.status).toBe(200)
    expect(searchTorghutWhitepapersSemantic).toHaveBeenCalledWith({
      query: 'alpha',
      limit: 15,
      offset: 3,
      status: 'completed',
      scope: 'all',
      subject: 'ml',
    })

    const body = await response.json()
    expect(body).toEqual({
      ok: true,
      items: [{ runId: 'wp-1', chunk: { sourceScope: 'synthesis', sectionKey: null, chunkIndex: 0, snippet: 's' } }],
      total: 1,
      limit: 15,
      offset: 3,
      query: 'alpha',
      scope: 'all',
      status: 'completed',
      subject: null,
    })
  })

  it('maps upstream status code hints', async () => {
    searchTorghutWhitepapersSemantic.mockRejectedValueOnce(
      new Error('whitepaper_semantic_search_failed:409:whitepaper_semantic_search_disabled'),
    )

    const { getWhitepaperSemanticSearchHandler } = await import('./search')
    const response = await getWhitepaperSemanticSearchHandler(
      new Request('http://localhost/api/whitepapers/search?q=alpha'),
    )

    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body).toEqual({
      ok: false,
      message: 'whitepaper_semantic_search_failed:409:whitepaper_semantic_search_disabled',
    })
  })
})
