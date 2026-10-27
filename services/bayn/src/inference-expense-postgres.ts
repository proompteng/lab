import { PgClient } from '@effect/sql-pg'
import { Context, Effect, Schema } from 'effect'

import { canonicalHashV1Result } from './hash'
import { InferenceCostError } from './inference-costs'
import {
  decodeInferenceExpenseQuote,
  inferenceExpenseBatchSize,
  inferenceExpenseCoverageFrom,
  InferenceExpenseSourceSchema,
  verifyInferenceExpenseQuote,
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
    if (rows.length > 10_000)
      return yield* new InferenceCostError({ message: 'Inference expense session exceeds the complete-report limit' })
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
  const newSources = sql<Record<string, unknown>>`
    WITH pending_requests AS MATERIALIZED (
      SELECT request.request_id
      FROM autonomous_cycles AS cycle
      JOIN jev_evaluation_requests AS request ON request.cycle_id = cycle.cycle_id
      LEFT JOIN jev_evaluation_resolutions AS resolution ON resolution.request_id = request.request_id
      LEFT JOIN jev_evaluation_receipts AS receipt ON receipt.request_id = request.request_id
      LEFT JOIN jev_inference_handoffs AS handoff ON handoff.request_id = request.request_id
      LEFT JOIN jev_chart_dispatch_claims AS chart_claim ON chart_claim.request_id = request.request_id
      LEFT JOIN jev_chart_terminal_receipts AS chart_terminal ON chart_terminal.request_id = request.request_id
      LEFT JOIN inference_expense_quotes AS quote ON quote.request_id = request.request_id
        AND quote.handoff_hash IS NOT DISTINCT FROM CASE
          WHEN request.schema_version='bayn.jev-evaluation-request.v3' AND (
            EXISTS (SELECT 1 FROM jev_staged_dispatch_claims WHERE request_id=request.request_id AND stage=quote.provider_stage)
            OR EXISTS (SELECT 1 FROM jev_staged_skip_receipts WHERE request_id=request.request_id AND stage=quote.provider_stage)) THEN NULL
          WHEN quote.provider_stage='CHART' AND chart_claim.request_id IS NOT NULL THEN NULL ELSE handoff.handoff_hash END
        AND quote.chart_claim_hash IS NOT DISTINCT FROM CASE WHEN quote.provider_stage='CHART' THEN chart_claim.claim_hash ELSE NULL END
        AND quote.chart_terminal_hash IS NOT DISTINCT FROM CASE WHEN quote.provider_stage='CHART' THEN chart_terminal.terminal_hash ELSE NULL END
        AND quote.stage_claim_hash IS NOT DISTINCT FROM CASE WHEN request.schema_version='bayn.jev-evaluation-request.v3'
          THEN (SELECT claim_hash FROM jev_staged_dispatch_claims WHERE request_id=request.request_id AND stage=quote.provider_stage) ELSE NULL END
        AND quote.stage_terminal_hash IS NOT DISTINCT FROM CASE WHEN request.schema_version='bayn.jev-evaluation-request.v3'
          THEN (SELECT terminal_hash FROM jev_staged_terminal_receipts WHERE request_id=request.request_id AND stage=quote.provider_stage) ELSE NULL END
        AND quote.stage_skip_hash IS NOT DISTINCT FROM CASE WHEN request.schema_version='bayn.jev-evaluation-request.v3'
          THEN (SELECT skip_hash FROM jev_staged_skip_receipts WHERE request_id=request.request_id AND stage=quote.provider_stage) ELSE NULL END
        AND quote.receipt_hash IS NOT DISTINCT FROM CASE
          WHEN request.schema_version='bayn.jev-evaluation-request.v3' AND (
            EXISTS (SELECT 1 FROM jev_staged_dispatch_claims WHERE request_id=request.request_id AND stage=quote.provider_stage)
            OR EXISTS (SELECT 1 FROM jev_staged_skip_receipts WHERE request_id=request.request_id AND stage=quote.provider_stage)) THEN NULL
          WHEN quote.provider_stage='CHART' AND chart_claim.request_id IS NOT NULL THEN NULL
          WHEN request.schema_version='bayn.jev-evaluation-request.v3' AND quote.provider_stage IN ('CHART','BASE_START')
            AND NOT COALESCE(receipt.payload #>> '{outcome,failure}' = 'NOT_DISPATCHED', false) THEN NULL
          WHEN quote.provider_stage = 'CHART' AND NOT COALESCE(receipt.payload #>> '{outcome,failure}' = 'NOT_DISPATCHED', false) THEN NULL
          WHEN quote.provider_stage = 'JEV' AND handoff.handoff_hash IS NOT NULL AND handoff.payload #>> '{disposition,status}' <> 'READY' THEN NULL
          ELSE receipt.receipt_hash END
      WHERE cycle.account_id = ${accountId} AND cycle.execution_session_date >= ${coverageFrom}::date
        AND (resolution.request_id IS NOT NULL OR chart_claim.request_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM jev_staged_dispatch_claims WHERE request_id=request.request_id)
          OR EXISTS (SELECT 1 FROM jev_staged_skip_receipts WHERE request_id=request.request_id))
      GROUP BY request.request_id, request.schema_version, resolution.request_id, chart_claim.request_id
      HAVING count(quote.request_id) < CASE
        WHEN request.schema_version='bayn.jev-evaluation-request.v3' AND resolution.request_id IS NULL THEN
          (SELECT count(*) FROM jev_staged_dispatch_claims WHERE request_id=request.request_id) +
          (SELECT count(*) FROM jev_staged_skip_receipts WHERE request_id=request.request_id)
        WHEN request.schema_version='bayn.jev-evaluation-request.v3' THEN 3
        WHEN chart_claim.request_id IS NOT NULL AND resolution.request_id IS NULL THEN 1
        WHEN request.schema_version='bayn.jev-evaluation-request.v2' THEN 2 ELSE 1 END
      ORDER BY request.request_id COLLATE "C" LIMIT ${inferenceExpenseBatchSize}
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
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const quote = yield* Effect.fromResult(decodeInferenceExpenseQuote(row.payload))
          if (quote.quoteHash !== row.quoteHash)
            return yield* new InferenceCostError({ message: 'Pending inference expense quote identity differs' })
          return yield* Effect.fromResult(verifyInferenceExpenseQuote(row.source, quote))
        }),
      ),
    ),
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
      ORDER BY quote_hash COLLATE "C" LIMIT 10001
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
  return { newSources, freeze, pending, acknowledge, session, currentSession }
}
