import { PgClient } from '@effect/sql-pg'
import { Context, Effect, Schema } from 'effect'

import { canonicalHashV1Result } from './hash'
import { InferenceCostError } from './inference-costs'
import {
  makeJevTerminalBatchSettlementCursor,
  settleExpiredTerminalJevBatches,
  type JevTerminalBatchSettlementCursor,
} from './db/jev-batch-postgres'
import {
  decodeInferenceExpenseQuote,
  inferenceExpenseBatchSize,
  inferenceExpenseCoverageFrom,
  InferenceExpenseSourceSchema,
  verifyPendingInferenceExpenses,
  type InferenceExpenseQuote,
} from './inference-expense'
import { IsoDateSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from './schemas'

const FrozenRowSchema = Schema.Struct({
  quoteHash: Sha256Schema,
  payload: Schema.Unknown,
  source: InferenceExpenseSourceSchema,
})
const ReportRowSchema = Schema.Struct({
  quoteHash: Sha256Schema,
  payload: Schema.Unknown,
  verifiedAt: Schema.NullOr(UtcInstantSchema),
})

export const decodeInferenceExpenseSessionRows = (input: unknown, sessionDate: string) =>
  Effect.gen(function* () {
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ReportRowSchema), strictParseOptions)(input)
    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const quote = yield* Effect.fromResult(decodeInferenceExpenseQuote(row.payload))
        if (quote.quoteHash !== row.quoteHash || quote.sessionDate !== sessionDate)
          return yield* new InferenceCostError({ message: 'Inference expense session quote identity differs' })
        return { quote, verifiedAt: row.verifiedAt }
      }),
    )
  })

export const makeInferenceExpenseStore = (
  sql: PgClient.PgClient,
  accountId: string,
  coverageFrom = inferenceExpenseCoverageFrom,
  settlementCursor: JevTerminalBatchSettlementCursor = makeJevTerminalBatchSettlementCursor(accountId),
) => {
  const source = sql.literal(`jsonb_build_object(
    'accountId', cycle.account_id, 'sessionDate', cycle.execution_session_date::text,
    'asOf', to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'requestId', request.request_id, 'cycleId', request.cycle_id,
    'authorityGenerationHash', request.authority_generation_hash,
    'request', request.payload, 'receipt', receipt.payload, 'resolution', resolution.payload, 'handoff', handoff.payload
  ) || CASE WHEN chart_claim.request_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
    'chartCheckpoint', jsonb_build_object('claim', chart_claim.payload, 'terminal', chart_terminal.payload)) END ||
    CASE WHEN request.schema_version='bayn.jev-evaluation-request.v3' THEN jsonb_build_object('stagedCheckpoint',jsonb_build_object(
      'claims',COALESCE((SELECT jsonb_agg(payload ORDER BY stage COLLATE "C") FROM jev_staged_dispatch_claims WHERE request_id=request.request_id),'[]'::jsonb),
      'terminals',COALESCE((SELECT jsonb_agg(payload ORDER BY stage COLLATE "C") FROM jev_staged_terminal_receipts WHERE request_id=request.request_id),'[]'::jsonb),
      'skips',COALESCE((SELECT jsonb_agg(payload ORDER BY stage COLLATE "C") FROM jev_staged_skip_receipts WHERE request_id=request.request_id),'[]'::jsonb)
    )) ELSE '{}'::jsonb END`)
  const retireCoveredSources = (requestIds?: readonly string[]) =>
    sql`
    WITH covered AS MATERIALIZED (
      SELECT pending.request_id, pending.revision
      FROM inference_expense_source_pending AS pending
      JOIN jev_evaluation_requests AS request ON request.request_id = pending.request_id
      JOIN autonomous_cycles AS cycle ON cycle.cycle_id = request.cycle_id
      WHERE cycle.account_id = ${accountId} AND cycle.execution_session_date >= ${coverageFrom}::date
        AND ${requestIds === undefined ? sql.literal('TRUE') : sql`pending.request_id = ANY(${requestIds}::text[])`}
        AND NOT inference_expense_source_needs_quotes(pending.request_id)
    )
    DELETE FROM inference_expense_source_pending AS pending USING covered
    WHERE pending.request_id = covered.request_id AND pending.revision = covered.revision
  `.pipe(Effect.asVoid)
  const newSources = Effect.andThen(
    retireCoveredSources(),
    sql<Record<string, unknown>>`
    WITH changed_sources AS MATERIALIZED (
      SELECT request.request_id
      FROM inference_expense_source_pending AS pending
      JOIN jev_evaluation_requests AS request ON request.request_id = pending.request_id
      JOIN autonomous_cycles AS cycle ON cycle.cycle_id = request.cycle_id
      WHERE cycle.account_id = ${accountId} AND cycle.execution_session_date >= ${coverageFrom}::date
    ), pending_requests AS MATERIALIZED (
      SELECT request_id FROM changed_sources WHERE inference_expense_source_needs_quotes(request_id)
      ORDER BY request_id COLLATE "C" LIMIT ${inferenceExpenseBatchSize}
    )
    SELECT ${source} AS source
    FROM pending_requests AS pending
    JOIN jev_evaluation_requests AS request ON request.request_id = pending.request_id
    JOIN autonomous_cycles AS cycle ON cycle.cycle_id = request.cycle_id
    LEFT JOIN jev_evaluation_resolutions AS resolution ON resolution.request_id = request.request_id
    LEFT JOIN jev_evaluation_receipts AS receipt ON receipt.request_id = request.request_id
    LEFT JOIN jev_inference_handoffs AS handoff ON handoff.request_id = request.request_id
    LEFT JOIN jev_chart_dispatch_claims AS chart_claim ON chart_claim.request_id = request.request_id
    LEFT JOIN jev_chart_terminal_receipts AS chart_terminal ON chart_terminal.request_id = request.request_id
    ORDER BY request.request_id COLLATE "C"
  `.pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ source: InferenceExpenseSourceSchema })),
          strictParseOptions,
        ),
      ),
      Effect.map((rows) => rows.map((row) => row.source)),
    ),
  )
  const freeze = (quotes: readonly InferenceExpenseQuote[]) =>
    Effect.gen(function* () {
      if (quotes.length === 0) return
      if (quotes.length > inferenceExpenseBatchSize)
        return yield* new InferenceCostError({ message: 'Inference expense freeze exceeds the bounded batch size' })
      const binding = yield* Effect.fromResult(
        canonicalHashV1Result({ schemaVersion: 'bayn.inference-cost-account.v1', accountId }),
      )
      for (const quote of quotes) {
        yield* Effect.fromResult(decodeInferenceExpenseQuote(quote))
        if (quote.accountBindingHash !== binding)
          return yield* new InferenceCostError({ message: 'Inference expense quote belongs to a different account' })
      }
      yield* sql`
      INSERT INTO inference_expense_quotes (quote_hash, account_id, session_date, payload)
      SELECT item->>'quoteHash', cycle.account_id, cycle.execution_session_date, item
      FROM jsonb_array_elements(${sql.json(quotes)}) AS item
      JOIN jev_evaluation_requests AS request ON request.request_id = item #>> '{line,requestId}'
      JOIN autonomous_cycles AS cycle ON cycle.cycle_id = request.cycle_id
      WHERE cycle.account_id = ${accountId} AND cycle.execution_session_date::text = item->>'sessionDate'
      ON CONFLICT DO NOTHING
    `
      const saved = yield* sql<Record<string, unknown>>`
      SELECT quote_hash AS "quoteHash", payload FROM inference_expense_quotes
      WHERE account_id = ${accountId} AND quote_hash = ANY(${quotes.map((quote) => quote.quoteHash)}::text[])
    `.pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ quoteHash: Sha256Schema, payload: Schema.Unknown })),
            strictParseOptions,
          ),
        ),
      )
      const expected = new Set(quotes.map((quote) => quote.quoteHash))
      if (saved.length !== expected.size)
        return yield* new InferenceCostError({ message: 'Inference expense quote conflicts or could not be frozen' })
      for (const row of saved) {
        const quote = yield* Effect.fromResult(decodeInferenceExpenseQuote(row.payload))
        if (row.quoteHash !== quote.quoteHash || !expected.has(quote.quoteHash))
          return yield* new InferenceCostError({ message: 'Persisted inference expense quote differs' })
      }
      yield* retireCoveredSources([...new Set(quotes.map((quote) => quote.line.requestId))])
    }).pipe(Effect.asVoid)
  const pending = sql<Record<string, unknown>>`
    SELECT quote.quote_hash AS "quoteHash", quote.payload, ${source} AS source
    FROM inference_expense_quotes AS quote
    JOIN jev_evaluation_requests AS request ON request.request_id = quote.request_id
    JOIN autonomous_cycles AS cycle ON cycle.cycle_id = request.cycle_id
    LEFT JOIN jev_evaluation_resolutions AS resolution ON resolution.request_id = request.request_id
    LEFT JOIN jev_evaluation_receipts AS receipt ON receipt.request_id = request.request_id
    LEFT JOIN jev_inference_handoffs AS handoff ON handoff.request_id = request.request_id
    LEFT JOIN jev_chart_dispatch_claims AS chart_claim ON chart_claim.request_id = request.request_id
    LEFT JOIN jev_chart_terminal_receipts AS chart_terminal ON chart_terminal.request_id = request.request_id
    WHERE quote.account_id = ${accountId} AND cycle.account_id = ${accountId}
      AND quote.session_date = cycle.execution_session_date AND quote.verified_at IS NULL
    ORDER BY quote.quote_hash COLLATE "C" LIMIT ${inferenceExpenseBatchSize}
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(FrozenRowSchema), strictParseOptions)),
    Effect.flatMap((rows) => Effect.fromResult(verifyPendingInferenceExpenses(rows))),
  )
  const acknowledge = (quotes: readonly InferenceExpenseQuote[]) =>
    quotes.length === 0
      ? Effect.void
      : sql`
    UPDATE inference_expense_quotes SET verified_at = transaction_timestamp()
    WHERE account_id = ${accountId} AND quote_hash = ANY(${quotes.map((quote) => quote.quoteHash)}::text[])
      AND verified_at IS NULL
  `.pipe(Effect.asVoid)
  const session = (sessionDate: string) =>
    Effect.gen(function* () {
      yield* Schema.decodeUnknownEffect(IsoDateSchema)(sessionDate)
      const rows = yield* sql<Record<string, unknown>>`
      SELECT quote_hash AS "quoteHash", payload,
        to_char(verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "verifiedAt"
      FROM inference_expense_quotes WHERE account_id = ${accountId} AND session_date = ${sessionDate}::date
      ORDER BY quote_hash COLLATE "C"
    `
      return yield* decodeInferenceExpenseSessionRows(rows, sessionDate)
    })
  // Owner discovery must see quotes committed after an enclosing report's repeatable-read snapshot.
  const currentSession = (sessionDate: string) =>
    session(sessionDate).pipe(
      Effect.updateContext((context: Context.Context<never>) =>
        Context.omit(sql.transactionService, sql.transactionSemaphoreService)(context),
      ),
    )
  // The owner supplies a cursor that outlives each physical pass/session. Direct
  // callers get a local hint, while the background projection keeps fair progress
  // across its reconnects without making the hint authoritative state.
  const settleExpiredTerminalBatches = settleExpiredTerminalJevBatches(sql, accountId, settlementCursor)
  return { newSources, freeze, pending, acknowledge, session, currentSession, settleExpiredTerminalBatches }
}
