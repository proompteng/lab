import { describe, expect, test } from 'bun:test'
import type { Account, Transfer } from 'tigerbeetle-node'

import { assertReconciled, buildLedgerPlan } from './ledger'
import { defaultProtocol } from './protocol'
import { evaluateTsmom } from './strategy'
import { makeSnapshot } from './test-fixtures'

const materializeAccounts = (plan: ReturnType<typeof buildLedgerPlan>): Account[] => {
  const balances = new Map(plan.accounts.map((account) => [account.id, { debits: 0n, credits: 0n }]))
  for (const transfer of plan.transfers) {
    balances.get(transfer.debit_account_id)!.debits += transfer.amount
    balances.get(transfer.credit_account_id)!.credits += transfer.amount
  }
  return plan.accounts.map((account) => ({
    ...account,
    debits_posted: balances.get(account.id)!.debits,
    credits_posted: balances.get(account.id)!.credits,
    timestamp: 1n,
  }))
}

const materializeTransfers = (plan: ReturnType<typeof buildLedgerPlan>): Transfer[] =>
  plan.transfers.map((transfer) => ({ ...transfer, timestamp: 1n }))

describe('TigerBeetle simulation journal', () => {
  test('plans deterministic double-entry transfers and reconciles exact sets and balances', () => {
    const snapshot = makeSnapshot()
    const result = evaluateTsmom(snapshot.bars, snapshot.manifest, defaultProtocol, 'test-revision')
    const first = buildLedgerPlan(result, 7001)
    const second = buildLedgerPlan(result, 7001)
    expect(first).toEqual(second)
    expect(first.accounts).toHaveLength(defaultProtocol.universe.length + 5)
    expect(first.transfers.length).toBeGreaterThan(1)
    expect(() => assertReconciled(first, materializeAccounts(first), materializeTransfers(first))).not.toThrow()
  })

  test('fails closed on extra transfers or mismatched balances', () => {
    const snapshot = makeSnapshot()
    const result = evaluateTsmom(snapshot.bars, snapshot.manifest, defaultProtocol, 'test-revision')
    const plan = buildLedgerPlan(result, 7001)
    const accounts = materializeAccounts(plan)
    const transfers = materializeTransfers(plan)
    expect(() =>
      assertReconciled(plan, accounts, [...transfers, { ...transfers[0], id: transfers[0].id + 1n }]),
    ).toThrow('transfer set mismatch')
    expect(() =>
      assertReconciled(
        plan,
        [{ ...accounts[0], debits_posted: accounts[0].debits_posted + 1n }, ...accounts.slice(1)],
        transfers,
      ),
    ).toThrow('balance does not reconcile exactly')
  })
})
