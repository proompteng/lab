import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import type { ForwardPerformanceConfig } from './config'
import { InferenceCostError, makeInferenceCostReport, type InferenceCostEvidence } from '../inference-costs'
import { readInferenceCostEvidence } from '../inference-costs-postgres'
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
  readonly invoiceReconciled: false
}

export const summarizeForwardInferenceExpenses = (
  evidence: InferenceCostEvidence,
  accountId: string,
  frozen: readonly { readonly quote: InferenceExpenseQuote; readonly verifiedAt: string | null }[],
  authorityGenerationHash?: string,
) =>
  Result.gen(function* () {
    const selected = {
      ...evidence,
      requests: evidence.requests.filter(
        (request) =>
          authorityGenerationHash === undefined || request.authorityGenerationHash === authorityGenerationHash,
      ),
    }
    const sourceReport = yield* makeInferenceCostReport(selected, {
      schemaVersion: 'bayn.inference-rate-card.v1',
      rates: [],
    })
    const requests = new Map(sourceReport.requests.map((request) => [request.requestId, request]))
    const rows = frozen.filter(({ quote }) => requests.has(quote.line.requestId))
    const coverage = yield* verifyInferenceExpenseCoverage(selected, accountId, rows)
    let known = 0n
    for (const { quote } of rows) {
      const request = requests.get(quote.line.requestId)
      if (request !== undefined && quote.line.receiptHash === request.receiptHash)
        known += BigInt(quote.line.estimatedCostPicoUsd ?? '0')
    }
    return {
      sessionDate: evidence.sessionDate,
      authorityGenerationHash: authorityGenerationHash ?? null,
      knownEstimatedCostPicoUsd: known.toString(),
      ...coverage,
      invoiceReconciled: false,
    } satisfies Omit<ForwardInferenceExpenseSession, 'exactSessionLedger'>
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
        const evidence = yield* readInferenceCostEvidence(sql, accountId, sessionDate, writerFence)
        const frozen = yield* store.session(sessionDate)
        yield* Effect.fromResult(verifyInferenceExpenseCoverage(evidence, accountId, frozen))
        yield* readInferenceExpenseLedger(
          client,
          evidence.accountBindingHash,
          sessionDate,
          frozen.map(({ quote }) => quote),
        )
        return {
          ...(yield* Effect.fromResult(
            summarizeForwardInferenceExpenses(evidence, accountId, frozen, authorityGenerationHash),
          )),
          exactSessionLedger: true as const,
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
