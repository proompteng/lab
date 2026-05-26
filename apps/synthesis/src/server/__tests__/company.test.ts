import { afterEach, describe, expect, test } from 'vitest'

import { handleGetCompany } from '../api'
import { setCompanyDataProviderForTests } from '../company'

describe('company analysis API', () => {
  afterEach(() => {
    setCompanyDataProviderForTests(null)
  })

  test('fails closed when live market data provider is not configured', async () => {
    const response = await handleGetCompany(new Request('http://synthesis.test/api/companies/NVDA'), 'NVDA')
    const payload = await response.json()

    expect(response.status).toBe(503)
    expect(payload.error).toContain('not configured')
  })

  test('returns provider-backed company identity, fundamental, technical, and financial analysis', async () => {
    setCompanyDataProviderForTests({
      async getCompanyAnalysis(symbol) {
        return {
          symbol,
          identity: {
            name: 'NVIDIA Corporation',
            exchange: 'NASDAQ',
            sector: 'Technology',
            industry: 'Semiconductors',
            description: 'Provider-backed fixture for tests only.',
          },
          fundamentals: [{ label: 'Market cap', value: '$3.1T' }],
          technicals: [{ label: 'RSI 14D', value: '55.4' }],
          financials: [{ label: 'Revenue TTM', value: '$96B' }],
          source: 'test-provider',
          updatedAt: '2026-05-26T00:00:00.000Z',
        }
      },
    })

    const response = await handleGetCompany(new Request('http://synthesis.test/api/companies/NVDA'), 'NVDA')
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(payload.company.identity.name).toBe('NVIDIA Corporation')
    expect(payload.company.fundamentals).toHaveLength(1)
    expect(payload.company.technicals).toHaveLength(1)
    expect(payload.company.financials).toHaveLength(1)
  })
})
