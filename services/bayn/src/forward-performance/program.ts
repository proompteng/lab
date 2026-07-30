import { PgClient } from '@effect/sql-pg'
import { Data, Effect, Result, Scope } from 'effect'

import type { LoadedRuntimeConfig } from '../config'
import { verifyAccountingReceipts } from '../db/reconciliation-algebra'
import { type ReconciliationAlgebraFailure } from '../db/reconciliation-algebra'
import type { CanonicalJsonFailure } from '../hash'
import type { BrokerIdentity } from '../broker/identity'
import { makeForwardPerformanceReceipt, type ForwardPerformanceDomainFailure } from './domain'
import {
  readForwardPerformancePostgres,
  type ForwardPerformancePostgresEvidence,
  type ForwardPerformancePostgresError,
} from './postgres'
import {
  readForwardPerformanceLedger,
  type ForwardPerformanceLedgerEvidence,
  type ForwardPerformanceLedgerError,
} from './tigerbeetle'
import type { LedgerPlan } from '../ledger-plan'
import type { ForwardPerformanceCashYieldEvidence, ForwardPerformanceReceipt } from './model'

export type ForwardPerformanceProgramCause =
  | CanonicalJsonFailure
  | ForwardPerformanceDomainFailure
  | ForwardPerformanceLedgerError
  | ForwardPerformancePostgresError
  | ReconciliationAlgebraFailure

export class ForwardPerformanceProgramError extends Data.TaggedError('ForwardPerformanceProgramError')<{
  readonly operation: 'account-binding' | 'construct-receipt' | 'ledger-read' | 'postgres-read'
  readonly message: string
  readonly cause?: ForwardPerformanceProgramCause
}> {}

type BoundForwardPerformanceConfig = LoadedRuntimeConfig & {
  readonly execution: LoadedRuntimeConfig['execution'] & { readonly brokerIdentity: BrokerIdentity }
}

export interface ForwardPerformanceReaders {
  readonly postgres: (
    sql: PgClient.PgClient,
    accountId: string,
  ) => Effect.Effect<ForwardPerformancePostgresEvidence, ForwardPerformancePostgresError>
  readonly ledger: (
    config: Pick<LoadedRuntimeConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
    accountId: string,
    plans: readonly LedgerPlan[],
    cashYieldEvidence?: ForwardPerformanceCashYieldEvidence,
  ) => Effect.Effect<ForwardPerformanceLedgerEvidence, ForwardPerformanceLedgerError, Scope.Scope>
}

export const liveForwardPerformanceReaders: ForwardPerformanceReaders = {
  postgres: readForwardPerformancePostgres,
  ledger: readForwardPerformanceLedger,
}

const programError = (
  operation: ForwardPerformanceProgramError['operation'],
  message: string,
  cause?: ForwardPerformanceProgramCause,
): ForwardPerformanceProgramError => new ForwardPerformanceProgramError({ operation, message, cause })

const requireBrokerIdentity = (
  config: LoadedRuntimeConfig,
): Effect.Effect<BoundForwardPerformanceConfig, ForwardPerformanceProgramError> => {
  const brokerIdentity = config.execution.brokerIdentity
  return brokerIdentity === undefined
    ? Effect.fail(
        programError('account-binding', 'forward performance requires one configured broker account identity'),
      )
    : Effect.succeed(config as BoundForwardPerformanceConfig)
}

export const runForwardPerformance = (
  loadedConfig: LoadedRuntimeConfig,
  readers: ForwardPerformanceReaders = liveForwardPerformanceReaders,
): Effect.Effect<ForwardPerformanceReceipt, ForwardPerformanceProgramError, PgClient.PgClient | Scope.Scope> =>
  Effect.gen(function* () {
    const config = yield* requireBrokerIdentity(loadedConfig)
    const identity = config.execution.brokerIdentity
    const sql = yield* PgClient.PgClient
    const postgres = yield* readers
      .postgres(sql, identity.accountId)
      .pipe(Effect.mapError((cause) => programError('postgres-read', cause.message, cause)))

    const accountingVerification = verifyAccountingReceipts(postgres.transactions, postgres.receipts, config)
    const plans = Result.isSuccess(accountingVerification) ? accountingVerification.success.plans : []
    const accountingReceiptsExact =
      Result.isSuccess(accountingVerification) &&
      postgres.unaccountedFillCount === 0 &&
      accountingVerification.success.exactReceipts.size === postgres.transactions.length &&
      [...accountingVerification.success.exactReceipts.values()].every(Boolean)

    const ledger = yield* readers
      .ledger(config, identity.accountId, plans, postgres.cashYieldEvidence)
      .pipe(Effect.mapError((cause) => programError('ledger-read', cause.message, cause)))
    const reconciliation =
      postgres.reconciliation === undefined
        ? undefined
        : {
            ...postgres.reconciliation,
            performanceExact:
              postgres.reconciliation.performanceExact &&
              (!postgres.reconciliation.cashYieldAdjustedExact || ledger.cashYieldEvidence !== undefined),
            cashYieldAdjustedExact:
              postgres.reconciliation.cashYieldAdjustedExact && ledger.cashYieldEvidence !== undefined,
          }
    const receipt = yield* Effect.fromResult(
      makeForwardPerformanceReceipt({
        runtime: {
          sourceRevision: config.build.sourceRevision,
          imageRepository: config.build.imageRepository,
          imageDigest: config.build.imageDigest,
        },
        account: {
          accountId: identity.accountId,
          accountReferenceHash: identity.identityHash,
          provider: identity.provider,
          environment: identity.environment,
        },
        durableExecutionBindings: postgres.durableExecutionBindings,
        cycles: postgres.cycles,
        ...(postgres.strategy === undefined ? {} : { strategy: postgres.strategy }),
        ...(reconciliation === undefined ? {} : { reconciliation }),
        ...(postgres.startingCapitalMicros === undefined
          ? {}
          : { startingCapitalMicros: postgres.startingCapitalMicros }),
        transactions: postgres.transactionEvidence,
        ledgerTotals: ledger.totals,
        cashYieldEvidenceRequired: ledger.cashYieldEvidenceRequired,
        ...(ledger.cashYieldEvidence === undefined ? {} : { cashYieldEvidence: ledger.cashYieldEvidence }),
        accountingReceiptsExact,
        ledgerExact: ledger.ledgerExact,
        missingLedgerAccountCount: ledger.missingLedgerAccountCount,
        unresolvedMutationCount: postgres.unresolvedMutationCount,
        unclosedCycleCount: postgres.unclosedCycleCount + postgres.postReconciliationActivityCount,
        openPositionCount: Math.max(postgres.openPositionCount, ledger.openPositionCount),
      }),
    ).pipe(
      Effect.mapError((cause) =>
        programError('construct-receipt', 'forward-performance receipt construction failed', cause),
      ),
    )
    return receipt
  })
