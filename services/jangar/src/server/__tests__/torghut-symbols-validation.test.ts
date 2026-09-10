import { describe, expect, it } from 'vitest'

import { isValidTorghutSymbol } from '~/server/torghut-symbols'

describe('isValidTorghutSymbol', () => {
  it('accepts valid equity symbols and rejects malformed values', () => {
    expect(isValidTorghutSymbol('AAPL', 'equity')).toBe(true)
    expect(isValidTorghutSymbol('BRK.B', 'equity')).toBe(true)
    expect(isValidTorghutSymbol('BRK-B', 'equity')).toBe(true)

    expect(isValidTorghutSymbol('BTC/USD', 'equity')).toBe(false)
    expect(isValidTorghutSymbol('AAPL;', 'equity')).toBe(false)
  })

  it('accepts valid crypto symbols and rejects unsupported forms', () => {
    expect(isValidTorghutSymbol('BTC/USD', 'crypto')).toBe(true)
    expect(isValidTorghutSymbol('ETH-USD', 'crypto')).toBe(true)
    expect(isValidTorghutSymbol('ADA-USDT', 'crypto')).toBe(true)

    expect(isValidTorghutSymbol('AAPL', 'crypto')).toBe(false)
    expect(isValidTorghutSymbol('BTCUSD', 'crypto')).toBe(false)
    expect(isValidTorghutSymbol('DOGE28384-USD', 'crypto')).toBe(false)
    expect(isValidTorghutSymbol('BTC-PLN', 'crypto')).toBe(false)
  })
})
