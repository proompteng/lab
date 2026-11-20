import { PgClient } from '@effect/sql-pg'
import { Effect, Option, Result, Schema } from 'effect'

import type { ForwardPerformanceConfig } from './config'
import { inferenceStageKey, InferenceCostError, type DecodedInferenceCostEvidence } from '../inference-costs'
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
import { ReportVerification, reportVerificationConcurrency, type ReportExpenseCoverage } from './verification'

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

const expenseSummary = (
  evidence: DecodedInferenceCostEvidence,
  authorityGenerationHash: string | undefined,
  coverage: ReportExpenseCoverage,
) =>
  ({
    sessionDate: evidence.sessionDate,
    authorityGenerationHash: authorityGenerationHash ?? null,
    ...coverage,
    invoiceReconciled: false,
  }) satisfies Omit<
    ForwardInferenceExpenseSession,
    'exactSessionLedger' | 'ledgerTimestampMax' | 'verifiedSessionTransferCount'
  >

export const summarizeForwardInferenceExpenses = (
  evidence: DecodedInferenceCostEvidence,
  accountId: string,
  frozen: readonly { readonly quote: InferenceExpenseQuote; readonly verifiedAt: string | null }[],
  authorityGenerationHash?: string,
) =>
  verifyInferenceExpenseCoverage(evidence, accountId, frozen, authorityGenerationHash).pipe(
    Result.map((coverage) => expenseSummary(evidence, authorityGenerationHash, coverage)),
  )

export const readForwardInferenceExpenseSummary = (
  evidence: DecodedInferenceCostEvidence,
  accountId: string,
  frozen: Parameters<typeof summarizeForwardInferenceExpenses>[2],
  authorityGenerationHash?: string,
) =>
  Effect.gen(function* () {
    const service = yield* Effect.serviceOption(ReportVerification)
    if (Option.isNone(service))
      return yield* Effect.fromResult(
        summarizeForwardInferenceExpenses(evidence, accountId, frozen, authorityGenerationHash),
      )
    const partitions = Array.from({ length: reportVerificationConcurrency }, () => ({
      requests: [] as DecodedInferenceCostEvidence['requests'][number][],
      frozen: [] as (typeof frozen)[number][],
    }))
    const requestPartitions = new Map<string, (typeof partitions)[number]>()
    for (const request of evidence.requests) {
      let partition = requestPartitions.get(request.requestId)
      if (partition === undefined) {
        partition = partitions[requestPartitions.size % partitions.length]!
        requestPartitions.set(request.requestId, partition)
      }
      // Keep duplicate sources together so conflicting fingerprints still fail verification.
      partition.requests.push(request)
    }
    for (const row of frozen)
      // Orphan quotes must reach the verifier and fail; never silently filter the session cut.
      (requestPartitions.get(row.quote.line.requestId) ?? partitions[0]!).frozen.push(row)
    const coverage = yield* Effect.forEach(
      partitions.filter(
        (partition, index) => index === 0 || partition.requests.length > 0 || partition.frozen.length > 0,
      ),
      (partition) =>
        service.value.coverage({
          evidence: { ...evidence, requests: partition.requests },
          accountId,
          frozen: partition.frozen,
          ...(authorityGenerationHash === undefined ? {} : { authorityGenerationHash }),
        }),
      { concurrency: reportVerificationConcurrency },
    )
    return expenseSummary(evidence, authorityGenerationHash, {
      sourceAsOf: evidence.asOf,
      claimedRequestCount: coverage.reduce((sum, part) => sum + part.claimedRequestCount, 0),
      missingQuoteCount: coverage.reduce((sum, part) => sum + part.missingQuoteCount, 0),
      unverifiedRequestCount: coverage.reduce((sum, part) => sum + part.unverifiedRequestCount, 0),
      gapRequestCount: coverage.reduce((sum, part) => sum + part.gapRequestCount, 0),
      knownEstimatedCostPicoUsd: coverage
        .reduce((sum, part) => sum + BigInt(part.knownEstimatedCostPicoUsd), 0n)
        .toString(),
      matchedQuoteHashes: coverage.flatMap((part) => part.matchedQuoteHashes).sort(),
      requestsWithCoverageIssues: coverage
        .flatMap((part) => part.requestsWithCoverageIssues)
        .sort((a, b) => inferenceStageKey(a).localeCompare(inferenceStageKey(b))),
      completeMeteredCoverage: coverage.every((part) => part.completeMeteredCoverage),
    })
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
        const summary = yield* readForwardInferenceExpenseSummary(evidence, accountId, frozen, authorityGenerationHash)
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
