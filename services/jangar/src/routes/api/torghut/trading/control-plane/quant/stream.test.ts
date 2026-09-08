import { describe, expect, it } from 'vitest'

import { matchesQuantStreamAccount } from './stream'

describe('quant stream account filtering', () => {
  it('delivers only aggregate frames when no account is requested', () => {
    expect(matchesQuantStreamAccount('', '')).toBe(true)
    expect(matchesQuantStreamAccount('', 'paper-a')).toBe(false)
  })

  it('delivers only the requested account when scoped', () => {
    expect(matchesQuantStreamAccount('paper-a', 'paper-a')).toBe(true)
    expect(matchesQuantStreamAccount('paper-a', '')).toBe(false)
    expect(matchesQuantStreamAccount('paper-a', 'paper-b')).toBe(false)
  })
})
