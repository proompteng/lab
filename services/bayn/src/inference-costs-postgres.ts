import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { canonicalHashV1Result } from './hash'
import { InferenceCostError, InferenceCostEvidenceSchema, type InferenceCostEvidence } from './inference-costs'
import { IsoDateSchema, StrictNonEmptyStringSchema, UtcInstantSchema } from './schemas'

const maximumRequests = 10_000
const CutSchema = Schema.Array(Schema.Struct({ as_of: UtcInstantSchema }))

/** Session attribution includes every claimed request, even for blocked, unfilled, and no-trade cycles. */
export const readInferenceCostEvidence = (
  sql: PgClient.PgClient,
  accountId: string,
  sessionDate: string,
): Effect.Effect<InferenceCostEvidence, InferenceCostError> =>
  Effect.gen(function* () {
    const scope = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ accountId: StrictNonEmptyStringSchema, sessionDate: IsoDateSchema }),
    )({ accountId, sessionDate }).pipe(
      Effect.mapError(() => new InferenceCostError({ message: 'Inference cost account or session is malformed' })),
    )
    const accountBindingHash = yield* Effect.fromResult(
      canonicalHashV1Result({ schemaVersion: 'bayn.inference-cost-account.v1', accountId: scope.accountId }),
    ).pipe(Effect.mapError(() => new InferenceCostError({ message: 'Inference account binding cannot be hashed' })))
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
          const cuts = yield* sql<Record<string, unknown>>`
            SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS as_of
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(CutSchema)))
          const cut = cuts[0]
          if (cuts.length !== 1 || cut === undefined)
            return yield* new InferenceCostError({ message: 'Inference cost snapshot time is unavailable' })
          const requests = yield* sql<Record<string, unknown>>`
            SELECT request.request_id AS "requestId", request.cycle_id AS "cycleId",
              request.authority_generation_hash AS "authorityGenerationHash",
              request.payload AS request, receipt.payload AS receipt, resolution.payload AS resolution
            FROM jev_evaluation_requests AS request
            JOIN autonomous_cycles AS cycle ON cycle.cycle_id = request.cycle_id
            LEFT JOIN jev_evaluation_receipts AS receipt ON receipt.request_id = request.request_id
            LEFT JOIN jev_evaluation_resolutions AS resolution ON resolution.request_id = request.request_id
            WHERE cycle.account_id = ${scope.accountId}
              AND cycle.execution_session_date = ${scope.sessionDate}::date
            ORDER BY request.request_id COLLATE "C"
            LIMIT ${maximumRequests + 1}
          `
          if (requests.length > maximumRequests)
            return yield* new InferenceCostError({ message: 'Inference cost read exceeded its complete-report limit' })
          return yield* Schema.decodeUnknownEffect(InferenceCostEvidenceSchema)({
            schemaVersion: 'bayn.inference-cost-evidence.v1',
            accountBindingHash,
            sessionDate: scope.sessionDate,
            asOf: cut.as_of,
            requests,
          })
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause instanceof InferenceCostError
            ? cause
            : new InferenceCostError({ message: 'Inference cost read-only snapshot failed' }),
        ),
      )
  })
