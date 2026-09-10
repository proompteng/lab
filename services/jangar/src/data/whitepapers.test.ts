import { afterEach, describe, expect, it, vi } from 'vitest'

import { approveWhitepaperImplementation, searchWhitepapersSemantic } from './whitepapers'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('approveWhitepaperImplementation', () => {
  it('returns a typed error when the request fails before a response is returned', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    const result = await approveWhitepaperImplementation('wp-1', {
      approvedBy: 'ops@example.com',
      approvalReason: 'Manual override after review',
    })

    expect(result).toEqual({
      ok: false,
      message: 'Whitepaper approval request failed (network down)',
    })
  })
})

describe('searchWhitepapersSemantic', () => {
  it('returns a typed failure when backend responds non-ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ ok: false, message: 'whitepaper_semantic_search_disabled' }),
      }),
    )

    const result = await searchWhitepapersSemantic({
      query: 'alpha',
      scope: 'all',
    })

    expect(result).toEqual({
      ok: false,
      message: 'whitepaper_semantic_search_disabled',
    })
  })

  it('returns typed success payload for semantic search', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          items: [
            {
              runId: 'wp-1',
              runStatus: 'completed',
              runCreatedAt: null,
              runCompletedAt: null,
              document: { documentKey: 'd1', title: 'Paper', sourceIdentifier: 'repo#1' },
              chunk: { sourceScope: 'synthesis', sectionKey: 'executive_summary', chunkIndex: 0, snippet: 'alpha' },
              semanticDistance: 0.2,
              lexicalScore: 0.3,
              hybridScore: 0.5,
            },
          ],
          total: 1,
          limit: 15,
          offset: 0,
          query: 'alpha',
          scope: 'all',
          status: 'completed',
          subject: null,
        }),
      }),
    )

    const result = await searchWhitepapersSemantic({
      query: 'alpha',
      scope: 'all',
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.total).toBe(1)
      expect(result.items[0]?.runId).toBe('wp-1')
    }
  })
})
