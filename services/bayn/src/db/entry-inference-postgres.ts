import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Schema } from 'effect'

import { operationalError } from '../errors'
import { decodeJevEvaluationRequest } from '../jev/evidence'
import { EntryInferenceJournal, type EntryHandoff } from '../jev/entry-inference'
import { decodeEntryHandoff } from '../jev/entry-inference-evidence'
import { strictParseOptions } from '../schemas'

export const makeEntryInferenceJournal = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const failed = (cause: unknown) =>
    operationalError({
      component: 'database',
      operation: 'entry-inference-handoff',
      message: 'Provider handoff could not be durably verified',
      cause,
    })
  return {
    recordHandoff: (input: EntryHandoff) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
          return yield* failed('The provider handoff must commit independently before dependent inference')
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const [row] = yield* Schema.decodeUnknownEffect(
              Schema.Tuple([Schema.Struct({ payload: Schema.Unknown })]),
              strictParseOptions,
            )(yield* sql`SELECT payload FROM jev_evaluation_requests WHERE request_id = ${input.requestId} FOR UPDATE`)
            const request = yield* Effect.fromResult(decodeJevEvaluationRequest(row.payload))
            const handoff = yield* Effect.fromResult(
              decodeEntryHandoff(
                {
                  requestId: request.requestId,
                  input: request.request,
                  observedAt: request.observedAt,
                  expiresAt: request.expiresAt,
                },
                input,
              ),
            )
            const inserted = yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ handoff_hash: Schema.String })),
              strictParseOptions,
            )(
              yield* sql`INSERT INTO jev_inference_handoffs (request_id, handoff_hash, payload)
            VALUES (${request.requestId}, ${handoff.handoffHash}, ${sql.json(handoff)})
            ON CONFLICT (request_id) DO NOTHING RETURNING handoff_hash`,
            )
            yield* Schema.decodeUnknownEffect(
              Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]),
              strictParseOptions,
            )(
              yield* sql`SELECT handoff_hash = ${handoff.handoffHash} AND payload = ${sql.json(handoff)} AS matches
            FROM jev_inference_handoffs WHERE request_id = ${request.requestId}`,
            )
            const [resolution] = yield* Schema.decodeUnknownEffect(
              Schema.Tuple([Schema.Struct({ resolved: Schema.Boolean })]),
              strictParseOptions,
            )(
              yield* sql`SELECT EXISTS (SELECT 1 FROM jev_evaluation_resolutions WHERE request_id = ${request.requestId}) AS resolved`,
            )
            return { dispatchAllowed: inserted.length === 1 && !resolution.resolved }
          }),
        )
      }).pipe(Effect.mapError(failed)),
  } satisfies typeof EntryInferenceJournal.Service
})

export const EntryInferenceJournalLive = Layer.effect(EntryInferenceJournal, makeEntryInferenceJournal)
