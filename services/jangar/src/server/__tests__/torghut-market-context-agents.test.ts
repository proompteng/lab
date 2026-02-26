import { describe, expect, it, vi } from 'vitest'

vi.mock('~/server/db', () => ({
  getDb: () => null,
}))

describe('torghut market context agents', () => {
  it('does not stamp missing provider context with current as-of', async () => {
    const { getMarketContextProviderResult } = await import('../torghut-market-context-agents')

    const result = await getMarketContextProviderResult({
      domain: 'fundamentals',
      symbolInput: 'AAPL',
    })

    expect(result.snapshotState).toBe('missing')
    expect(result.context.asOfUtc).toBe('')
    expect(result.dispatch.reason).toBe('database_unavailable')
  })
})
