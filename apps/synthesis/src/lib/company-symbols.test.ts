import { describe, expect, test } from 'vitest'

import { extractCompanySymbols, normalizeCompanySymbol, segmentCompanySymbols } from './company-symbols'

describe('company symbol detection', () => {
  test('links known stock symbols and cashtags without linking ordinary all-caps words', () => {
    expect(extractCompanySymbols('AI capex: $NVDA, MSFT, and AAPL matter; CPU and USA should not.')).toEqual([
      'NVDA',
      'MSFT',
      'AAPL',
    ])
  })

  test('segments linked symbols with internal company hrefs', () => {
    expect(segmentCompanySymbols('TSLA and AMD supply-chain notes')).toEqual([
      { kind: 'symbol', text: 'TSLA', symbol: 'TSLA', href: '/companies/TSLA' },
      { kind: 'text', text: ' and ' },
      { kind: 'symbol', text: 'AMD', symbol: 'AMD', href: '/companies/AMD' },
      { kind: 'text', text: ' supply-chain notes' },
    ])
  })

  test('normalizes explicit public-company ticker symbols beyond the curated extraction list', () => {
    expect(normalizeCompanySymbol('$brk.b')).toBe('BRK.B')
    expect(extractCompanySymbols('Watch $BRK.B with NVDA; USA and CPU remain plain words.')).toEqual(['BRK.B', 'NVDA'])
  })
})
