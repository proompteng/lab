import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'

import { segmentCompanySymbols } from '~/lib/company-symbols'
import type { CompanyProfile } from '~/server/company'

import { CompanyProfileView } from './$symbol'

const company: CompanyProfile = {
  symbol: 'NVDA',
  companyName: 'NVIDIA Corporation',
  exchange: 'NASDAQ',
  category: 'Common Stock',
  sector: 'Technology',
  industry: 'Semiconductors',
  ceo: 'Jensen Huang',
  employees: 42000,
  headquarters: 'Santa Clara, California',
  address: '2788 San Tomas Expressway, Santa Clara, CA 95051',
  establishedAt: '1993',
  incorporatedAt: null,
  description: 'Accelerated computing and AI infrastructure company.',
  dataSources: [
    {
      name: 'Webull',
      url: null,
      retrievedAt: '2026-05-26T20:00:00.000Z',
      fields: ['companyName', 'description'],
    },
  ],
  quoteContext: {
    source: 'Alpaca Market Data',
    price: 123.45,
    bid: 123.4,
    ask: 123.5,
    timestamp: '2026-05-26T19:59:00.000Z',
    retrievedAt: '2026-05-26T20:00:00.000Z',
  },
  updatedAt: '2026-05-26T20:00:00.000Z',
  confidence: { score: 0.9, level: 'high', reasons: ['test'] },
  staleness: {
    asOf: '2026-05-26T20:00:00.000Z',
    staleAfter: '2026-06-25T20:00:00.000Z',
    stale: false,
  },
}

describe('company page rendering', () => {
  test('renders normalized company profile fields, provenance, and optional quote context', () => {
    const html = renderToStaticMarkup(<CompanyProfileView company={company} />)

    expect(html).toContain('NVIDIA Corporation')
    expect(html).toContain('Jensen Huang')
    expect(html).toContain('Source provenance')
    expect(html).toContain('Webull')
    expect(html).toContain('Optional quote context')
    expect(html).toContain('$123.45')
  })

  test('renders item ticker mentions as internal Synthesis company links', () => {
    expect(segmentCompanySymbols('NVDA and $AMD')).toEqual([
      { kind: 'symbol', text: 'NVDA', symbol: 'NVDA', href: '/companies/NVDA' },
      { kind: 'text', text: ' and ' },
      { kind: 'symbol', text: '$AMD', symbol: 'AMD', href: '/companies/AMD' },
    ])
  })
})
