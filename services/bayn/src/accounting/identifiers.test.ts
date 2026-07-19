import { describe, expect, test } from 'bun:test'

import { accountId, stableU128, transferId } from './identifiers'
import { MAX_U128 } from './model'

describe('stable Bayn TigerBeetle identifiers', () => {
  test('are deterministic, non-zero u128 values with a versioned golden result', () => {
    const first = accountId('evaluation-42', 'cash')
    const second = accountId('evaluation-42', 'cash')

    expect(first).toBe(second)
    expect(first).toBeGreaterThan(0n)
    expect(first).toBeLessThanOrEqual(MAX_U128)
    expect(first.toString()).toBe('184240056657105836357110700272523287297')
  })

  test('domain-separates accounts, transfer legs, and ambiguous text parts', () => {
    const account = accountId('evaluation-42', 'cash')
    const cashLeg = transferId('evaluation-42', 'trade:7', 'cash')
    const quantityLeg = transferId('evaluation-42', 'trade:7', 'quantity')

    expect(account).not.toBe(cashLeg)
    expect(cashLeg).not.toBe(quantityLeg)
    expect(stableU128('test', ['a', 'bc'])).not.toBe(stableU128('test', ['ab', 'c']))
  })
})
