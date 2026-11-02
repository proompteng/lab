import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { nativeJevFixture } from '../jev/native.test-support'
import { JevPurpose, jevManagedExitPlan } from '../jev/portfolio'
import { alpacaEntryProtectionMethod, decidePositionProtection, type ProtectionOrderState } from './position-protection'

const fixture = nativeJevFixture(JevPurpose.Manage)
if (fixture.portfolio.purpose !== JevPurpose.Manage) throw new Error('Expected a held position')
const plan = Result.getOrThrow(jevManagedExitPlan(fixture.portfolio))
const observedAt = '2026-10-19T15:00:00.000Z'
const armed: ProtectionOrderState = {
  _tag: 'Armed',
  intentId: 'protection',
  method: 'OCO',
  quantityAtoms: 5_000_000_000n,
  stopPriceMicros: BigInt(plan.levels.stopPriceMicros),
  stopLimitPriceMicros: BigInt(plan.levels.stopLimitPriceMicros),
  profitLimitPriceMicros: BigInt(plan.levels.profitLimitPriceMicros),
}
const input = {
  plan,
  entry: { _tag: 'Settled' as const },
  quantityAtoms: 5_000_000_000n,
  protection: armed,
  exitDue: false,
  observedAt,
}

test('broker capabilities distinguish crypto, regular whole shares, fractions and extended hours', () => {
  expect(alpacaEntryProtectionMethod('BTC/USD', 1n, observedAt)).toBe('STOP_LIMIT')
  expect(alpacaEntryProtectionMethod('AAPL', 5_000_000_000n, observedAt)).toBe('BRACKET')
  expect(alpacaEntryProtectionMethod('AAPL', 500_000_000n, observedAt)).toBe('STOP_LIMIT')
  expect(alpacaEntryProtectionMethod('AAPL', 5_000_000_000n, '2026-10-19T22:00:00.000Z')).toBe('APPLICATION')
})

test('an unknown submission or cancellation prevents every new sell', () => {
  expect(decidePositionProtection({ ...input, exitDue: true, protection: { _tag: 'Unknown', intentId: 'p' } })).toEqual(
    { _tag: 'Recover', intentId: 'p' },
  )
  expect(
    decidePositionProtection({ ...input, exitDue: true, protection: { _tag: 'Canceling', intentId: 'p' } }),
  ).toEqual({ _tag: 'Wait', reason: 'CANCEL_PENDING' })
})

test('a partial entry is canceled before protection is sized to its confirmed inventory', () => {
  expect(
    decidePositionProtection({
      ...input,
      entry: { _tag: 'Working', intentId: 'entry' },
      protection: { _tag: 'Absent' },
    }),
  ).toEqual({ _tag: 'CancelEntry', intentId: 'entry' })
  expect(decidePositionProtection({ ...input, protection: { _tag: 'Absent' } })).toEqual({
    _tag: 'Arm',
    method: 'OCO',
    quantityAtoms: 5_000_000_000n,
  })
})

test('a profit or time exit must settle existing protection before it can sell', () => {
  expect(decidePositionProtection({ ...input, exitDue: true })).toEqual({
    _tag: 'CancelProtection',
    intentId: 'protection',
  })
  expect(decidePositionProtection({ ...input, exitDue: true, protection: { _tag: 'Absent' } })).toEqual({
    _tag: 'Liquidate',
    quantityAtoms: 5_000_000_000n,
  })
})

test('fills racing a cancellation change the residual quantity instead of causing a duplicate full close', () => {
  expect(
    decidePositionProtection({
      ...input,
      exitDue: true,
      quantityAtoms: 2_000_000_000n,
      protection: { _tag: 'Absent' },
    }),
  ).toEqual({ _tag: 'Liquidate', quantityAtoms: 2_000_000_000n })
  expect(
    decidePositionProtection({ ...input, exitDue: true, quantityAtoms: 0n, protection: { _tag: 'Absent' } }),
  ).toEqual({ _tag: 'Complete' })
})

test('price tampering, quantity drift and the end of regular hours invalidate the armed claim', () => {
  expect(decidePositionProtection(input)).toEqual({ _tag: 'Wait', reason: 'PROTECTED' })
  expect(decidePositionProtection({ ...input, quantityAtoms: 4_000_000_000n })).toEqual({
    _tag: 'CancelProtection',
    intentId: 'protection',
  })
  expect(decidePositionProtection({ ...input, protection: { ...armed, stopPriceMicros: 1n } })).toEqual({
    _tag: 'CancelProtection',
    intentId: 'protection',
  })
  expect(decidePositionProtection({ ...input, observedAt: '2026-10-19T22:00:00.000Z' })).toEqual({
    _tag: 'CancelProtection',
    intentId: 'protection',
  })
})

test('a negative or unbound position never becomes completed or authorizes an extra sell', () => {
  expect(decidePositionProtection({ ...input, quantityAtoms: -1n, protection: { _tag: 'Absent' } })).toEqual({
    _tag: 'Block',
    reason: 'NEGATIVE_POSITION',
  })
  expect(decidePositionProtection({ ...input, quantityAtoms: BigInt(plan.maximumQuantityAtoms) + 1n })).toEqual({
    _tag: 'Block',
    reason: 'UNBOUND_POSITION',
  })
})
