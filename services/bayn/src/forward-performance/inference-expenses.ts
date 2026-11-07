import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import type { ForwardPerformanceConfig } from './config'
import { InferenceCostError, type DecodedInferenceCostEvidence } from '../inference-costs'
import { acquireInferenceExpenseSnapshot } from '../inference-costs-postgres'
import {
  verifyInferenceExpenseCoverage,
  type InferenceExpenseQuote,
  type InferenceExpenseRequestCoverage,
} from '../inference-expense'
import { makeInferenceExpenseStore } from '../inference-expense-postgres'
import { readInferenceExpenseLedger } from '../inference-expense-journal'
import { makeTigerBeetleRequestClient } from '../tigerbeetle-client'
import { IsoDateSchema, strictParseOptions } from '../schemas'
import type { WriterFenceService } from '../execution/writer-fence'

export interface ForwardInferenceExpenseSession {
  readonly sessionDate: string
  readonly authorityGenerationHash: string | null
  readonly sourceAsOf: string
  readonly knownEstimatedCostPicoUsd: string
  readonly claimedRequestCount: number
  readonly missingQuoteCount: number
  readonly unverifiedRequestCount: number
  readonly gapRequestCount: number
  readonly matchedQuoteHashes: readonly string[]
  readonly requestsWithCoverageIssues: readonly InferenceExpenseRequestCoverage[]
  readonly completeMeteredCoverage: boolean
  readonly exactSessionLedger: true
  readonly ledgerTimestampMax: string
  readonly verifiedSessionTransferCount: number
  readonly invoiceReconciled: false
}

export const summarizeForwardInferenceExpenses = (
  evidence: DecodedInferenceCostEvidence,
  accountId: string,
  frozen: readonly { readonly quote: InferenceExpenseQuote; readonly verifiedAt: string | null }[],
  authorityGenerationHash?: string,
) =>
  Result.gen(function* () {
    const coverage = yield* verifyInferenceExpenseCoverage(evidence, accountId, frozen, authorityGenerationHash)
    return {
      sessionDate: evidence.sessionDate,
      authorityGenerationHash: authorityGenerationHash ?? null,
      knownEstimatedCostPicoUsd: coverage.knownEstimatedCostPicoUsd,
      sourceAsOf: coverage.sourceAsOf,
      claimedRequestCount: coverage.claimedRequestCount,
      missingQuoteCount: coverage.missingQuoteCount,
      unverifiedRequestCount: coverage.unverifiedRequestCount,
      gapRequestCount: coverage.gapRequestCount,
      matchedQuoteHashes: coverage.matchedQuoteHashes,
      requestsWithCoverageIssues: coverage.requestsWithCoverageIssues,
      completeMeteredCoverage: coverage.completeMeteredCoverage,
      invoiceReconciled: false,
    } satisfies Omit<
      ForwardInferenceExpenseSession,
      'exactSessionLedger' | 'ledgerTimestampMax' | 'verifiedSessionTransferCount'
    >
  })

export const inferenceExpenseSessionQuery = (
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash?: string,
) => sql`
  SELECT DISTINCT cycle.execution_session_date::text AS "sessionDate"
  FROM jev_evaluation_requests AS request JOIN autonomous_cycles AS cycle USING (cycle_id)
  WHERE cycle.account_id = ${accountId}
    AND ${authorityGenerationHash === undefined ? sql`TRUE` : sql`request.authority_generation_hash = ${authorityGenerationHash}`}
  ORDER BY "sessionDate" LIMIT 1001
`

export const readForwardInferenceExpenseSnapshots = (
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash?: string,
  writerFence?: WriterFenceService,
) =>
  Effect.gen(function* () {
    const sessions = yield* inferenceExpenseSessionQuery(sql, accountId, authorityGenerationHash).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ sessionDate: IsoDateSchema })), strictParseOptions),
      ),
    )
    if (sessions.length > 1000)
      return yield* new InferenceCostError({
        message: 'Forward inference expense sessions exceed the complete-report limit',
      })
    if (sessions.length === 0) return []
    return yield* Effect.forEach(sessions, ({ sessionDate }) =>
      acquireInferenceExpenseSnapshot(sql, accountId, sessionDate, writerFence),
    )
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof InferenceCostError
        ? cause
        : new InferenceCostError({ message: 'Forward inference expense read failed', cause }),
    ),
  )

export type ForwardInferenceExpenseSnapshot = Effect.Success<ReturnType<typeof acquireInferenceExpenseSnapshot>>

export const readForwardInferenceExpenses = (
  config: Pick<ForwardPerformanceConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
  sql: PgClient.PgClient,
  accountId: string,
  snapshots: readonly ForwardInferenceExpenseSnapshot[],
  authorityGenerationHash?: string,
) =>
  Effect.gen(function* () {
    if (snapshots.length === 0) return []
    const client = yield* makeTigerBeetleRequestClient(config)
    const store = makeInferenceExpenseStore(sql, accountId)
    return yield* Effect.forEach(snapshots, ({ verify }) =>
      Effect.gen(function* () {
        const snapshot = yield* verify
        const { evidence, quotes: frozen } = snapshot
        const sessionDate = evidence.sessionDate
        const summary = yield* Effect.fromResult(
          summarizeForwardInferenceExpenses(evidence, accountId, frozen, authorityGenerationHash),
        )
        const ledger = yield* readInferenceExpenseLedger(client, snapshot, store.currentSession(sessionDate))
        return {
          ...summary,
          exactSessionLedger: true as const,
          ledgerTimestampMax: ledger.ledgerTimestampMax,
          verifiedSessionTransferCount: ledger.verifiedSessionTransferCount,
        }
      }),
    )
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof InferenceCostError
        ? cause
        : new InferenceCostError({ message: 'Forward inference expense read failed', cause }),
    ),
  )
