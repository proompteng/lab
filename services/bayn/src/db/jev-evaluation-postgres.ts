import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Schema } from 'effect'

import { operationalError } from '../errors'
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  type JevEvaluationReceipt,
  type JevEvaluationRequest,
} from '../jev/evidence'
import { JevClaim, JevEvaluationStore, type JevEvaluationClaim } from '../jev/evaluation'
import { Sha256Schema, strictParseOptions } from '../schemas'

const StoredRow = Schema.Struct({ request: Schema.Unknown, receipt: Schema.NullOr(Schema.Unknown) })
const Matches = Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })])

export const makeJevEvaluationStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const persistError = (cause: unknown) =>
    operationalError({
      component: 'database',
      operation: 'jev-evaluation',
      message: 'Jev evaluation evidence could not be durably verified',
      cause,
    })
  const requireAutocommit = Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
      return yield* persistError('Jev evidence must commit independently before inference or decision use')
    }
  })
  return {
    begin: (input: JevEvaluationRequest) =>
      Effect.gen(function* () {
        yield* requireAutocommit
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(input))
        const inserted = yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ request_id: Sha256Schema })),
          strictParseOptions,
        )(
          yield* sql`
          INSERT INTO jev_evaluation_requests (request_id, cycle_id, authority_generation_hash, payload)
          VALUES (${request.requestId}, ${request.cycleId}, ${request.authorityGenerationHash}, ${sql.json(request)})
          ON CONFLICT (request_id) DO NOTHING RETURNING request_id
        `,
        )
        if (inserted.length === 1 && inserted[0]?.request_id === request.requestId) {
          return { status: JevClaim.Acquired } satisfies JevEvaluationClaim
        }
        const [row] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([StoredRow]),
          strictParseOptions,
        )(
          yield* sql`
          SELECT request.payload AS request, receipt.payload AS receipt
          FROM jev_evaluation_requests AS request
          LEFT JOIN jev_evaluation_receipts AS receipt USING (request_id)
          WHERE request.request_id = ${request.requestId}
        `,
        )
        const stored = yield* Effect.fromResult(decodeJevEvaluationRequest(row.request))
        if (stored.requestId !== request.requestId) {
          return yield* persistError('Stored Jev request differs from the claimed identity')
        }
        return row.receipt === null
          ? ({ status: JevClaim.Pending } satisfies JevEvaluationClaim)
          : ({
              status: JevClaim.Recorded,
              receipt: yield* Effect.fromResult(decodeJevEvaluationReceipt(request, row.receipt)),
            } satisfies JevEvaluationClaim)
      }).pipe(Effect.mapError(persistError)),
    record: (input: JevEvaluationRequest, evidence: JevEvaluationReceipt) =>
      Effect.gen(function* () {
        yield* requireAutocommit
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(input))
        const receipt = yield* Effect.fromResult(decodeJevEvaluationReceipt(request, evidence))
        yield* Schema.decodeUnknownEffect(
          Matches,
          strictParseOptions,
        )(
          yield* sql`
          SELECT payload = ${sql.json(request)} AS matches
          FROM jev_evaluation_requests WHERE request_id = ${request.requestId}
        `,
        )
        yield* sql`
          INSERT INTO jev_evaluation_receipts (request_id, receipt_hash, payload)
          VALUES (${request.requestId}, ${receipt.receiptHash}, ${sql.json(receipt)})
          ON CONFLICT (request_id) DO NOTHING
        `
        yield* Schema.decodeUnknownEffect(
          Matches,
          strictParseOptions,
        )(
          yield* sql`
          SELECT receipt_hash = ${receipt.receiptHash} AND payload = ${sql.json(receipt)} AS matches
          FROM jev_evaluation_receipts WHERE request_id = ${request.requestId}
        `,
        )
      }).pipe(Effect.mapError(persistError)),
  }
})

export const JevEvaluationStoreLive = Layer.effect(JevEvaluationStore, makeJevEvaluationStore)
