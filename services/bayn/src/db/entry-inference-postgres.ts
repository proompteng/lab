import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Schema } from 'effect'

import { operationalError } from '../errors'
import { decodeJevEvaluationRequest } from '../jev/evidence'
import { EntryInferenceJournal, type EntryHandoff } from '../jev/entry-inference'
import { decodeEntryHandoff } from '../jev/entry-inference-evidence'
import { strictParseOptions } from '../schemas'
import {
  decodeChartCheckpoint,
  verifyChartCheckpointHandoff,
  type ChartDispatchClaim,
  type ChartTerminalReceipt,
} from '../jev/chart-checkpoint'

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
    recordChartClaim: (input: ChartDispatchClaim) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
          return yield* failed('Chart admission must commit independently before provider I/O')
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const [row] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ payload: Schema.Unknown })]))(
              yield* sql`SELECT payload FROM jev_evaluation_requests WHERE request_id=${input.requestId} FOR UPDATE`,
            )
            const request = yield* Effect.fromResult(decodeJevEvaluationRequest(row.payload))
            yield* Effect.fromResult(decodeChartCheckpoint(request, { claim: input, terminal: null }))
            const existing =
              yield* sql`SELECT payload FROM jev_chart_dispatch_claims WHERE request_id=${input.requestId}`
            if (existing.length > 0) {
              yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]))(
                yield* sql`SELECT payload=${sql.json(input)} AS matches FROM jev_chart_dispatch_claims WHERE request_id=${input.requestId}`,
              )
              return { dispatchAllowed: false }
            }
            const rows = yield* sql`INSERT INTO jev_chart_dispatch_claims (request_id, claim_hash, payload)
          SELECT ${input.requestId}, ${input.claimHash}, ${sql.json(input)}
          FROM jev_evaluation_requests AS request JOIN autonomous_cycles AS cycle USING (cycle_id)
          WHERE request.request_id=${input.requestId}
            AND execution_account_commit_now(cycle.account_id) < ${input.expiresAt}::timestamptz
            AND NOT EXISTS (SELECT 1 FROM jev_evaluation_resolutions WHERE request_id=${input.requestId})
            AND NOT EXISTS (SELECT 1 FROM jev_inference_handoffs WHERE request_id=${input.requestId})
          RETURNING claim_hash`
            return { dispatchAllowed: rows.length === 1 }
          }),
        )
      }).pipe(Effect.mapError(failed)),
    recordChartTerminal: (input: ChartTerminalReceipt) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
          return yield* failed('Chart terminal evidence must commit independently before the handoff')
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const [row] = yield* Schema.decodeUnknownEffect(
              Schema.Tuple([Schema.Struct({ request: Schema.Unknown, claim: Schema.Unknown })]),
            )(
              yield* sql`SELECT request.payload AS request, claim.payload AS claim
            FROM jev_evaluation_requests request JOIN jev_chart_dispatch_claims claim USING (request_id)
            WHERE request.request_id=${input.requestId} FOR UPDATE OF request`,
            )
            const request = yield* Effect.fromResult(decodeJevEvaluationRequest(row.request))
            yield* Effect.fromResult(decodeChartCheckpoint(request, { claim: row.claim, terminal: input }))
            yield* sql`INSERT INTO jev_chart_terminal_receipts (request_id, claim_hash, terminal_hash, payload)
          VALUES (${input.requestId},${input.claimHash},${input.terminalHash},${sql.json(input)})
          ON CONFLICT (request_id) DO NOTHING`
            yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]))(
              yield* sql`SELECT payload=${sql.json(input)} AS matches FROM jev_chart_terminal_receipts WHERE request_id=${input.requestId}`,
            )
          }),
        )
      }).pipe(Effect.mapError(failed)),
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
            const checkpoints = yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ claim: Schema.Unknown, terminal: Schema.NullOr(Schema.Unknown) })),
            )(
              yield* sql`SELECT claim.payload AS claim, terminal.payload AS terminal
                FROM jev_chart_dispatch_claims claim LEFT JOIN jev_chart_terminal_receipts terminal USING (request_id)
                WHERE claim.request_id=${request.requestId}`,
            )
            for (const checkpoint of checkpoints) {
              const verified = yield* Effect.fromResult(decodeChartCheckpoint(request, checkpoint))
              yield* Effect.fromResult(verifyChartCheckpointHandoff(verified, handoff))
            }
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
