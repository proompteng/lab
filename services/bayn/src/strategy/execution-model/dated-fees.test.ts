import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { cryptoMaximumTakerFeeBps } from '../../broker/crypto-fees'
import { intradayExecutionModel, retainedIntradayExecutionModel } from '../intraday-market'
import { calculateSessionFees, equityTafRate } from './fees'

const sale = [
  { symbol: 'AAPL', side: 'sell' as const, quantityAtoms: 1000_000_000_000n, notionalMicros: 100_000_000_000n },
]

test.each([
  ['2026-09-30', 200000n],
  ['2026-10-01', 0n],
  ['2026-12-31', 0n],
  ['2027-01-01', 200000n],
  ['2027-01-01T04:59:59.000Z', 0n],
  ['2027-01-01T05:00:00.000Z', 200000n],
  ['2028-12-31', 200000n],
  ['2026-10-01T03:59:59.000Z', 200000n],
  ['2026-10-01T04:00:00.000Z', 0n],
])('equity TAF uses the New York execution date %s', (at, expected) => {
  const fees = Result.getOrThrow(
    calculateSessionFees(sale, intradayExecutionModel, 1_000_000n, cryptoMaximumTakerFeeBps, at),
  )
  expect(fees.tafMicros).toBe(expected)
  expect(fees.secMicros).toBeGreaterThan(0n)
  expect(fees.catMicros).toBeGreaterThan(0n)
})

test('retained fixed schedules reproduce original fees during the pause', () => {
  expect(
    Result.getOrThrow(
      calculateSessionFees(sale, retainedIntradayExecutionModel, 1_000_000n, cryptoMaximumTakerFeeBps, '2026-11-01'),
    ).tafMicros,
  ).toBe(200000n)
})

test.each(['2026-06-30', '2029-01-01', '2026-09-31', 'not-a-date'])(
  'unverified equity dates %s fail instead of inventing a tariff',
  (at) => {
    expect(Result.isFailure(equityTafRate(intradayExecutionModel, at))).toBe(true)
  },
)
