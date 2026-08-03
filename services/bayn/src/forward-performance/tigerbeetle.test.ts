import assert from 'node:assert/strict'

import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'
import { AccountFlags, type Account, type Transfer } from 'tigerbeetle-node'

import { prepareAccounting } from '../accounting/domain'
import type { RuntimeConfig } from '../config'
import { OrderSide, type Fill } from '../execution/contracts'
import { stableU128 } from '../hash'
import { assembleAccountPlan } from '../ledger/decisions'
import { AccountCode, LEDGER_BATCH_MAX, LEDGER_SCHEMA_VERSION, TransferCode, type LedgerPlan } from '../ledger-plan'
import type { JournalDependencies, TigerBeetleClient } from '../tigerbeetle-client'
import type { ForwardPerformanceCashYieldEvidence } from './model'
import { readForwardPerformanceLedger } from './tigerbeetle'

const accountId = 'paper-account-forward-performance'
const ledger = 7_001
const config = {
  operationTimeoutMs: 1_000,
  tigerBeetle: { clusterId: 2_001n, replicaAddresses: ['3000'], ledger },
} satisfies Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>
const hash = (character: string): string => character.repeat(64)

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

const secondGenerationPlans = (): readonly LedgerPlan[] => [
  success(
    prepareAccounting(
      'c'.repeat(64),
      fill('second-buy', OrderSide.Buy, '200000000', '400'),
      { quantityMicros: '0', costMicros: '0' },
      ledger,
    ),
  ).ledger,
  success(
    prepareAccounting(
      'd'.repeat(64),
      fill('second-sell', OrderSide.Sell, '220000000', '600'),
      { quantityMicros: '1000000', costMicros: '200000000' },
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
  plan.transfers.map((transfer) => ({ ...transfer, timestamp: transfer.timestamp === 0n ? 1n : transfer.timestamp }))

const cashYieldEvidence = (
  amount: bigint,
  accountedCashDelta = 0n,
  openingCash = 1_000_000_000n,
): ForwardPerformanceCashYieldEvidence => ({
  schemaVersion: 'bayn.forward-performance-cash-yield-evidence.v1',
  reconciliationId: hash('c'),
  reconciliationContentHash: hash('d'),
  reconciledAt: '2026-07-21T21:01:00.000Z',
  baselineAccountEventId: hash('a'),
  baselineObservedAt: '2026-07-19T13:00:00.000Z',
  baselineCashMicros: openingCash.toString(),
  openingAccountEventId: hash('e'),
  openingObservedAt: '2026-07-20T13:00:00.000Z',
  openingCashMicros: openingCash.toString(),
  preWindowAccountedCashDeltaMicros: '0',
  preWindowCashResidualMicros: '0',
  closingAccountEventId: hash('f'),
  closingObservedAt: '2026-07-21T21:00:00.000Z',
  closingCashMicros: (openingCash + accountedCashDelta + amount).toString(),
  accountedCashDeltaMicros: accountedCashDelta.toString(),
  cashYieldMicros: amount.toString(),
})

const observedCashYieldPlan = (plan: LedgerPlan, amount: bigint): LedgerPlan => {
  const cashAccount = plan.accounts.find((account) => account.code === AccountCode.cash)
  if (cashAccount === undefined) throw new Error('cash-yield fixture requires the persisted cash account')
  const cashYieldAccountId = stableU128('bayn-paper-ledger-account-v1', accountId, 'cash-yield-income')
  const cashYieldAccount: Account = {
    id: cashYieldAccountId,
    debits_pending: 0n,
    debits_posted: 0n,
    credits_pending: 0n,
    credits_posted: 0n,
    user_data_128: plan.runKey,
    user_data_64: plan.runTag,
    user_data_32: LEDGER_SCHEMA_VERSION,
    reserved: 0,
    ledger,
    code: AccountCode.cashYieldIncome,
    flags: AccountFlags.history,
    timestamp: 0n,
  }

  const transfer: Transfer = {
    id: stableU128('untrusted-observed-cash-yield-transfer', accountId),
    debit_account_id: cashAccount.id,
    credit_account_id: cashYieldAccountId,
    amount,
    pending_id: 0n,
    user_data_128: stableU128('untrusted-observed-cash-yield-event', accountId),
    user_data_64: plan.runTag,
    user_data_32: LEDGER_SCHEMA_VERSION,
    timeout: 0,
    ledger,
    code: TransferCode.cashYield,
    flags: 0,
    timestamp: 0n,
  }
  return {
    ...plan,
    accounts: [...plan.accounts, cashYieldAccount].toSorted((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
    transfers: [...plan.transfers, transfer].toSorted((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
  }
}

const dependencies = (
  accounts: readonly Account[],
  transfers: readonly Transfer[],
  observedLimits?: { accounts?: number; transfers?: number },
): JournalDependencies => ({
  resolveReplicaAddresses: () => Effect.succeed(['3000']),
  createClient: () =>
    ({
      createAccounts: async () => [],
      createTransfers: async () => [],
      lookupAccounts: async () => [],
      lookupTransfers: async () => [],
      queryAccounts: async (filter) => {
        if (observedLimits !== undefined) observedLimits.accounts = filter.limit
        return [...accounts]
      },
      queryTransfers: async (filter) => {
        if (observedLimits !== undefined) observedLimits.transfers = filter.limit
        return [...transfers]
      },
      destroy: () => undefined,
    }) satisfies TigerBeetleClient,
})

describe('forward performance TigerBeetle read', () => {
  test('reconciles cumulative stable-account balances while reporting only the selected generation totals', async () => {
    const priorPlans = plans()
    const currentPlans = secondGenerationPlans()
    const accountPlan = success(assembleAccountPlan(accountId, [...priorPlans, ...currentPlans]))

    const evidence = await Effect.runPromise(
      Effect.scoped(
        readForwardPerformanceLedger(
          config,
          accountId,
          [...priorPlans, ...currentPlans],
          undefined,
          dependencies(materializeAccounts(accountPlan), materializeTransfers(accountPlan)),
          currentPlans,
        ),
      ),
    )

    expect(evidence.ledgerExact).toBe(true)
    expect(evidence.totals).toEqual({
      realizedGainMicros: '20000000',
      realizedLossMicros: '0',
      brokerExecutionFeesMicros: '1000',
      otherChargedCostsMicros: '0',
      cashYieldMicros: '0',
    })
    expect(evidence.openPositionCount).toBe(0)
  })

  test('reconciles authoritative account balances and transfer events exactly', async () => {
    const accountingPlans = plans()
    const accountPlan = success(assembleAccountPlan(accountId, accountingPlans))

    const evidence = await Effect.runPromise(
      Effect.scoped(
        readForwardPerformanceLedger(
          config,
          accountId,
          accountingPlans,
          undefined,
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
      cashYieldEvidenceRequired: false,
    })
  })

  test('leaves a genuine-yield residual insufficient until an authoritative event is persisted', async () => {
    const accountingPlans = plans()
    const accountPlan = success(assembleAccountPlan(accountId, accountingPlans))
    const expectedYield = cashYieldEvidence(20_000_000n)
    const observedLimits: { accounts?: number; transfers?: number } = {}

    const evidence = await Effect.runPromise(
      Effect.scoped(
        readForwardPerformanceLedger(
          config,
          accountId,
          accountingPlans,
          expectedYield,
          dependencies(materializeAccounts(accountPlan), materializeTransfers(accountPlan), observedLimits),
        ),
      ),
    )

    expect(observedLimits).toEqual({ accounts: LEDGER_BATCH_MAX, transfers: LEDGER_BATCH_MAX })
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
      cashYieldEvidenceRequired: true,
    })
    expect(evidence.cashYieldEvidence).toBeUndefined()
  })

  test('keeps malformed durable cash-yield evidence fail closed', async () => {
    const accountingPlans = plans()
    const accountPlan = success(assembleAccountPlan(accountId, accountingPlans))
    const expectedYield = cashYieldEvidence(20_000_000n)
    const malformed = { ...expectedYield, preWindowCashResidualMicros: '1' }

    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          readForwardPerformanceLedger(
            config,
            accountId,
            accountingPlans,
            malformed,
            dependencies(materializeAccounts(accountPlan), materializeTransfers(accountPlan)),
          ),
        ),
      ),
    )

    expect(failure).toMatchObject({
      operation: 'read',
      cause: { operation: 'verify-account', reason: 'invalid-transaction' },
    })
  })

  test('leaves an external deposit residual insufficient without a semantic yield event', async () => {
    const accountingPlans = plans()
    const accountPlan = success(assembleAccountPlan(accountId, accountingPlans))
    const residual = cashYieldEvidence(20_000_000n)

    const evidence = await Effect.runPromise(
      Effect.scoped(
        readForwardPerformanceLedger(
          config,
          accountId,
          accountingPlans,
          residual,
          dependencies(materializeAccounts(accountPlan), materializeTransfers(accountPlan)),
        ),
      ),
    )

    expect(evidence).toMatchObject({
      totals: { cashYieldMicros: '0' },
      ledgerExact: true,
      missingLedgerAccountCount: 0,
      cashYieldEvidenceRequired: true,
    })
    expect(evidence.cashYieldEvidence).toBeUndefined()
  })

  test('rejects a broker correction or arbitrary yield-like ledger record', async () => {
    const accountingPlans = plans()
    const accountPlan = success(assembleAccountPlan(accountId, accountingPlans))
    const expectedYield = cashYieldEvidence(20_000_000n)
    const observed = observedCashYieldPlan(accountPlan, 1_000_000n)

    const evidence = await Effect.runPromise(
      Effect.scoped(
        readForwardPerformanceLedger(
          config,
          accountId,
          accountingPlans,
          expectedYield,
          dependencies(materializeAccounts(observed), materializeTransfers(observed)),
        ),
      ),
    )

    expect(evidence.totals.cashYieldMicros).toBe('0')
    expect(evidence.ledgerExact).toBe(false)
    expect(evidence.missingLedgerAccountCount).toBe(0)
    expect(evidence.cashYieldEvidenceRequired).toBe(true)
    expect(evidence.cashYieldEvidence).toBeUndefined()
  })

  test('fails closed when the bounded account query reaches its exact limit', async () => {
    const accountingPlans = plans()
    const accountPlan = success(assembleAccountPlan(accountId, accountingPlans))
    const sample = materializeAccounts(accountPlan)[0]
    if (sample === undefined) throw new Error('ledger fixture requires one account')
    const saturated = Array.from({ length: LEDGER_BATCH_MAX }, (_, index) => ({
      ...sample,
      id: BigInt(index + 1),
    }))

    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.scoped(
          readForwardPerformanceLedger(config, accountId, accountingPlans, undefined, dependencies(saturated, [])),
        ),
      ),
    )

    expect(failure).toMatchObject({
      operation: 'read',
      cause: {
        operation: 'verify-account',
        reason: 'batch-limit',
        material: { accountCount: LEDGER_BATCH_MAX, transferCount: 0, limit: LEDGER_BATCH_MAX },
      },
    })
  })
})
