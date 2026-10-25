import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { canonicalHashV1Result } from './hash'
import {
  InferenceCostError,
  InferenceCostEvidenceSchema,
  InferenceCostRequestSchema,
  type InferenceCostEvidence,
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
    Schema.Struct({ as_of: UtcInstantSchema, kind: Schema.Literal(SnapshotRowKind.Cut), payload: Schema.Null }),
    Schema.Struct({
      as_of: UtcInstantSchema,
      kind: Schema.Literal(SnapshotRowKind.Request),
      payload: InferenceCostRequestSchema,
    }),
    Schema.Struct({ as_of: UtcInstantSchema, kind: Schema.Literal(SnapshotRowKind.Quote), payload: Schema.Unknown }),
  ]),
)

/** Session attribution includes every claimed request, even for blocked, unfilled, and no-trade cycles. */
export const readInferenceExpenseSnapshot = (
  sql: PgClient.PgClient,
  accountId: string,
  sessionDate: string,
  writerFence?: WriterFenceService,
): Effect.Effect<
  { readonly evidence: InferenceCostEvidence; readonly quotes: readonly InferenceExpenseRecord[] },
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
          // One statement also shares a snapshot inside a READ COMMITTED writer transaction.
          // Individual rows avoid the driver's message-size limit on a whole session's JSON.
          const rows = yield* sql<Record<string, unknown>>`
            WITH cut AS (
              SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of
            )
            SELECT cut.as_of, 'CUT'::text AS kind, NULL::jsonb AS payload FROM cut
            UNION ALL
            SELECT cut.as_of, 'REQUEST', to_jsonb(item)
              FROM cut CROSS JOIN (
                SELECT request.request_id AS "requestId", request.cycle_id AS "cycleId",
                  request.authority_generation_hash AS "authorityGenerationHash",
                  request.payload AS request, receipt.payload AS receipt, resolution.payload AS resolution
                FROM jev_evaluation_requests AS request
                JOIN autonomous_cycles AS cycle ON cycle.cycle_id = request.cycle_id
                LEFT JOIN jev_evaluation_receipts AS receipt ON receipt.request_id = request.request_id
                LEFT JOIN jev_evaluation_resolutions AS resolution ON resolution.request_id = request.request_id
                WHERE cycle.account_id = ${scope.accountId}
                  AND cycle.execution_session_date = ${scope.sessionDate}::date
                LIMIT ${maximumRequests + 1}
              ) AS item
            UNION ALL
            SELECT cut.as_of, 'QUOTE', to_jsonb(item)
              FROM cut CROSS JOIN (
                SELECT quote_hash AS "quoteHash", payload,
                  to_char(verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "verifiedAt"
                FROM inference_expense_quotes
                WHERE account_id = ${scope.accountId} AND session_date = ${scope.sessionDate}::date
                ORDER BY quote_hash COLLATE "C" LIMIT ${maximumRequests + 1}
              ) AS item
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(SnapshotSchema)))
          const cuts = rows.filter((row) => row.kind === SnapshotRowKind.Cut)
          const cut = cuts[0]
          if (cuts.length !== 1 || cut === undefined || rows.some((row) => row.as_of !== cut.as_of))
            return yield* new InferenceCostError({ message: 'Inference cost snapshot time is unavailable' })
          const requests = rows.flatMap((row) => (row.kind === SnapshotRowKind.Request ? [row.payload] : []))
          if (requests.length > maximumRequests)
            return yield* new InferenceCostError({ message: 'Inference cost read exceeded its complete-report limit' })
          const evidence = yield* Schema.decodeUnknownEffect(InferenceCostEvidenceSchema)({
            schemaVersion: 'bayn.inference-cost-evidence.v1',
            accountBindingHash,
            sessionDate: scope.sessionDate,
            asOf: cut.as_of,
            requests,
          })
          const quotes = yield* decodeInferenceExpenseSessionRows(
            rows.flatMap((row) => (row.kind === SnapshotRowKind.Quote ? [row.payload] : [])),
            scope.sessionDate,
          )
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
