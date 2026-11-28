import { describe, expect, test } from 'bun:test'
import { Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../hash'
import { hashLedgerPlanResult } from '../ledger-plan'
import { brokerFeeLedgerPlan } from './domain'
import {
  brokerFeePredatesOpeningCash,
  verifyBrokerFeeRecord,
  prepareFeeMatchCorrection,
  type StoredBrokerFee,
  FeeReadEvidenceSchema,
} from './broker-fees'

const identity = { clusterId: 2001n, ledger: 7001 }
const data: StoredBrokerFee['data'] = {
  accountId: 'fee-test-account',
  activityId: 'fee-1',
  date: '2026-09-10',
  netAmountMicros: '-230000',
}
const plan = brokerFeeLedgerPlan(data.accountId, data.activityId, data.netAmountMicros, identity.ledger)
const planHash = hashLedgerPlanResult(plan)
if (Result.isFailure(planHash)) throw new Error('fee fixture hash failed')
const record: StoredBrokerFee = {
  data,
  cash_match_corrections: [],
  matched_cash_micros: '0',
  coin_cost_basis_micros: null,
  read_evidence: {
    requestId: 'read-1',
    status: 200,
    contentHash: 'a'.repeat(64),
    observedAt: '2026-09-11T07:46:53.124Z',
  },
  content_hash: Result.getOrThrow(canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...data })),
  ledger_plan_hash: planHash.success,
  tigerbeetle_cluster_id: '2001',
  tigerbeetle_ledger: 7001,
  posted: true,
}

describe('broker fee evidence verification', () => {
  test('compares fee trading dates with the opening baseline in New York', () => {
    expect(brokerFeePredatesOpeningCash(data, '2026-09-11T00:01:00.000Z')).toBe(false)
    expect(brokerFeePredatesOpeningCash(data, '2026-09-11T04:01:00.000Z')).toBe(true)
    expect(
      brokerFeePredatesOpeningCash(
        { ...data, date: '2026-09-12', cryptoCashFee: true, sourceCreatedAt: '2026-09-10T23:59:58.123456000Z' },
        '2026-09-11T00:00:00.000Z',
      ),
    ).toBe(true)
    expect(
      brokerFeePredatesOpeningCash(
        { ...data, date: '2026-09-12', cryptoCashFee: true, sourceCreatedAt: '2026-09-11T07:46:53.123999999Z' },
        '2026-09-11T07:46:53.124Z',
      ),
    ).toBe(true)
  })

  test('requires source timestamps to precede the receipt capture at full provider precision', () => {
    const decode = Schema.decodeUnknownResult(FeeReadEvidenceSchema)
    expect(
      Result.isSuccess(decode({ ...record.read_evidence, sourceCreatedAt: '2026-09-10T23:59:58.123456000Z' })),
    ).toBe(true)
    for (const sourceCreatedAt of ['2026-09-11T07:46:53.124000001Z', '2026-02-30T00:00:00.000000000Z'])
      expect(Result.isFailure(decode({ ...record.read_evidence, sourceCreatedAt }))).toBe(true)
  })

  test('reconstructs the exact authoritative fee plan', () => {
    const verified = verifyBrokerFeeRecord(record, data.accountId, identity)
    expect(Result.isSuccess(verified)).toBe(true)
    if (Result.isSuccess(verified))
      expect(verified.success).toEqual({ originalPlan: plan, corrections: [], cashDeltaMicros: data.netAmountMicros })
  })
  test('rejects changed cash amounts, ledger identities, and impossible observation dates', () => {
    for (const altered of [
      { ...record, data: { ...data, netAmountMicros: '-240000' } },
      { ...record, tigerbeetle_cluster_id: '2002' },
      { ...record, tigerbeetle_ledger: 7002 },
      { ...record, read_evidence: { ...record.read_evidence, observedAt: '2026-09-09T00:00:00.000Z' } },
      { ...record, ledger_plan_hash: 'b'.repeat(64) },
    ])
      expect(Result.isFailure(verifyBrokerFeeRecord(altered, data.accountId, identity))).toBe(true)
    expect(Result.isFailure(verifyBrokerFeeRecord(record, 'other-account', identity))).toBe(true)
  })
})

test('a non-crypto fee match is corrected with a new debit while its original plan remains immutable', () => {
  const fee = { ...data, netAmountMicros: '-1140000' }
  const originalPlan = brokerFeeLedgerPlan(fee.accountId, fee.activityId, '-930000', identity.ledger)
  const original: StoredBrokerFee = {
    ...record,
    data: fee,
    matched_cash_micros: '210000',
    content_hash: Result.getOrThrow(canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...fee })),
    ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(originalPlan)),
  }
  const correctionData = {
    schemaVersion: 'bayn.fee-match-correction.v1',
    accountId: fee.accountId,
    activityId: fee.activityId,
    accrualId: 'b'.repeat(64),
    feeContentHash: original.content_hash,
    activityCashMicros: '210000',
    accrualCashMicros: '210000',
    readEvidence: { ...record.read_evidence, observedAt: '2026-09-12T08:00:00.000Z' },
  }
  const prepared = Result.getOrThrow(prepareFeeMatchCorrection(correctionData, identity.ledger))
  const correction = {
    correction_id: prepared.correctionId,
    data: prepared.data,
    content_hash: prepared.contentHash,
    ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(prepared.plan)),
    tigerbeetle_cluster_id: identity.clusterId.toString(),
    tigerbeetle_ledger: identity.ledger,
    posted: false,
  }
  const corrected = { ...original, cash_match_corrections: [correction] }
  const verified = Result.getOrThrow(verifyBrokerFeeRecord(corrected, fee.accountId, identity))
  expect(verified.originalPlan).toEqual(originalPlan)
  expect(verified.cashDeltaMicros).toBe('-1140000')
  expect(verified.corrections[0]?.plan.transfers.map((transfer) => transfer.amount)).toEqual([210000n])
  expect(
    Result.getOrThrow(
      prepareFeeMatchCorrection(
        { ...correctionData, readEvidence: { ...correctionData.readEvidence, observedAt: '2026-09-13T08:00:00.000Z' } },
        identity.ledger,
      ),
    ).correctionId,
  ).toBe(prepared.correctionId)
  for (const invalid of [
    { ...corrected, cash_match_corrections: [correction, correction] },
    { ...corrected, cash_match_corrections: [{ ...correction, content_hash: 'c'.repeat(64) }] },
    { ...corrected, cash_match_corrections: [{ ...correction, tigerbeetle_ledger: identity.ledger + 1 }] },
    { ...corrected, data: { ...fee, cryptoCashFee: true as const } },
    { ...corrected, matched_cash_micros: '200000' },
  ])
    expect(Result.isFailure(verifyBrokerFeeRecord(invalid, fee.accountId, identity))).toBe(true)
  expect(original.cash_match_corrections).toEqual([])
  expect(original.matched_cash_micros).toBe('210000')
})

test('crypto fee dates use UTC at the baseline boundary', () => {
  expect(brokerFeePredatesOpeningCash({ ...data, cryptoCashFee: true }, '2026-09-11T00:01:00.000Z')).toBe(true)
  expect(brokerFeePredatesOpeningCash({ ...data, coinDebit: {} }, '2026-09-11T00:01:00.000Z')).toBe(true)
  expect(brokerFeePredatesOpeningCash(data, '2026-09-11T00:01:00.000Z')).toBe(false)
})

test('a rounded crypto overrelease is debited without reversing the actual receipt match', () => {
  const fee = { ...data, cryptoCashFee: true as const, netAmountMicros: '-200000' }
  const originalPlan = brokerFeeLedgerPlan(fee.accountId, fee.activityId, '10000', identity.ledger)
  const original: StoredBrokerFee = {
    ...record,
    data: fee,
    matched_cash_micros: '210000',
    content_hash: Result.getOrThrow(canonicalHashV1Result({ schemaVersion: 'bayn.broker-fee.v1', ...fee })),
    ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(originalPlan)),
  }
  const source = {
    schemaVersion: 'bayn.fee-match-correction.v2',
    accountId: fee.accountId,
    activityId: fee.activityId,
    accrualId: 'b'.repeat(64),
    feeContentHash: original.content_hash,
    activityCashMicros: '200000',
    accrualCashMicros: '210000',
    readEvidence: { ...record.read_evidence, observedAt: '2026-09-12T08:00:00.000Z' },
  }
  const prepared = Result.getOrThrow(prepareFeeMatchCorrection(source, identity.ledger))
  const correction = {
    correction_id: prepared.correctionId,
    data: prepared.data,
    content_hash: prepared.contentHash,
    ledger_plan_hash: Result.getOrThrow(hashLedgerPlanResult(prepared.plan)),
    tigerbeetle_cluster_id: identity.clusterId.toString(),
    tigerbeetle_ledger: identity.ledger,
    posted: true,
  }
  const verified = Result.getOrThrow(
    verifyBrokerFeeRecord({ ...original, cash_match_corrections: [correction] }, fee.accountId, identity),
  )
  expect(verified.originalPlan).toEqual(originalPlan)
  expect(verified.cashDeltaMicros).toBe('0')
  expect(verified.corrections[0]?.plan.transfers.map((transfer) => transfer.amount)).toEqual([10000n])
  expect(original.matched_cash_micros).toBe('210000')
  for (const invalid of [
    { ...source, activityCashMicros: '210000' },
    { ...source, activityCashMicros: '220000' },
  ])
    expect(Result.isFailure(prepareFeeMatchCorrection(invalid, identity.ledger))).toBe(true)
  expect(
    Result.isFailure(
      verifyBrokerFeeRecord({ ...original, cash_match_corrections: [correction, correction] }, fee.accountId, identity),
    ),
  ).toBe(true)
})
