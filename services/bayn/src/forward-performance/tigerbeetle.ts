import { Data, Effect, Result, Scope } from 'effect'
import type { Account } from 'tigerbeetle-node'

import type { RuntimeConfig } from '../config'
import { assembleAccountPlan, accountReconciliationQueries } from '../ledger/decisions'
import { AccountCode, reconcileLedgerPlan, type LedgerPlan, type LedgerValidationError } from '../ledger-plan'
import { makeTigerBeetleRequestClient, type JournalDependencies } from '../tigerbeetle-client'
import type { OperationalError } from '../errors'
import type { ForwardPerformanceLedgerTotals } from './model'

export class ForwardPerformanceLedgerError extends Data.TaggedError('ForwardPerformanceLedgerError')<{
  readonly operation: 'read'
  readonly message: string
  readonly cause: OperationalError | LedgerValidationError
}> {}

export interface ForwardPerformanceLedgerEvidence {
  readonly totals: ForwardPerformanceLedgerTotals
  readonly ledgerExact: boolean
  readonly missingLedgerAccountCount: number
  readonly openPositionCount: number
}

const ledgerError = (cause: OperationalError | LedgerValidationError): ForwardPerformanceLedgerError =>
  new ForwardPerformanceLedgerError({
    operation: 'read',
    message: 'forward-performance TigerBeetle read failed',
    cause,
  })

const accountAmount = (accounts: readonly Account[], code: number, side: 'debit' | 'credit'): bigint =>
  accounts
    .filter((account) => account.code === code)
    .reduce((total, account) => total + (side === 'debit' ? account.debits_posted : account.credits_posted), 0n)

const openInventoryCount = (accounts: readonly Account[]): number =>
  accounts.filter(
    (account) => account.code === AccountCode.inventory && account.debits_posted !== account.credits_posted,
  ).length

export const readForwardPerformanceLedger = (
  config: Pick<RuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
  accountId: string,
  plans: readonly LedgerPlan[],
  dependencies?: JournalDependencies,
): Effect.Effect<ForwardPerformanceLedgerEvidence, ForwardPerformanceLedgerError, Scope.Scope> =>
  Effect.gen(function* () {
    const plan = yield* Effect.fromResult(assembleAccountPlan(accountId, plans)).pipe(Effect.mapError(ledgerError))
    const queries = yield* Effect.fromResult(accountReconciliationQueries(plan, config.tigerBeetle.ledger)).pipe(
      Effect.mapError(ledgerError),
    )
    const client = yield* makeTigerBeetleRequestClient(config, dependencies).pipe(Effect.mapError(ledgerError))
    const [accounts, transfers] = yield* Effect.all(
      [
        client.request('forward-performance-accounts', (active) => active.queryAccounts(queries.accounts)),
        client.request('forward-performance-transfers', (active) => active.queryTransfers(queries.transfers)),
      ],
      { concurrency: 'unbounded' },
    ).pipe(Effect.mapError(ledgerError))

    const expectedAccountIds = new Set(plan.accounts.map((account) => account.id))
    const actualAccountIds = new Set(accounts.map((account) => account.id))
    const missingLedgerAccountCount = [...expectedAccountIds].filter((id) => !actualAccountIds.has(id)).length
    const reconciliation = reconcileLedgerPlan(plan, accounts, transfers, 'verify-account')

    return {
      totals: {
        realizedGainMicros: accountAmount(accounts, AccountCode.realizedGain, 'credit').toString(),
        realizedLossMicros: accountAmount(accounts, AccountCode.realizedLoss, 'debit').toString(),
        brokerExecutionFeesMicros: accountAmount(accounts, AccountCode.feeExpense, 'debit').toString(),
        otherChargedCostsMicros: '0',
        cashYieldMicros: accountAmount(accounts, AccountCode.cashYieldIncome, 'credit').toString(),
      },
      ledgerExact: Result.isSuccess(reconciliation),
      missingLedgerAccountCount,
      openPositionCount: openInventoryCount(accounts),
    }
  })
