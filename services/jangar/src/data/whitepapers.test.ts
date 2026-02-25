import { afterEach, describe, expect, it, vi } from 'vitest'

import { approveWhitepaperImplementation } from './whitepapers'

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
