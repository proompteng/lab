import { describe, expect, test } from 'bun:test'
import { Effect } from 'effect'
import type { Account, Transfer } from 'tigerbeetle-node'

import { assertReconciled, buildLedgerPlan, resolveReplicaAddresses } from './ledger'
import { evaluateTsmom } from './strategy'
import { fixtureProtocol, makeSnapshot, makeTestProvenance } from './test-fixtures'

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
    const result = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance())
    const first = buildLedgerPlan(result, 7001)
    const second = buildLedgerPlan(result, 7001)
    expect(first).toEqual(second)
    expect(first.accounts).toHaveLength(fixtureProtocol.universe.length + 5)
    expect(first.transfers.length).toBeGreaterThan(1)
    expect(() => assertReconciled(first, materializeAccounts(first), materializeTransfers(first))).not.toThrow()
  })

  test('fails closed on extra transfers or mismatched balances', () => {
    const snapshot = makeSnapshot()
    const result = evaluateTsmom(snapshot.bars, snapshot.manifest, fixtureProtocol, makeTestProvenance())
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

describe('TigerBeetle replica addresses', () => {
  test('resolves service hostnames once at startup and preserves numeric addresses', async () => {
    const lookups: string[] = []
    const addresses = await Effect.runPromise(
      resolveReplicaAddresses(
        ['torghut-tigerbeetle.torghut.svc.cluster.local:3000', '10.244.5.234:3000', '127.0.0.1', '3001'],
        (hostname) =>
          Effect.sync(() => {
            lookups.push(hostname)
            return ['10.244.5.234', '10.244.5.235']
          }),
      ),
    )

    expect(lookups).toEqual(['torghut-tigerbeetle.torghut.svc.cluster.local'])
    expect(addresses).toEqual(['10.244.5.234:3000', '10.244.5.235:3000', '127.0.0.1', '3001'])
  })

  test('rejects malformed, out-of-range, and IPv6-only endpoints', async () => {
    expect(
      Effect.runPromise(resolveReplicaAddresses(['missing-port'], () => Effect.succeed(['10.0.0.1']))),
    ).rejects.toThrow('invalid TigerBeetle replica address')
    expect(
      Effect.runPromise(resolveReplicaAddresses(['replica:70000'], () => Effect.succeed(['10.0.0.1']))),
    ).rejects.toThrow('invalid TigerBeetle replica port')
    expect(Effect.runPromise(resolveReplicaAddresses(['replica:3000'], () => Effect.succeed(['::1'])))).rejects.toThrow(
      'has no IPv4 address',
    )
    expect(Effect.runPromise(resolveReplicaAddresses(['::1']))).rejects.toThrow(
      'IPv6 TigerBeetle replica addresses are not supported',
    )
  })
})
