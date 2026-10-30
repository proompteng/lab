import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import type { ForwardPerformanceConfig } from './config'
import {
  InferenceCostError,
  inferenceStageKey,
  makeInferenceCostReport,
  type DecodedInferenceCostEvidence,
} from '../inference-costs'
import { readInferenceExpenseSnapshot } from '../inference-costs-postgres'
import { verifyInferenceExpenseCoverage, type InferenceExpenseQuote } from '../inference-expense'
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
    const sourceReport = yield* makeInferenceCostReport(evidence, {
      schemaVersion: 'bayn.inference-rate-card.v1',
      rates: [],
    })
    const selectedRequestIds = new Set(
      evidence.requests
        .filter(
          (request) =>
            authorityGenerationHash === undefined || request.authorityGenerationHash === authorityGenerationHash,
        )
        .map((request) => request.requestId),
    )
    const requests = new Map(
      sourceReport.requests
        .filter((request) => selectedRequestIds.has(request.requestId))
        .map((request) => [inferenceStageKey(request), request]),
    )
    const rows = frozen.filter(({ quote }) => requests.has(inferenceStageKey(quote.line)))
    const coverage = yield* verifyInferenceExpenseCoverage(evidence, accountId, frozen, authorityGenerationHash)
    let known = 0n
    for (const { quote } of rows) {
      const request = requests.get(inferenceStageKey(quote.line))
      if (
        request !== undefined &&
        quote.line.receiptHash === request.receiptHash &&
        ('handoffHash' in quote.line ? quote.line.handoffHash : null) ===
          ('handoffHash' in request ? request.handoffHash : null)
      )
        known += BigInt(quote.line.estimatedCostPicoUsd ?? '0')
    }
    return {
      sessionDate: evidence.sessionDate,
      authorityGenerationHash: authorityGenerationHash ?? null,
      knownEstimatedCostPicoUsd: known.toString(),
      sourceAsOf: coverage.sourceAsOf,
      claimedRequestCount: coverage.claimedRequestCount,
      missingQuoteCount: coverage.missingQuoteCount,
      unverifiedRequestCount: coverage.unverifiedRequestCount,
      gapRequestCount: coverage.gapRequestCount,
      completeMeteredCoverage: coverage.completeMeteredCoverage,
      invoiceReconciled: false,
    } satisfies Omit<
      ForwardInferenceExpenseSession,
      'exactSessionLedger' | 'ledgerTimestampMax' | 'verifiedSessionTransferCount'
    >
  })

export const readForwardInferenceExpenses = (
  config: Pick<ForwardPerformanceConfig, 'operationTimeoutMs' | 'tigerBeetle'>,
  sql: PgClient.PgClient,
  accountId: string,
  authorityGenerationHash?: string,
  writerFence?: WriterFenceService,
) =>
  Effect.gen(function* () {
    const sessions = yield* sql`
      SELECT DISTINCT cycle.execution_session_date::text AS "sessionDate"
      FROM jev_evaluation_requests AS request JOIN autonomous_cycles AS cycle USING (cycle_id)
      WHERE cycle.account_id = ${accountId}
        AND (${authorityGenerationHash ?? null}::text IS NULL OR request.authority_generation_hash = ${authorityGenerationHash ?? null})
      ORDER BY "sessionDate" LIMIT 1001
    `.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ sessionDate: IsoDateSchema })), strictParseOptions),
      ),
    )
    if (sessions.length > 1000)
      return yield* new InferenceCostError({
        message: 'Forward inference expense sessions exceed the complete-report limit',
      })
    if (sessions.length === 0) return []
    const client = yield* makeTigerBeetleRequestClient(config)
    const store = makeInferenceExpenseStore(sql, accountId)
    return yield* Effect.forEach(sessions, ({ sessionDate }) =>
      Effect.gen(function* () {
        const snapshot = yield* readInferenceExpenseSnapshot(sql, accountId, sessionDate, writerFence)
        const { evidence, quotes: frozen } = snapshot
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
