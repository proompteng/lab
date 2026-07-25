import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'
import { type Account, type Transfer } from 'tigerbeetle-node'

import {
  AccountCode,
  buildLedgerPlan,
  preflightTransfers,
  reconcileLedgerPlan,
  TransferCode,
  validatePersistedRunEvidence,
  type LedgerPlan,
  type LedgerValidationError,
} from './ledger-plan'
import { evaluateRiskBalancedTrend } from './risk-balanced-trend'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

const ledger = 7_001

const assertSuccess = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'ledger plan decision must succeed')
  return result.success
}

const assertFailure = <A>(result: Result.Result<A, LedgerValidationError>): LedgerValidationError => {
  assert(Result.isFailure(result), 'ledger plan decision must fail')
  return result.failure
}

const evaluationPlan = () => {
  const snapshot = makeSnapshot()
  const result = assertSuccess(
    evaluateRiskBalancedTrend(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance()),
  )
  return { result, plan: buildLedgerPlan(result, ledger) }
}

const materialize = (plan: LedgerPlan): { readonly accounts: Account[]; readonly transfers: Transfer[] } => {
  const balances = new Map(plan.accounts.map((account) => [account.id, { debits: 0n, credits: 0n }]))
  for (const transfer of plan.transfers) {
    const debit = balances.get(transfer.debit_account_id)
    const credit = balances.get(transfer.credit_account_id)
    assert(debit, `missing debit account ${transfer.debit_account_id}`)
    assert(credit, `missing credit account ${transfer.credit_account_id}`)
    debit.debits += transfer.amount
    credit.credits += transfer.amount
  }
  return {
    accounts: plan.accounts.map((account) => {
      const balance = balances.get(account.id)
      assert(balance, `missing account balance ${account.id}`)
      return {
        ...account,
        debits_posted: balance.debits,
        credits_posted: balance.credits,
        timestamp: 1n,
      }
    }),
    transfers: plan.transfers.map((transfer) => ({ ...transfer, timestamp: 1n })),
  }
}

describe('ledger plan Result algebra', () => {
  test('partitions exact existing transfers and preserves missing request order', () => {
    const { plan } = evaluationPlan()
    const existing = [plan.transfers[1], plan.transfers.at(-1)].filter(
      (transfer): transfer is Transfer => transfer !== undefined,
    )
    const missing = assertSuccess(preflightTransfers(plan.transfers, existing))

    expect(missing.map((transfer) => transfer.id)).toEqual(
      plan.transfers
        .filter((transfer) => !existing.some((present) => present.id === transfer.id))
        .map((transfer) => transfer.id),
    )

    const mismatch = assertFailure(
      preflightTransfers(plan.transfers, [{ ...plan.transfers[0], amount: plan.transfers[0].amount + 1n }]),
    )
    expect(mismatch).toMatchObject({
      operation: 'preflight-transfers',
      reason: 'record-mismatch',
      material: { id: plan.transfers[0].id },
    })
  })

  test('reconciles exact sets and posted balances without throwing assertions', () => {
    const { plan } = evaluationPlan()
    const persisted = materialize(plan)

    expect(Result.isSuccess(reconcileLedgerPlan(plan, persisted.accounts, persisted.transfers))).toBeTrue()
    expect(
      assertFailure(
        reconcileLedgerPlan(plan, persisted.accounts, [
          ...persisted.transfers,
          { ...persisted.transfers[0], id: persisted.transfers[0].id + 1n },
        ]),
      ),
    ).toMatchObject({ operation: 'reconcile', reason: 'record-set-mismatch' })
    expect(
      assertFailure(
        reconcileLedgerPlan(
          plan,
          [
            { ...persisted.accounts[0], credits_posted: persisted.accounts[0].credits_posted + 1n },
            ...persisted.accounts.slice(1),
          ],
          persisted.transfers,
        ),
      ),
    ).toMatchObject({ operation: 'reconcile', reason: 'invalid-balance' })
  })

  test('validates all locally reconstructible persisted-run metadata', () => {
    const { result, plan } = evaluationPlan()
    const persisted = materialize(plan)
    const receipt = {
      runId: result.runId,
      accountCount: persisted.accounts.length,
      transferCount: persisted.transfers.length,
      exact: true,
    } as const

    expect(
      Result.isSuccess(validatePersistedRunEvidence(receipt, ledger, persisted.accounts, persisted.transfers)),
    ).toBeTrue()

    for (const invalidAccount of [
      { ...persisted.accounts[0], code: 999 },
      { ...persisted.accounts[0], flags: 0 },
      { ...persisted.accounts[0], reserved: 1 },
      { ...persisted.accounts[0], timestamp: 0n },
    ]) {
      expect(
        assertFailure(
          validatePersistedRunEvidence(
            receipt,
            ledger,
            [invalidAccount, ...persisted.accounts.slice(1)],
            persisted.transfers,
          ),
        ),
      ).toMatchObject({ operation: 'check-run', reason: 'invalid-account-metadata' })
    }

    for (const invalidTransfer of [
      { ...persisted.transfers[0], code: 999 },
      { ...persisted.transfers[0], flags: 1 },
      { ...persisted.transfers[0], pending_id: 1n },
      { ...persisted.transfers[0], timeout: 1 },
      { ...persisted.transfers[0], timestamp: 0n },
    ]) {
      expect(
        assertFailure(
          validatePersistedRunEvidence(receipt, ledger, persisted.accounts, [
            invalidTransfer,
            ...persisted.transfers.slice(1),
          ]),
        ),
      ).toMatchObject({ operation: 'check-run', reason: 'invalid-transfer-metadata' })
    }

    const cashIndex = persisted.accounts.findIndex((account) => account.code === AccountCode.cash)
    assert.notEqual(cashIndex, -1, 'ledger plan must contain deterministic cash account')
    const cash = persisted.accounts[cashIndex]
    const changedCashId = cash.id ^ (1n << 127n)
    const invalidIdentityAccounts = persisted.accounts.map((account, index) =>
      index === cashIndex ? { ...account, id: changedCashId } : account,
    )
    const invalidIdentityTransfers = persisted.transfers.map((transfer) => ({
      ...transfer,
      debit_account_id: transfer.debit_account_id === cash.id ? changedCashId : transfer.debit_account_id,
      credit_account_id: transfer.credit_account_id === cash.id ? changedCashId : transfer.credit_account_id,
    }))
    expect(
      assertFailure(validatePersistedRunEvidence(receipt, ledger, invalidIdentityAccounts, invalidIdentityTransfers)),
    ).toMatchObject({ operation: 'check-run', reason: 'invalid-account-metadata' })

    const fundingIndex = persisted.transfers.findIndex((transfer) => transfer.code === TransferCode.funding)
    assert.notEqual(fundingIndex, -1, 'ledger plan must contain deterministic funding')
    for (const replacement of [
      { ...persisted.transfers[fundingIndex], id: persisted.transfers[fundingIndex].id ^ (1n << 127n) },
      {
        ...persisted.transfers[fundingIndex],
        user_data_128: persisted.transfers[fundingIndex].user_data_128 ^ (1n << 127n),
      },
    ]) {
      const invalidFunding = persisted.transfers.map((transfer, index) =>
        index === fundingIndex ? replacement : transfer,
      )
      expect(
        assertFailure(validatePersistedRunEvidence(receipt, ledger, persisted.accounts, invalidFunding)),
      ).toMatchObject({ operation: 'check-run', reason: 'invalid-transfer-metadata' })
    }
  })

  test('does not claim event-derived identity without the expected plan', () => {
    const { result, plan } = evaluationPlan()
    const persisted = materialize(plan)
    const eventTransferIndex = persisted.transfers.findIndex((transfer) => transfer.code !== TransferCode.funding)
    assert.notEqual(eventTransferIndex, -1, 'ledger plan must contain an event-derived transfer')
    const original = persisted.transfers[eventTransferIndex]
    const locallyConsistent = persisted.transfers.map((transfer, index) =>
      index === eventTransferIndex
        ? {
            ...transfer,
            id: original.id ^ (1n << 127n),
            user_data_128: original.user_data_128 ^ (1n << 127n),
          }
        : transfer,
    )
    const receipt = {
      runId: result.runId,
      accountCount: persisted.accounts.length,
      transferCount: persisted.transfers.length,
      exact: true,
    } as const

    expect(
      Result.isSuccess(validatePersistedRunEvidence(receipt, ledger, persisted.accounts, locallyConsistent)),
    ).toBeTrue()
    expect(Result.isFailure(reconcileLedgerPlan(plan, persisted.accounts, locallyConsistent))).toBeTrue()
  })
})
