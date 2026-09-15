import { describe, expect, it } from 'vitest'

import {
  parseMarketContextRunIdentifier,
  resolveMarketContextRunIdentity,
} from '../torghut-market-context-run-identity'

describe('market-context run identity', () => {
  it('requires a non-empty requestId', () => {
    expect(parseMarketContextRunIdentifier(' req-1 ')).toBe('req-1')
    expect(() => parseMarketContextRunIdentifier(' ')).toThrow('requestId is required')
  })

  it('uses the stored identity when callback fields are omitted', () => {
    expect(
      resolveMarketContextRunIdentity({
        requestId: 'req-1',
        storedSymbol: 'NVDA',
        storedDomain: 'news',
        symbol: undefined,
        domain: undefined,
      }),
    ).toEqual({ symbol: 'NVDA', domain: 'news' })
  })

  it('accepts normalized callback identity fields', () => {
    expect(
      resolveMarketContextRunIdentity({
        requestId: 'req-1',
        storedSymbol: 'NVDA',
        storedDomain: 'news',
        symbol: ' nvda ',
        domain: ' NEWS ',
      }),
    ).toEqual({ symbol: 'NVDA', domain: 'news' })
  })

  it('accepts the durable batch symbol', () => {
    expect(
      resolveMarketContextRunIdentity({
        requestId: 'batch-1',
        storedSymbol: '*',
        storedDomain: 'news',
        symbol: '*',
        domain: 'news',
      }),
    ).toEqual({ symbol: '*', domain: 'news' })
  })

  it('rejects symbol reassignment for an existing requestId', () => {
    expect(() =>
      resolveMarketContextRunIdentity({
        requestId: 'req-1',
        storedSymbol: 'NVDA',
        storedDomain: 'news',
        symbol: 'AAPL',
        domain: 'news',
      }),
    ).toThrow('run identity mismatch for requestId req-1')
  })

  it('rejects retired or invalid domain overrides', () => {
    expect(() =>
      resolveMarketContextRunIdentity({
        requestId: 'req-1',
        storedSymbol: 'NVDA',
        storedDomain: 'news',
        symbol: 'NVDA',
        domain: 'fundamentals',
      }),
    ).toThrow('domain must be news')
  })
})
