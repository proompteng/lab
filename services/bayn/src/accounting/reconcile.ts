import { Effect } from 'effect'
import type { Account, Transfer } from 'tigerbeetle-node'

import { BaynReconciliationError, type BaynAccountingValidationError } from './errors'
import { buildJournalPlan } from './plan'
import type { BaynEvaluationEconomicsV1, BaynJournalPlanV1, PlannedAccount } from './types'
import { TigerBeetleClient, type TigerBeetleServiceError } from './tigerbeetle-client'

export interface BaynReconciliationDifference {
  readonly entity: 'account' | 'transfer' | 'evaluation'
  readonly semanticKey: string
  readonly id?: string
  readonly field: string
  readonly expected: string
  readonly actual: string
}

export interface BaynReconciliationReportV1 {
  readonly schemaVersion: 'bayn.tigerbeetle-reconciliation.v1'
  readonly accountingModelVersion: 1
  readonly evaluationId: string
  readonly ok: boolean
  readonly expectedAccountCount: number
  readonly actualAccountCount: number
  readonly expectedTransferCount: number
  readonly actualTransferCount: number
  readonly ending: {
    readonly expectedCash: string
    readonly actualCash: string
    readonly expectedTotalFees: string
    readonly actualTotalFees: string
    readonly expectedEquity: string
    readonly actualEquity: string
    readonly positions: Readonly<Record<string, { readonly expected: string; readonly actual: string }>>
  }
  readonly differences: readonly BaynReconciliationDifference[]
}

const accountFields = [
  'id',
  'debits_pending',
  'credits_pending',
  'user_data_128',
  'user_data_64',
  'user_data_32',
  'reserved',
  'ledger',
  'code',
  'flags',
] as const satisfies readonly (keyof Account)[]

const transferFields = [
  'id',
  'debit_account_id',
  'credit_account_id',
  'amount',
  'pending_id',
  'user_data_128',
  'user_data_64',
  'user_data_32',
  'timeout',
  'ledger',
  'code',
  'flags',
] as const satisfies readonly (keyof Transfer)[]

const show = (value: bigint | number | undefined): string => (value === undefined ? 'missing' : value.toString())

const difference = (
  entity: BaynReconciliationDifference['entity'],
  semanticKey: string,
  field: string,
  expected: bigint | number,
  actual: bigint | number | undefined,
  id?: bigint,
): BaynReconciliationDifference => ({
  entity,
  semanticKey,
  ...(id === undefined ? {} : { id: id.toString() }),
  field,
  expected: show(expected),
  actual: show(actual),
})

const accountNet = (account: Account | undefined): bigint | undefined =>
  account === undefined ? undefined : account.debits_posted - account.credits_posted

const accountByKind = (
  plannedAccounts: readonly PlannedAccount[],
  actualById: ReadonlyMap<bigint, Account>,
  kind: PlannedAccount['kind'],
): Account | undefined => {
  const planned = plannedAccounts.find((account) => account.kind === kind)
  return planned === undefined ? undefined : actualById.get(planned.account.id)
}

const inspectJournalPlanReconciliation = (
  plan: BaynJournalPlanV1,
  actualAccounts: readonly Account[],
  actualTransfers: readonly Transfer[],
): BaynReconciliationReportV1 => {
  const differences: BaynReconciliationDifference[] = []
  const expectedAccountIds = new Set(plan.accounts.map(({ account }) => account.id))
  const expectedTransferIds = new Set(plan.transfers.map(({ transfer }) => transfer.id))
  const actualAccountsInScope = actualAccounts.filter((account) => expectedAccountIds.has(account.id))
  const actualTransfersInScope = actualTransfers.filter((transfer) => expectedTransferIds.has(transfer.id))
  const actualAccountsById = new Map(actualAccountsInScope.map((account) => [account.id, account]))
  const actualTransfersById = new Map(actualTransfersInScope.map((transfer) => [transfer.id, transfer]))

  for (const planned of plan.accounts) {
    const expected = planned.account
    const actual = actualAccountsById.get(expected.id)
    if (actual === undefined) {
      differences.push(difference('account', planned.semanticKey, 'exists', 1, undefined, expected.id))
      continue
    }
    for (const field of accountFields) {
      if (expected[field] !== actual[field]) {
        differences.push(difference('account', planned.semanticKey, field, expected[field], actual[field], expected.id))
      }
    }
    if (planned.expectedDebitsPosted !== actual.debits_posted) {
      differences.push(
        difference(
          'account',
          planned.semanticKey,
          'debits_posted',
          planned.expectedDebitsPosted,
          actual.debits_posted,
          expected.id,
        ),
      )
    }
    if (planned.expectedCreditsPosted !== actual.credits_posted) {
      differences.push(
        difference(
          'account',
          planned.semanticKey,
          'credits_posted',
          planned.expectedCreditsPosted,
          actual.credits_posted,
          expected.id,
        ),
      )
    }
  }

  for (const planned of plan.transfers) {
    const expected = planned.transfer
    const actual = actualTransfersById.get(expected.id)
    if (actual === undefined) {
      differences.push(difference('transfer', planned.stableEventIdentity, 'exists', 1, undefined, expected.id))
      continue
    }
    for (const field of transferFields) {
      if (expected[field] !== actual[field]) {
        differences.push(
          difference('transfer', planned.stableEventIdentity, field, expected[field], actual[field], expected.id),
        )
      }
    }
  }

  for (const actual of actualAccounts) {
    if (!expectedAccountIds.has(actual.id)) {
      differences.push(difference('account', 'lookup-response', 'unexpected', 0, 1, actual.id))
    }
  }
  for (const actual of actualTransfers) {
    if (!expectedTransferIds.has(actual.id)) {
      differences.push(difference('transfer', 'lookup-response', 'unexpected', 0, 1, actual.id))
    }
  }
  if (actualAccountsInScope.length !== actualAccountsById.size) {
    differences.push(
      difference(
        'account',
        'lookup-response',
        'duplicate-count',
        actualAccountsById.size,
        actualAccountsInScope.length,
      ),
    )
  }
  if (actualTransfersInScope.length !== actualTransfersById.size) {
    differences.push(
      difference(
        'transfer',
        'lookup-response',
        'duplicate-count',
        actualTransfersById.size,
        actualTransfersInScope.length,
      ),
    )
  }

  const cash = accountNet(accountByKind(plan.accounts, actualAccountsById, 'cash'))
  const fees = accountByKind(plan.accounts, actualAccountsById, 'fee-expense')?.debits_posted
  const valuation = accountNet(accountByKind(plan.accounts, actualAccountsById, 'ending-valuation'))
  const equity = cash === undefined || valuation === undefined ? undefined : cash + valuation

  if (cash !== plan.expected.endingCash) {
    differences.push(difference('evaluation', 'ending', 'cash', plan.expected.endingCash, cash))
  }
  if (fees !== plan.expected.totalFees) {
    differences.push(difference('evaluation', 'ending', 'totalFees', plan.expected.totalFees, fees))
  }
  if (equity !== plan.expected.endingEquity) {
    differences.push(difference('evaluation', 'ending', 'equity', plan.expected.endingEquity, equity))
  }

  const positions: Record<string, { expected: string; actual: string }> = {}
  for (const [symbol, expected] of Object.entries(plan.expected.positions)) {
    const plannedAccount = plan.accounts.find(
      (account) => account.kind === 'security-position' && account.symbol === symbol,
    )
    const actual =
      plannedAccount === undefined ? undefined : accountNet(actualAccountsById.get(plannedAccount.account.id))
    positions[symbol] = { expected: expected.quantity.toString(), actual: show(actual) }
    if (actual !== expected.quantity) {
      differences.push(difference('evaluation', `ending-position:${symbol}`, 'quantity', expected.quantity, actual))
    }
  }

  return {
    schemaVersion: 'bayn.tigerbeetle-reconciliation.v1',
    accountingModelVersion: 1,
    evaluationId: plan.evaluationId,
    ok: differences.length === 0,
    expectedAccountCount: plan.accounts.length,
    actualAccountCount: actualAccountsInScope.length,
    expectedTransferCount: plan.transfers.length,
    actualTransferCount: actualTransfersInScope.length,
    ending: {
      expectedCash: plan.expected.endingCash.toString(),
      actualCash: show(cash),
      expectedTotalFees: plan.expected.totalFees.toString(),
      actualTotalFees: show(fees),
      expectedEquity: plan.expected.endingEquity.toString(),
      actualEquity: show(equity),
      positions,
    },
    differences,
  }
}

const reconcileJournalPlan = (
  plan: BaynJournalPlanV1,
): Effect.Effect<BaynReconciliationReportV1, TigerBeetleServiceError, TigerBeetleClient> =>
  Effect.gen(function* () {
    const client = yield* TigerBeetleClient
    const [accounts, transfers] = yield* Effect.all(
      [
        client.lookupAccounts(plan.accounts.map(({ account }) => account.id)),
        client.lookupTransfers(plan.transfers.map(({ transfer }) => transfer.id)),
      ] as const,
      { concurrency: 'unbounded' },
    )
    return inspectJournalPlanReconciliation(plan, accounts, transfers)
  })

export const requireExactReconciliation = (
  plan: BaynJournalPlanV1,
): Effect.Effect<BaynReconciliationReportV1, TigerBeetleServiceError | BaynReconciliationError, TigerBeetleClient> =>
  reconcileJournalPlan(plan).pipe(
    Effect.flatMap((report) =>
      report.ok ? Effect.succeed(report) : Effect.fail(new BaynReconciliationError({ report })),
    ),
  )

/** Rebuild the deterministic expectation from evaluator output and fail on any ledger difference. */
export const reconcileEvaluation = (
  evaluation: BaynEvaluationEconomicsV1,
): Effect.Effect<
  BaynReconciliationReportV1,
  BaynAccountingValidationError | TigerBeetleServiceError | BaynReconciliationError,
  TigerBeetleClient
> => buildJournalPlan(evaluation).pipe(Effect.flatMap(requireExactReconciliation))
