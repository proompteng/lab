import { Effect } from 'effect'

import type { BaynReconciliationError, BaynAccountingValidationError } from './errors'
import { buildJournalPlan } from './plan'
import { requireExactReconciliation, type BaynReconciliationReportV1 } from './reconcile'
import type { BaynEvaluationEconomicsV1, BaynJournalPlanV1 } from './types'
import { TigerBeetleClient, type TigerBeetleServiceError, type TigerBeetleWriteSummary } from './tigerbeetle-client'

export interface BaynJournalResultV1 {
  readonly schemaVersion: 'bayn.tigerbeetle-journal-result.v1'
  readonly evaluationId: string
  readonly accounts: TigerBeetleWriteSummary
  readonly transfers: TigerBeetleWriteSummary
  readonly reconciliation: BaynReconciliationReportV1
  readonly plan: BaynJournalPlanV1
}

export type BaynJournalError = BaynAccountingValidationError | TigerBeetleServiceError | BaynReconciliationError

/**
 * Journal an evaluation idempotently, then fail unless TigerBeetle exactly
 * reproduces every event and both sides of every evaluation-scoped account.
 */
export const journalEvaluation = (
  evaluation: BaynEvaluationEconomicsV1,
): Effect.Effect<BaynJournalResultV1, BaynJournalError, TigerBeetleClient> =>
  Effect.gen(function* () {
    const plan = yield* buildJournalPlan(evaluation)
    const client = yield* TigerBeetleClient
    const accounts = yield* client.ensureAccounts(plan.accounts.map(({ account }) => account))
    const transfers = yield* client.ensureTransfers(plan.transfers.map(({ transfer }) => transfer))
    const reconciliation = yield* requireExactReconciliation(plan)
    return {
      schemaVersion: 'bayn.tigerbeetle-journal-result.v1',
      evaluationId: evaluation.evaluationId,
      accounts,
      transfers,
      reconciliation,
      plan,
    }
  })
