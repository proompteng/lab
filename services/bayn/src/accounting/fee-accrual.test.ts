import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'
import { checkProperty } from '../testing/property-test-support'
import { prepareFeeAccrual } from './fee-accrual'
const coin = {
  schemaVersion: 'bayn.broker-fee-accrual.v1',
  kind: 'COIN',
  accountId: 'paper-fixture',
  symbol: 'ETH/USD',
  date: '2026-10-14',
  cycleId: 'a'.repeat(64),
  positionSnapshotId: 'b'.repeat(64),
  observedAt: '2026-10-14T22:23:52.417Z',
  projectedQuantityAtoms: '33050000',
  observedQuantityAtoms: '32967375',
  projectedCostMicros: '80156496',
  observedCostMicros: '79956104',
  sourceTrades: [{ transactionId: 'c'.repeat(64), quantityAtoms: '33050000', priceAtoms: '2425310000000' }],
}
const cash = {
  schemaVersion: 'bayn.broker-fee-accrual.v2',
  kind: 'CASH',
  accountId: coin.accountId,
  symbol: 'USD',
  date: coin.date,
  cycleId: coin.cycleId,
  accountEventId: 'b'.repeat(64),
  openingAccountEventId: 'f'.repeat(64),
  openingCashReportingQuantumMicros: '10000',
  observedAt: coin.observedAt,
  projectedCashMicros: '99875398174',
  observedCashMicros: '99875200000',
  cashReportingQuantumMicros: '10000',
  sourceTrades: [{ transactionId: 'd'.repeat(64), quantityAtoms: '32967375', priceAtoms: '2410100000000' }],
}

test('values a later buy-fee cohort against the existing weighted inventory', () => {
  const input = {
    ...coin,
    symbol: 'SOL/USD',
    projectedQuantityAtoms: '181888126111',
    observedQuantityAtoms: '181794608107',
    projectedCostMicros: '19180256218',
    observedCostMicros: '19170394666',
    sourceTrades: [
      { transactionId: 'c'.repeat(64), quantityAtoms: '697183700', priceAtoms: '105429000000' },
      { transactionId: 'd'.repeat(64), quantityAtoms: '13921000000', priceAtoms: '105400000000' },
      { transactionId: 'e'.repeat(64), quantityAtoms: '27890000000', priceAtoms: '105400000000' },
    ],
  }
  const result = Result.getOrThrow(prepareFeeAccrual(input, 7001))
  expect(result.coinQuantityAtoms).toBe('93518004')
  expect(result.expenseMicros).toBe('9861552')
  expect(Result.isFailure(prepareFeeAccrual({ ...input, observedCostMicros: '19170394656' }, 7001))).toBe(true)
  expect(Result.isFailure(prepareFeeAccrual({ ...input, observedQuantityAtoms: '181781855648' }, 7001))).toBe(true)
})

test('property: native crypto coin fees conserve observed inventory and replay the same ledger identity', () => {
  checkProperty(
    'crypto-coin-fee-conservation',
    fc.property(
      fc.constantFrom('BTC/USD', 'ETH/USD', 'SOL/USD'),
      fc.bigInt({ min: 400n, max: 10_000_000_000n }),
      fc.bigInt({ min: 1_000_000_000_000n, max: 100_000_000_000_000_000n }),
      (symbol, quantity, price) => {
        const feeQuantity = quantity / 400n
        const cost = (quantity * price) / 1_000_000_000_000n
        const expense = (feeQuantity * price) / 1_000_000_000_000n
        const input = {
          ...coin,
          symbol,
          projectedQuantityAtoms: quantity.toString(),
          observedQuantityAtoms: (quantity - feeQuantity).toString(),
          projectedCostMicros: cost.toString(),
          observedCostMicros: (cost - expense).toString(),
          sourceTrades: [
            { transactionId: 'c'.repeat(64), quantityAtoms: quantity.toString(), priceAtoms: price.toString() },
          ],
        }
        const result = Result.getOrThrow(prepareFeeAccrual(input, 7001))
        expect(
          BigInt(result.coinQuantityAtoms ?? '0') +
            BigInt(result.data.kind === 'COIN' ? result.data.observedQuantityAtoms : '0'),
        ).toBe(quantity)
        expect(result.expenseMicros).toBe(expense.toString())
        expect(result.plan.transfers.map((transfer) => transfer.amount)).toEqual([expense])
        const replay = Result.getOrThrow(
          prepareFeeAccrual(
            { ...input, positionSnapshotId: 'e'.repeat(64), observedAt: '2026-10-15T02:02:00.000Z' },
            7001,
          ),
        )
        expect(replay.accrualId).toBe(result.accrualId)
        expect(replay.plan).toEqual(result.plan)
        expect(
          Result.isFailure(
            prepareFeeAccrual({ ...input, sourceTrades: [input.sourceTrades[0], input.sourceTrades[0]] }, 7001),
          ),
        ).toBe(true)
        const excessiveFee = (quantity + 399n) / 400n + 1n
        expect(
          Result.isFailure(
            prepareFeeAccrual({ ...input, observedQuantityAtoms: (quantity - excessiveFee).toString() }, 7001),
          ),
        ).toBe(true)
      },
    ),
  )
})

test('property: crypto cash fee retries retain one ledger debit and reject unsupported cash discrepancies', () => {
  checkProperty(
    'crypto-cash-fee-boundaries',
    fc.property(
      fc.bigInt({ min: 1n, max: 1_000_000n }),
      fc.bigInt({ min: 1n, max: 100_000n }),
      fc.constantFrom('1' as const, '10000' as const),
      fc.constantFrom('1' as const, '10000' as const),
      (lots, dollars, quantum, openingQuantum) => {
        const quantity = lots * 4_000_000_000n
        const expense = lots * dollars * 10_000n
        const observedCash = 100_000_000_000_000n
        const input = {
          ...cash,
          openingCashReportingQuantumMicros: openingQuantum,
          cashReportingQuantumMicros: quantum,
          projectedCashMicros: (observedCash + expense).toString(),
          observedCashMicros: observedCash.toString(),
          sourceTrades: [
            {
              transactionId: 'd'.repeat(64),
              quantityAtoms: quantity.toString(),
              priceAtoms: (dollars * 1_000_000_000n).toString(),
            },
          ],
        }
        const result = Result.getOrThrow(prepareFeeAccrual(input, 7001))
        expect(result.cashDebitMicros).toBe(expense.toString())
        expect(result.plan.transfers.map((transfer) => transfer.amount)).toEqual([expense])
        const replay = Result.getOrThrow(prepareFeeAccrual({ ...input, accountEventId: 'e'.repeat(64) }, 7001))
        expect(replay.accrualId).toBe(result.accrualId)
        expect(replay.plan).toEqual(result.plan)
        const beyondBound = observedCash - BigInt(quantum) - BigInt(openingQuantum) - 1n
        expect(
          Result.isFailure(prepareFeeAccrual({ ...input, observedCashMicros: beyondBound.toString() }, 7001)),
        ).toBe(true)
        expect(Result.isFailure(prepareFeeAccrual({ ...input, observedCashMicros: '-1' }, 7001))).toBe(true)
        expect(
          Result.isFailure(
            prepareFeeAccrual({ ...input, sourceTrades: [input.sourceTrades[0], input.sourceTrades[0]] }, 7001),
          ),
        ).toBe(true)
      },
    ),
  )
})
test('the captured ETH net position proves the coin debit without estimating a fee', () => {
  const result = Result.getOrThrow(prepareFeeAccrual(coin, 7001))
  expect(result.coinQuantityAtoms).toBe('82625')
  expect(result.cashDebitMicros).toBeNull()
  expect(result.expenseMicros).toBe('200392')
  expect(result.plan.transfers.map((t) => t.amount)).toEqual([200392n])
  const replay = Result.getOrThrow(
    prepareFeeAccrual({ ...coin, positionSnapshotId: 'e'.repeat(64), observedAt: '2026-10-14T22:24:52.417Z' }, 7001),
  )
  expect(replay.accrualId).toBe(result.accrualId)
  expect(replay.plan).toEqual(result.plan)
})
test('a sell accrues the observed USD debit at the broker reporting precision', () => {
  const result = Result.getOrThrow(prepareFeeAccrual(cash, 7001))
  expect(result.cashDebitMicros).toBe('200000')
  expect(result.coinQuantityAtoms).toBeNull()
  expect(result.plan.transfers.map((t) => t.amount)).toEqual([200000n])
})
test('the captured ETH close admits both cash reporting boundaries without estimating the fee', () => {
  const observed = {
    ...cash,
    projectedCashMicros: '99875376976',
    observedCashMicros: '99875170000',
    sourceTrades: [{ transactionId: 'd'.repeat(64), quantityAtoms: '32967375', priceAtoms: '2409457000000' }],
  }
  const result = Result.getOrThrow(prepareFeeAccrual(observed, 7001))
  expect(result.cashDebitMicros).toBe('210000')
  expect(result.plan.transfers.map((transfer) => transfer.amount)).toEqual([210000n])
  expect(Result.isFailure(prepareFeeAccrual({ ...observed, observedCashMicros: '99875160000' }, 7001))).toBe(true)
  const replay = Result.getOrThrow(
    prepareFeeAccrual({ ...observed, accountEventId: 'e'.repeat(64), observedAt: '2026-10-15T02:02:00.000Z' }, 7001),
  )
  expect(replay.accrualId).toBe(result.accrualId)
  expect(replay.plan).toEqual(result.plan)
})
test('a more precise closing report retains the possible cent precision of its opening balance', () => {
  const observed = {
    ...cash,
    projectedCashMicros: '99875376976',
    observedCashMicros: '99875168397',
    cashReportingQuantumMicros: '1',
    sourceTrades: [{ transactionId: 'd'.repeat(64), quantityAtoms: '32967375', priceAtoms: '2409457000000' }],
  }
  expect(Result.getOrThrow(prepareFeeAccrual(observed, 7001)).cashDebitMicros).toBe('208579')
  expect(
    Result.getOrThrow(prepareFeeAccrual({ ...observed, observedCashMicros: '99875168391' }, 7001)).cashDebitMicros,
  ).toBe('208585')
  expect(Result.isFailure(prepareFeeAccrual({ ...observed, observedCashMicros: '99875168390' }, 7001))).toBe(true)
  expect(Result.isFailure(prepareFeeAccrual({ ...observed, openingCashReportingQuantumMicros: '1' }, 7001))).toBe(true)
})
for (const change of [
  { symbol: 'AAPL' },
  { observedQuantityAtoms: '32000000' },
  { observedQuantityAtoms: '33050000' },
  { observedQuantityAtoms: '33050001' },
  { observedCostMicros: '70000000' },
  { observedCostMicros: '80156497' },
  { sourceTrades: [] },
  { sourceTrades: [coin.sourceTrades[0], coin.sourceTrades[0]] },
])
  test(`rejects unbound coin evidence ${JSON.stringify(change)}`, () =>
    expect(Result.isFailure(prepareFeeAccrual({ ...coin, ...change }, 7001))).toBe(true))
for (const change of [
  { observedCashMicros: '99874000000' },
  { observedCashMicros: '99875400000' },
  { observedCashMicros: '99875200001' },
  { observedCashMicros: '-1' },
  { sourceTrades: [] },
])
  test(`rejects unbound cash evidence ${JSON.stringify(change)}`, () =>
    expect(Result.isFailure(prepareFeeAccrual({ ...cash, ...change }, 7001))).toBe(true))
