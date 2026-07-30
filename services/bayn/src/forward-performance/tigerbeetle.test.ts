import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import type { Account, Transfer } from 'tigerbeetle-node'

import { prepareAccounting } from '../accounting/domain'
import type { RuntimeConfig } from '../config'
import { OrderSide, type Fill } from '../execution/contracts'
import { assembleAccountPlan } from '../ledger/decisions'
import type { LedgerPlan } from '../ledger-plan'
import type { JournalDependencies, TigerBeetleClient } from '../tigerbeetle-client'
import { readForwardPerformanceLedger } from './tigerbeetle'

const accountId = 'paper-account-forward-performance'
const ledger = 7_001
const config = {
  operationTimeoutMs: 1_000,
  tigerBeetle: { clusterId: 2_001n, replicaAddresses: ['3000'], ledger },
} satisfies Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>

const success = <A, E>(result: Result.Result<A, E>): A => {
  assert(Result.isSuccess(result), 'forward-performance ledger fixture must succeed')
  return result.success
}

const fill = (name: string, side: OrderSide, priceMicros: string, feeMicros: string): Fill => ({
  schemaVersion: 'bayn.paper-fill.v1',
  accountId,
  fillId: `${name}-fill`,
  brokerOrderId: `${name}-broker-order`,
  clientOrderId: `${name}-client-order`,
  symbol: 'NVDA',
  side,
  quantityMicros: '1000000',
  priceMicros,
  feeMicros,
  occurredAt: side === OrderSide.Buy ? '2026-07-20T15:30:00.000Z' : '2026-07-21T15:30:00.000Z',
})

const plans = (): readonly LedgerPlan[] => [
  success(
    prepareAccounting(
      'a'.repeat(64),
      fill('buy', OrderSide.Buy, '100000000', '100'),
      { quantityMicros: '0', costMicros: '0' },
      ledger,
    ),
  ).ledger,
  success(
    prepareAccounting(
      'b'.repeat(64),
      fill('sell', OrderSide.Sell, '110000000', '200'),
      { quantityMicros: '1000000', costMicros: '100000000' },
      ledger,
    ),
  ).ledger,
]

const materializeAccounts = (plan: LedgerPlan): readonly Account[] => {
  const balances = new Map(plan.accounts.map((account) => [account.id, { debits: 0n, credits: 0n }]))
  for (const transfer of plan.transfers) {
    const debit = balances.get(transfer.debit_account_id)
    const credit = balances.get(transfer.credit_account_id)
    if (debit === undefined || credit === undefined) throw new Error('ledger fixture references an unknown account')
    debit.debits += transfer.amount
    credit.credits += transfer.amount
  }
  return plan.accounts.map((account) => {
    const balance = balances.get(account.id)
    if (balance === undefined) throw new Error('ledger fixture omitted an account balance')
    return {
      ...account,
      debits_posted: balance.debits,
      credits_posted: balance.credits,
      timestamp: 1n,
    }
  })
}

const materializeTransfers = (plan: LedgerPlan): readonly Transfer[] =>
  plan.transfers.map((transfer) => ({ ...transfer, timestamp: 1n }))

const dependencies = (accounts: readonly Account[], transfers: readonly Transfer[]): JournalDependencies => ({
  resolveReplicaAddresses: () => Effect.succeed(['3000']),
  createClient: () =>
    ({
      createAccounts: async () => [],
      createTransfers: async () => [],
      lookupAccounts: async () => [],
      lookupTransfers: async () => [],
      queryAccounts: async () => [...accounts],
      queryTransfers: async () => [...transfers],
      destroy: () => undefined,
    }) satisfies TigerBeetleClient,
})

describe('forward performance TigerBeetle read', () => {
  test('reconciles authoritative account balances and transfer events exactly', async () => {
    const accountingPlans = plans()
    const accountPlan = success(assembleAccountPlan(accountId, accountingPlans))

    const evidence = await Effect.runPromise(
      Effect.scoped(
        readForwardPerformanceLedger(
          config,
          accountId,
          accountingPlans,
          dependencies(materializeAccounts(accountPlan), materializeTransfers(accountPlan)),
        ),
      ),
    )

    expect(evidence).toEqual({
      totals: {
        realizedGainMicros: '10000000',
        realizedLossMicros: '0',
        brokerExecutionFeesMicros: '300',
        otherChargedCostsMicros: '0',
        cashYieldMicros: '0',
      },
      ledgerExact: true,
      missingLedgerAccountCount: 0,
      openPositionCount: 0,
    })
  })
})
