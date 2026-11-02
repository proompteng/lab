import { expect, test } from 'bun:test'
import { Result } from 'effect'
import fc from 'fast-check'

import { AccountCode, hashLedgerPlanResult, TransferCode } from '../ledger-plan'
import { checkProperty } from '../testing/property-test-support'
import { prepareCashSettlement, verifyCashSettlement } from './cash-settlement'

const source = {
  schemaVersion: 'bayn.broker-cash-settlement.v1',
  accountId: 'paper-settlement',
  transactionId: 'a'.repeat(64),
  transactionContentHash: 'b'.repeat(64),
  brokerEventId: 'c'.repeat(64),
  cashDeltaMicros: '-100004900',
  cashReportingQuantumMicros: '10000',
  precisionAccountEventId: 'd'.repeat(64),
  observedAt: '2026-10-16T01:00:00.000Z',
  occurredAt: '2026-10-16T00:59:00.000Z',
}

test('cash settlement preserves the original precise fill and posts its cent rounding separately', () => {
  const prepared = Result.getOrThrow(prepareCashSettlement(source, 7001))
  expect(prepared.data.cashDeltaMicros).toBe('-100004900')
  expect(prepared.settledCashDeltaMicros).toBe('-100000000')
  expect(prepared.roundingDeltaMicros).toBe('4900')
  expect(prepared.plan.transfers).toHaveLength(1)
  const transfer = prepared.plan.transfers[0]
  expect(transfer?.code).toBe(TransferCode.cashRoundingIncome)
  expect(transfer?.amount).toBe(4900n)
  expect(prepared.plan.accounts.find((account) => account.id === transfer?.debit_account_id)?.code).toBe(
    AccountCode.cash,
  )
  expect(prepared.plan.accounts.find((account) => account.id === transfer?.credit_account_id)?.code).toBe(
    AccountCode.cashRoundingIncome,
  )
  const expense = Result.getOrThrow(prepareCashSettlement({ ...source, cashDeltaMicros: '100004900' }, 7001))
  expect(expense.roundingDeltaMicros).toBe('-4900')
  expect(expense.plan.transfers[0]?.code).toBe(TransferCode.cashRoundingExpense)
  expect(
    Result.getOrThrow(prepareCashSettlement({ ...source, cashReportingQuantumMicros: '1' }, 7001)).plan.transfers,
  ).toEqual([])
})

test('cash settlement cannot take a desired balance or an earlier precision observation', () => {
  expect(Result.isFailure(prepareCashSettlement({ ...source, observedCashMicros: '100000000000' }, 7001))).toBe(true)
  expect(Result.isFailure(prepareCashSettlement({ ...source, observedAt: '2026-10-16T00:58:00.000Z' }, 7001))).toBe(
    true,
  )
  expect(Result.isFailure(prepareCashSettlement({ ...source, cashReportingQuantumMicros: '1000000' }, 7001))).toBe(true)
})

test('retries preserve transfer identity and reject changed stored economic evidence', () => {
  const prepared = Result.getOrThrow(prepareCashSettlement(source, 7001))
  const retry = Result.getOrThrow(prepareCashSettlement({ ...source, observedAt: '2026-10-16T01:01:00.000Z' }, 7001))
  expect(retry.settlementId).toBe(prepared.settlementId)
  expect(retry.plan).toEqual(prepared.plan)
  const record = {
    settlement_id: prepared.settlementId,
    data: prepared.data,
    rounding_delta_micros: prepared.roundingDeltaMicros,
    content_hash: prepared.contentHash,
    ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(prepared.plan)),
    tigerbeetle_cluster_id: '2001',
    tigerbeetle_ledger: 7001,
    posted: true,
  }
  expect(Result.isSuccess(verifyCashSettlement(record, source.accountId, { clusterId: 2001n, ledger: 7001 }))).toBe(
    true,
  )
  expect(
    Result.isFailure(
      verifyCashSettlement({ ...record, rounding_delta_micros: '4901' }, source.accountId, {
        clusterId: 2001n,
        ledger: 7001,
      }),
    ),
  ).toBe(true)
  expect(Result.isFailure(verifyCashSettlement(record, 'other-paper', { clusterId: 2001n, ledger: 7001 }))).toBe(true)
  expect(Result.isFailure(verifyCashSettlement(record, source.accountId, { clusterId: 2002n, ledger: 7001 }))).toBe(
    true,
  )
})

test('property: cash settlement conserves every fill and never transfers more than its exact rounding', () => {
  checkProperty(
    'broker-cash-settlement',
    fc.property(
      fc.bigInt({ min: -(2n ** 100n), max: 2n ** 100n }),
      fc.constantFrom('1' as const, '10' as const, '100' as const, '1000' as const, '10000' as const),
      (cashDelta, quantum) => {
        const prepared = Result.getOrThrow(
          prepareCashSettlement(
            { ...source, cashDeltaMicros: cashDelta.toString(), cashReportingQuantumMicros: quantum },
            7001,
          ),
        )
        const rounding = BigInt(prepared.roundingDeltaMicros)
        expect(cashDelta + rounding).toBe(BigInt(prepared.settledCashDeltaMicros))
        expect(BigInt(prepared.settledCashDeltaMicros) % BigInt(quantum)).toBe(0n)
        expect(rounding < 0n ? -rounding : rounding).toBeLessThanOrEqual(BigInt(quantum) / 2n)
        expect(prepared.plan.transfers.reduce((sum, transfer) => sum + transfer.amount, 0n)).toBe(
          rounding < 0n ? -rounding : rounding,
        )
        if (rounding !== 0n)
          expect(prepared.plan.transfers[0]?.code).toBe(
            rounding > 0n ? TransferCode.cashRoundingIncome : TransferCode.cashRoundingExpense,
          )
      },
    ),
  )
})
