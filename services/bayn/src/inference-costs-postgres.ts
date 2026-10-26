import { PgClient } from '@effect/sql-pg'
import { randomUUID } from 'node:crypto'
import { Effect, Schema } from 'effect'

import { canonicalHashV1Result } from './hash'
import {
  InferenceCostError,
  InferenceCostRequestSchema,
  decodeInferenceCostRequest,
  type DecodedInferenceCostEvidence,
  type DecodedInferenceCostRequest,
} from './inference-costs'
import type { InferenceExpenseRecord } from './inference-expense'
import { decodeInferenceExpenseSessionRows } from './inference-expense-postgres'
import { IsoDateSchema, StrictNonEmptyStringSchema, UtcInstantSchema } from './schemas'
import type { WriterFenceService } from './execution/writer-fence'
import { forwardPerformanceSnapshot } from './forward-performance/postgres/snapshot'

const maximumRequests = 10_000

enum SnapshotRowKind {
  Cut = 'CUT',
  Request = 'REQUEST',
  Quote = 'QUOTE',
}

const SnapshotSchema = Schema.Array(
  Schema.Union([
    Schema.Struct({
      as_of: UtcInstantSchema,
      request_count: Schema.Int,
      quote_count: Schema.Int,
      kind: Schema.Literal(SnapshotRowKind.Cut),
      payload: Schema.Null,
    }),
    Schema.Struct({
      as_of: UtcInstantSchema,
      request_count: Schema.Int,
      quote_count: Schema.Int,
      kind: Schema.Literal(SnapshotRowKind.Request),
      payload: InferenceCostRequestSchema,
    }),
    Schema.Struct({
      as_of: UtcInstantSchema,
      request_count: Schema.Int,
      quote_count: Schema.Int,
      kind: Schema.Literal(SnapshotRowKind.Quote),
      payload: Schema.Unknown,
    }),
  ]),
)

/** Session attribution includes every claimed request, even for blocked, unfilled, and no-trade cycles. */
export const readInferenceExpenseSnapshot = (
  sql: PgClient.PgClient,
  accountId: string,
  sessionDate: string,
  writerFence?: WriterFenceService,
): Effect.Effect<
  { readonly evidence: DecodedInferenceCostEvidence; readonly quotes: readonly InferenceExpenseRecord[] },
  InferenceCostError
> =>
  Effect.gen(function* () {
    const scope = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ accountId: StrictNonEmptyStringSchema, sessionDate: IsoDateSchema }),
    )({ accountId, sessionDate }).pipe(
      Effect.mapError(() => new InferenceCostError({ message: 'Inference cost account or session is malformed' })),
    )
    const accountBindingHash = yield* Effect.fromResult(
      canonicalHashV1Result({ schemaVersion: 'bayn.inference-cost-account.v1', accountId: scope.accountId }),
    ).pipe(Effect.mapError(() => new InferenceCostError({ message: 'Inference account binding cannot be hashed' })))
    return yield* forwardPerformanceSnapshot(sql, writerFence)
      .withTransaction(
        Effect.gen(function* () {
          // The transaction owns this non-holdable cursor, including rollback cleanup on failure or interruption.
          // Every fetch uses its original MVCC snapshot even inside a READ COMMITTED writer transaction.
          const cursor = sql(`bayn_expense_${yield* Effect.sync(randomUUID)}`)
          yield* sql`
            DECLARE ${cursor} NO SCROLL CURSOR WITHOUT HOLD FOR
            WITH cut AS (
              SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of,
                (SELECT count(*)::integer FROM (
                  SELECT 1 FROM jev_evaluation_requests AS request
                  JOIN autonomous_cycles AS cycle ON cycle.cycle_id = request.cycle_id
                  WHERE cycle.account_id = ${scope.accountId}
                    AND cycle.execution_session_date = ${scope.sessionDate}::date
                  LIMIT ${maximumRequests + 1}
                ) AS requests) AS request_count,
                (SELECT count(*)::integer FROM (
                  SELECT 1 FROM inference_expense_quotes
                  WHERE account_id = ${scope.accountId} AND session_date = ${scope.sessionDate}::date
                  LIMIT ${maximumRequests + 1}
                ) AS quotes) AS quote_count
            )
            SELECT cut.as_of, cut.request_count, cut.quote_count, 'CUT'::text AS kind, NULL::jsonb AS payload FROM cut
            UNION ALL
            SELECT cut.as_of, cut.request_count, cut.quote_count, 'REQUEST', (to_jsonb(item) - 'chartCheckpoint' - 'stagedCheckpoint') ||
              CASE WHEN item."chartCheckpoint" IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('chartCheckpoint', item."chartCheckpoint") END ||
              CASE WHEN item."stagedCheckpoint" IS NULL THEN '{}'::jsonb
                ELSE jsonb_build_object('stagedCheckpoint', item."stagedCheckpoint") END
              FROM cut CROSS JOIN (
                SELECT request.request_id AS "requestId", request.cycle_id AS "cycleId",
                  request.authority_generation_hash AS "authorityGenerationHash",
                  request.payload AS request, receipt.payload AS receipt, resolution.payload AS resolution, handoff.payload AS handoff,
                  CASE WHEN chart_claim.request_id IS NULL THEN NULL ELSE
                    jsonb_build_object('claim', chart_claim.payload, 'terminal', chart_terminal.payload) END AS "chartCheckpoint",
                  CASE WHEN request.schema_version='bayn.jev-evaluation-request.v3' THEN jsonb_build_object(
                    'claims', COALESCE((SELECT jsonb_agg(payload ORDER BY stage COLLATE "C") FROM jev_staged_dispatch_claims WHERE request_id=request.request_id),'[]'::jsonb),
                    'terminals', COALESCE((SELECT jsonb_agg(payload ORDER BY stage COLLATE "C") FROM jev_staged_terminal_receipts WHERE request_id=request.request_id),'[]'::jsonb),
                    'skips', COALESCE((SELECT jsonb_agg(payload ORDER BY stage COLLATE "C") FROM jev_staged_skip_receipts WHERE request_id=request.request_id),'[]'::jsonb)
                  ) END AS "stagedCheckpoint"
                FROM jev_evaluation_requests AS request
                JOIN autonomous_cycles AS cycle ON cycle.cycle_id = request.cycle_id
                LEFT JOIN jev_evaluation_receipts AS receipt ON receipt.request_id = request.request_id
                LEFT JOIN jev_evaluation_resolutions AS resolution ON resolution.request_id = request.request_id
                LEFT JOIN jev_inference_handoffs AS handoff ON handoff.request_id = request.request_id
                LEFT JOIN jev_chart_dispatch_claims AS chart_claim ON chart_claim.request_id = request.request_id
                LEFT JOIN jev_chart_terminal_receipts AS chart_terminal ON chart_terminal.request_id = request.request_id
                WHERE cycle.account_id = ${scope.accountId}
                  AND cycle.execution_session_date = ${scope.sessionDate}::date
                LIMIT ${maximumRequests + 1}
              ) AS item
            UNION ALL
            SELECT cut.as_of, cut.request_count, cut.quote_count, 'QUOTE', to_jsonb(item)
              FROM cut CROSS JOIN (
                SELECT quote_hash AS "quoteHash", payload,
                  to_char(verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "verifiedAt"
                FROM inference_expense_quotes
                WHERE account_id = ${scope.accountId} AND session_date = ${scope.sessionDate}::date
                ORDER BY quote_hash COLLATE "C" LIMIT ${maximumRequests + 1}
              ) AS item
          `
          const rows: Array<(typeof SnapshotSchema.Type)[number]> = []
          const requests: DecodedInferenceCostRequest[] = []
          while (true) {
            // A single source row bounds FETCH's utility-result spool as well as each statement's work.
            const batch = yield* sql<Record<string, unknown>>`FETCH NEXT FROM ${cursor}`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(SnapshotSchema)),
            )
            if (batch.length === 0) break
            for (const row of batch) {
              if (row.request_count > maximumRequests || row.quote_count > maximumRequests)
                return yield* new InferenceCostError({
                  message: 'Inference cost read exceeded its complete-report limit',
                })
              if (row.kind === SnapshotRowKind.Request) {
                if (requests.length === maximumRequests)
                  return yield* new InferenceCostError({
                    message: 'Inference cost read exceeded its complete-report limit',
                  })
                requests.push(yield* Effect.fromResult(decodeInferenceCostRequest(row.payload, row.as_of)))
              }
            }
            rows.push(...batch)
          }
          yield* sql`CLOSE ${cursor}`
          const cuts = rows.filter((row) => row.kind === SnapshotRowKind.Cut)
          const cut = cuts[0]
          if (
            cuts.length !== 1 ||
            cut === undefined ||
            rows.some(
              (row) =>
                row.as_of !== cut.as_of ||
                row.request_count !== cut.request_count ||
                row.quote_count !== cut.quote_count,
            )
          )
            return yield* new InferenceCostError({ message: 'Inference cost snapshot time is unavailable' })
          const quoteRows = rows.flatMap((row) => (row.kind === SnapshotRowKind.Quote ? [row.payload] : []))
          if (requests.length !== cut.request_count || quoteRows.length !== cut.quote_count)
            return yield* new InferenceCostError({ message: 'Inference cost snapshot row coverage differs' })
          const evidence: DecodedInferenceCostEvidence = {
            schemaVersion: requests.some((row) => row.stagedCheckpoint !== undefined)
              ? 'bayn.inference-cost-evidence.v4'
              : requests.some((row) => row.chartCheckpoint !== undefined)
                ? 'bayn.inference-cost-evidence.v3'
                : 'bayn.inference-cost-evidence.v2',
            accountBindingHash,
            sessionDate: scope.sessionDate,
            asOf: cut.as_of,
            requests,
          }
          const quotes = yield* decodeInferenceExpenseSessionRows(quoteRows, scope.sessionDate)
          return {
            evidence: {
              ...evidence,
              requests: evidence.requests.toSorted((left, right) =>
                left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0,
              ),
            },
            quotes,
          }
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof InferenceCostError
            ? cause
            : new InferenceCostError({ message: 'Inference cost evidence snapshot failed', cause }),
        ),
      )
  })
