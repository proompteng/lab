import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { assessEntryTurnoverReserve } from './turnover-reserve'

const input = {
  filledTurnoverMicros: 160_000_000_000n,
  maximumTurnoverMicros: 200_000_000_000n,
  otherReservedMicros: 0n,
  quantityMicros: 200_000_000n,
  entryLimitPriceMicros: 100_000_000n,
  exitReferencePriceMicros: 100_000_000n,
  exitAllowanceBps: 0n,
}

test('reserves both filled-entry upper bound and expected liquidation, including exact boundaries', () => {
  const exact = Result.getOrThrow(assessEntryTurnoverReserve(input))
  expect(exact.admitted).toBe(true)
  expect(exact.projectedTurnoverMicros).toBe(200_000_000_000n)
  expect(exact.remainingMicros).toBe(0n)
  expect(Result.getOrThrow(assessEntryTurnoverReserve({ ...input, otherReservedMicros: 1n })).admitted).toBe(false)
  expect(Result.getOrThrow(assessEntryTurnoverReserve({ ...input, exitAllowanceBps: 1n })).admitted).toBe(false)
})

test('a partial fill supports only its actual smaller inventory; unsettled commitments remain separately reserved', () => {
  const partial = Result.getOrThrow(assessEntryTurnoverReserve({ ...input, quantityMicros: 100_000_000n }))
  expect(partial.expectedExitMicros).toBe(10_000_000_000n)
  expect(partial.remainingMicros).toBe(20_000_000_000n)
  const pending = Result.getOrThrow(
    assessEntryTurnoverReserve({ ...input, quantityMicros: 100_000_000n, otherReservedMicros: 20_000_000_001n }),
  )
  expect(pending.admitted).toBe(false)
})

test('rounds fractional notional upward and fails invalid reserve inputs', () => {
  const fractional = Result.getOrThrow(
    assessEntryTurnoverReserve({
      ...input,
      quantityMicros: 1n,
      entryLimitPriceMicros: 1n,
      exitReferencePriceMicros: 1n,
    }),
  )
  expect(fractional.entryMicros).toBe(1n)
  expect(fractional.expectedExitMicros).toBe(1n)
  expect(Result.isFailure(assessEntryTurnoverReserve({ ...input, quantityMicros: -1n }))).toBe(true)
  expect(Result.isFailure(assessEntryTurnoverReserve({ ...input, entryLimitPriceMicros: 0n }))).toBe(true)
})
