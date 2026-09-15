import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { canonicalHashV1 } from '../hash'
import { hashLedgerPlanResult } from '../ledger-plan'
import { brokerFeeLedgerPlan } from './domain'
import { brokerFeePredatesOpeningCash, verifyBrokerFeeRecord, type StoredBrokerFee } from './broker-fees'

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
  read_evidence: {
    requestId: 'read-1',
    status: 200,
    contentHash: 'a'.repeat(64),
    observedAt: '2026-09-11T07:46:53.124Z',
  },
  content_hash: canonicalHashV1({ schemaVersion: 'bayn.broker-fee.v1', ...data }),
  ledger_plan_hash: planHash.success,
  tigerbeetle_cluster_id: '2001',
  tigerbeetle_ledger: 7001,
  posted: true,
}

describe('broker fee evidence verification', () => {
  test('compares fee trading dates with the opening baseline in New York', () => {
    expect(brokerFeePredatesOpeningCash(data, '2026-09-11T00:01:00.000Z')).toBe(false)
    expect(brokerFeePredatesOpeningCash(data, '2026-09-11T04:01:00.000Z')).toBe(true)
  })

  test('reconstructs the exact authoritative fee plan', () => {
    const verified = verifyBrokerFeeRecord(record, data.accountId, identity)
    expect(Result.isSuccess(verified)).toBe(true)
    if (Result.isSuccess(verified)) expect(verified.success).toEqual(plan)
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
