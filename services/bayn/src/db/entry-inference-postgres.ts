import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Schema } from 'effect'

import { operationalError } from '../errors'
import { decodeJevEvaluationRequest } from '../jev/evidence'
import { EntryInferenceJournal, type EntryHandoff } from '../jev/entry-inference'
import { decodeEntryHandoff } from '../jev/entry-inference-evidence'
import { strictParseOptions } from '../schemas'
import { decodeStagedCheckpoint, type StagedDispatchClaim, type StagedTerminalReceipt } from '../jev/staged-checkpoint'
import { verifyStagedCheckpointHandoff } from '../jev/staged-inference-cost-evidence'

export const makeEntryInferenceJournal = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const failed = (cause: unknown) =>
    operationalError({
      component: 'database',
      operation: 'entry-inference-handoff',
      message: 'Provider handoff could not be durably verified',
      cause,
    })
  const load = (requestId: string) =>
    Effect.gen(function* () {
      const [row] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ payload: Schema.Unknown })]))(
        yield* sql`SELECT payload FROM jev_evaluation_requests WHERE request_id=${requestId} FOR UPDATE`,
      )
      const rows = (values: unknown) =>
        Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ payload: Schema.Unknown })))(values)
      const claims = yield* rows(
        yield* sql`SELECT payload FROM jev_staged_dispatch_claims WHERE request_id=${requestId} ORDER BY stage`,
      )
      const terminals = yield* rows(
        yield* sql`SELECT payload FROM jev_staged_terminal_receipts WHERE request_id=${requestId} ORDER BY stage`,
      )
      const skips = yield* rows(
        yield* sql`SELECT payload FROM jev_staged_skip_receipts WHERE request_id=${requestId} ORDER BY stage`,
      )
      const checkpoint = yield* Effect.fromResult(
        decodeStagedCheckpoint(row.payload, {
          claims: claims.map((row) => row.payload),
          terminals: terminals.map((row) => row.payload),
          skips: skips.map((row) => row.payload),
        }),
      )
      return { request: row.payload, checkpoint }
    })
  return {
    recordVisualClaim: (input: StagedDispatchClaim) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
          return yield* failed('Visual admission must commit independently before provider I/O')
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const { request, checkpoint } = yield* load(input.requestId)
            const existing = checkpoint.claims.find((row) => row.stage === input.stage)
            yield* Effect.fromResult(
              decodeStagedCheckpoint(request, {
                ...checkpoint,
                claims: [...checkpoint.claims.filter((row) => row.stage !== input.stage), input],
              }),
            )
            if (existing !== undefined) {
              yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]))(
                yield* sql`SELECT payload=${sql.json(input)} AS matches FROM jev_staged_dispatch_claims WHERE request_id=${input.requestId} AND stage=${input.stage}`,
              )
              return { dispatchAllowed: false }
            }
            const rows = yield* sql`INSERT INTO jev_staged_dispatch_claims (request_id, stage, claim_hash, payload)
          SELECT ${input.requestId}, ${input.stage}, ${input.claimHash}, ${sql.json(input)}
          FROM jev_evaluation_requests request JOIN autonomous_cycles cycle USING(cycle_id)
          WHERE request.request_id=${input.requestId}
            AND execution_account_commit_now(cycle.account_id) < ${input.expiresAt}::timestamptz
            AND NOT EXISTS (SELECT 1 FROM jev_evaluation_resolutions WHERE request_id=${input.requestId})
            AND NOT EXISTS (SELECT 1 FROM jev_inference_handoffs WHERE request_id=${input.requestId})
          RETURNING claim_hash`
            return { dispatchAllowed: rows.length === 1 }
          }),
        )
      }).pipe(Effect.mapError(failed)),
    recordVisualTerminal: (input: StagedTerminalReceipt) =>
      Effect.gen(function* () {
        if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
          return yield* failed('Visual terminal evidence must commit independently before its successor')
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const { request, checkpoint } = yield* load(input.requestId)
            yield* Effect.fromResult(
              decodeStagedCheckpoint(request, {
                ...checkpoint,
                terminals: [...checkpoint.terminals.filter((row) => row.stage !== input.stage), input],
              }),
            )
            yield* sql`INSERT INTO jev_staged_terminal_receipts (request_id,stage,claim_hash,terminal_hash,payload)
          VALUES (${input.requestId},${input.stage},${input.claimHash},${input.terminalHash},${sql.json(input)})
          ON CONFLICT(request_id,stage) DO NOTHING`
            yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]))(
              yield* sql`SELECT payload=${sql.json(input)} AS matches FROM jev_staged_terminal_receipts WHERE request_id=${input.requestId} AND stage=${input.stage}`,
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
            const { checkpoint } = yield* load(request.requestId)
            const skip = handoff.baseStart?.status === 'NOT_REQUESTED' ? handoff.baseStart.skip : undefined
            const complete =
              skip === undefined
                ? checkpoint
                : yield* Effect.fromResult(decodeStagedCheckpoint(request, { ...checkpoint, skips: [skip] }))
            yield* Effect.fromResult(verifyStagedCheckpointHandoff(complete, handoff))
            if (skip !== undefined) {
              // The code-owned skip and its handoff have no provider I/O between them.
              // Commit both before allowing the dependent Jev call.
              yield* sql`INSERT INTO jev_staged_skip_receipts (request_id,stage,skip_hash,payload)
                VALUES (${skip.requestId},${skip.stage},${skip.skipHash},${sql.json(skip)})
                ON CONFLICT(request_id,stage) DO NOTHING`
              yield* Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]))(
                yield* sql`SELECT payload=${sql.json(skip)} AS matches
                  FROM jev_staged_skip_receipts WHERE request_id=${skip.requestId} AND stage=${skip.stage}`,
              )
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
