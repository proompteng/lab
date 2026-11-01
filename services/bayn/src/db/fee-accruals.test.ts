import { OrderSide } from '../execution/contracts'
import { expect, test } from 'bun:test'
import { Result } from 'effect'
import { prepareFeeAccrual } from '../accounting/fee-accrual'
import { hashLedgerPlanResult } from '../ledger-plan'
import {
  cashAccrualReportingOffsetMicros,
  feeAccrualSources,
  feeAccrualCohortSettled,
  verifyFeeAccrualRecord,
  type StoredAccrual,
} from './fee-accruals'

const accrual = (kind: 'COIN' | 'CASH', cycle: string, amount: number, matched: number): typeof StoredAccrual.Type => {
  const common = {
    schemaVersion: 'bayn.broker-fee-accrual.v1',
    accountId: 'cohort-paper',
    cycleId: cycle.repeat(64),
    date: '2026-10-14',
    observedAt: '2026-10-14T22:00:00.000Z',
    sourceTrades: [{ transactionId: cycle.repeat(64), quantityAtoms: '1000000000', priceAtoms: '100000000000' }],
  }
  const data =
    kind === 'COIN'
      ? {
          ...common,
          kind,
          symbol: 'ETH/USD',
          positionSnapshotId: 'a'.repeat(64),
          projectedQuantityAtoms: '1000000000',
          observedQuantityAtoms: String(1000000000 - amount),
          projectedCostMicros: '100000000',
          observedCostMicros: String(100000000 - amount / 10),
        }
      : {
          ...common,
          schemaVersion: 'bayn.broker-fee-accrual.v2',
          kind,
          symbol: 'USD',
          accountEventId: 'a'.repeat(64),
          openingAccountEventId: 'd'.repeat(64),
          openingCashReportingQuantumMicros: '1',
          projectedCashMicros: '100000000',
          observedCashMicros: String(100000000 - amount),
          cashReportingQuantumMicros: '1',
        }
  const prepared = Result.getOrThrow(prepareFeeAccrual(data, 7001))
  return {
    accrual_id: prepared.accrualId,
    data: prepared.data,
    settlement_date: prepared.data.date,
    content_hash: prepared.contentHash,
    coin_quantity_atoms: prepared.coinQuantityAtoms,
    cash_debit_micros: prepared.cashDebitMicros,
    expense_micros: prepared.expenseMicros,
    matched_coin_quantity_atoms: kind === 'COIN' ? String(matched) : '0',
    matched_cash_micros: kind === 'CASH' ? String(matched) : '0',
    ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(prepared.plan)),
    tigerbeetle_cluster_id: '2001',
    tigerbeetle_ledger: 7001,
    posted: true,
  }
}

test.each(['COIN', 'CASH'] as const)(
  '%s partial pooled receipt cannot qualify a different originating cycle',
  (kind) => {
    const a = accrual(kind, 'b', 100, 100)
    const partialB = accrual(kind, 'c', 200, 100)
    expect(feeAccrualCohortSettled(a, [a, partialB])).toBe(false)
    expect(feeAccrualCohortSettled(partialB, [a, partialB])).toBe(false)
    const completeB = accrual(kind, 'c', 200, 200)
    expect(feeAccrualCohortSettled(a, [a, completeB])).toBe(true)
    expect(feeAccrualCohortSettled(completeB, [a, completeB])).toBe(true)
    expect(feeAccrualCohortSettled(a, [a, { ...completeB, posted: false }])).toBe(false)
    expect(feeAccrualCohortSettled(a, [a, { ...partialB, data: { ...partialB.data, accountId: 'other-paper' } }])).toBe(
      true,
    )
  },
)

test('unaccrued directly settled sells do not contaminate a later trading date', () => {
  const rows = [
    { date: '2026-10-14', transactionId: 'old-directly-settled' },
    { date: '2026-10-15', transactionId: 'new-residual-close' },
    { date: '2026-10-15', transactionId: 'new-partial-close' },
  ]
  expect(feeAccrualSources(rows, OrderSide.Sell)).toEqual(rows.slice(1))
  expect(feeAccrualSources(rows.slice(0, 1), OrderSide.Sell)).toEqual(rows.slice(0, 1))
  expect(feeAccrualSources(rows, OrderSide.Buy)).toEqual(rows)
  expect(feeAccrualSources([], OrderSide.Sell)).toEqual([])
})

test('an unsettled cash observation carries its exact sub-cent reporting residual until the fee cohort settles', () => {
  const original = accrual('CASH', 'b', 210000, 0)
  if (original.data.kind !== 'CASH') throw new Error('Expected cash accrual')
  const data = {
    ...original.data,
    openingCashReportingQuantumMicros: '10000' as const,
    projectedCashMicros: '99875376976',
    observedCashMicros: '99875170000',
    cashReportingQuantumMicros: '10000' as const,
  }
  const stored = (value: typeof data, matched = '0', posted = true): typeof StoredAccrual.Type => {
    const prepared = Result.getOrThrow(prepareFeeAccrual(value, 7001))
    return Result.getOrThrow(
      verifyFeeAccrualRecord(
        {
          ...original,
          data: prepared.data,
          settlement_date: prepared.data.date,
          accrual_id: prepared.accrualId,
          content_hash: prepared.contentHash,
          cash_debit_micros: prepared.cashDebitMicros,
          expense_micros: prepared.expenseMicros,
          ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(prepared.plan)),
          matched_cash_micros: matched,
          posted,
        },
        'cohort-paper',
        { clusterId: 2001n, ledger: 7001 },
      ),
    )
  }
  const row = stored(data)
  expect(row.cash_debit_micros).toBe('210000')
  expect(cashAccrualReportingOffsetMicros([row])).toBe('3024')
  expect(cashAccrualReportingOffsetMicros([stored(data, '100000')])).toBe('3024')
  expect(cashAccrualReportingOffsetMicros([stored(data, '210000')])).toBe('0')
  expect(cashAccrualReportingOffsetMicros([stored(data, '0', false)])).toBe('0')
  const laterData = {
    ...data,
    cycleId: 'c'.repeat(64),
    date: '2026-10-15' as const,
    observedAt: '2026-10-15T01:00:00.000Z',
    sourceTrades: [{ ...data.sourceTrades[0], transactionId: 'c'.repeat(64) }],
    projectedCashMicros: '99900000123',
    observedCashMicros: '99899800000',
  }
  const later = stored(laterData)
  expect(cashAccrualReportingOffsetMicros([row, stored(laterData, '200000')])).toBe('3024')
  expect(cashAccrualReportingOffsetMicros([stored(data, '210000'), stored(laterData, '200000')])).toBe('0')
  expect(cashAccrualReportingOffsetMicros([row, later])).toBe('-123')
  expect(cashAccrualReportingOffsetMicros([later, row])).toBe('-123')
  expect(cashAccrualReportingOffsetMicros([row, accrual('COIN', 'd', 100, 0)])).toBe('3024')
  expect(cashAccrualReportingOffsetMicros([])).toBe('0')
})
