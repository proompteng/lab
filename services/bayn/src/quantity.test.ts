import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { quantityFromDecimal, quantityToDecimal } from './quantity'

test('one exact quantity scale represents equity shares and native crypto quantities', () => {
  for (const [decimal, atoms] of [
    ['12', 12_000_000_000n],
    ['0.000000001', 1n],
    ['0.000407157', 407_157n],
    ['-0.000000001', -1n],
  ] as const) {
    expect(Result.getOrThrow(quantityFromDecimal(decimal))).toBe(atoms)
    expect(quantityToDecimal(atoms)).toBe(decimal)
  }
  expect(Result.getOrThrow(quantityFromDecimal('1.000000000000'))).toBe(1_000_000_000n)
})

test('quantity parsing rejects malformed values and precision loss', () => {
  for (const value of ['01', '+1', '1e-9', 'NaN', '0.0000000001'])
    expect(Result.isFailure(quantityFromDecimal(value))).toBe(true)
})
