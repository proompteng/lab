import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Schema } from 'effect'

import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { decodeJevEvaluationReceipt, decodeJevEvaluationRequest, type JevEvaluationRequest } from '../jev/evidence'
import { JevEvaluationStore, type JevEvaluationRecord } from '../jev/evaluation'
import { JevResolutionStatus, makeJevResolution, type JevResolution } from '../jev/resolution'
import { strictParseOptions } from '../schemas'
import { readJevEvaluationEvidence } from './jev-evaluation-read'

const Matches = Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })])
const persistError = (cause: unknown) =>
  operationalError({
    component: 'database',
    operation: 'jev-evaluation',
    message: 'Jev evaluation evidence could not be durably verified',
    cause,
  })

/** Writes in the caller's transaction so final receipts and their batch share one commit. */
export const recordJevEvaluationReceipts = (sql: PgClient.PgClient, inputs: readonly JevEvaluationRecord[]) =>
  Effect.gen(function* () {
    const entries = yield* Effect.forEach(inputs, (input) =>
      Effect.gen(function* () {
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(input.request))
        return { request, receipt: yield* Effect.fromResult(decodeJevEvaluationReceipt(request, input.receipt)) }
      }),
    )
    if (new Set(entries.map(({ request }) => request.requestId)).size !== entries.length)
      return yield* persistError('A receipt batch repeats a request')
    const resolutions = new Map<string, JevResolution>()
    if (entries.length === 0) return resolutions
    const ids = entries.map(({ request }) => request.requestId)
    const scopes = [
      ...new Map(
        entries.map(({ request }) => [
          `${request.cycleId}/${request.authorityGenerationHash}/${request.snapshotId}`,
          request,
        ]),
      ).values(),
    ]
    const scope = sql.or(
      scopes.map(
        (request) => sql`plan.cycle_id=${request.cycleId}
      AND plan.authority_generation_hash=${request.authorityGenerationHash} AND plan.snapshot_id=${request.snapshotId}`,
      ),
    )
    // Receipt retention and finalization acquire batch locks before request locks.
    yield* sql`SELECT plan.batch_id FROM jev_batch_plans plan
      WHERE ${scope} AND EXISTS (SELECT 1 FROM jsonb_array_elements(plan.payload->'candidates') candidate
        WHERE candidate#>>'{request,requestId}' IN ${sql.in(ids)})
      ORDER BY plan.batch_id COLLATE "C" FOR UPDATE OF plan`
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ request_id: Schema.String, payload: Schema.Unknown })),
      strictParseOptions,
    )(
      yield* sql`SELECT request_id,payload FROM jev_evaluation_requests
        WHERE request_id IN ${sql.in(ids)} ORDER BY request_id COLLATE "C" FOR UPDATE`,
    )
    if (rows.length !== entries.length) return yield* persistError('Receipt batch has a missing request')
    const stored = new Map(rows.map((row) => [row.request_id, row.payload]))
    for (const { request } of entries) {
      if (
        (yield* Effect.fromResult(canonicalHashV1Result(stored.get(request.requestId)))) !==
        (yield* Effect.fromResult(canonicalHashV1Result(request)))
      )
        return yield* persistError('Receipt request differs from its committed payload')
    }
    const { evidence } = yield* readJevEvaluationEvidence(sql, ids)
    yield* sql`INSERT INTO jev_evaluation_receipts ${sql.insert(
      entries.map(({ request, receipt }) => ({
        request_id: request.requestId,
        receipt_hash: receipt.receiptHash,
        payload: sql.json(receipt),
      })),
    )} ON CONFLICT (request_id) DO NOTHING`
    for (const { request, receipt } of entries) {
      yield* Schema.decodeUnknownEffect(
        Matches,
        strictParseOptions,
      )(
        yield* sql`
        SELECT receipt_hash=${receipt.receiptHash} AND payload=${sql.json(receipt)} AS matches
        FROM jev_evaluation_receipts WHERE request_id=${request.requestId}`,
      )
      const existing = evidence.get(request.requestId)?.resolution
      const resolution =
        existing ??
        (yield* Effect.fromResult(
          makeJevResolution(request, receipt, {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: request.requestId,
            status: JevResolutionStatus.Recorded,
            receiptHash: receipt.receiptHash,
          }),
        ))
      if (existing == null)
        yield* sql`INSERT INTO jev_evaluation_resolutions (request_id,resolution_hash,payload)
        VALUES (${request.requestId},${resolution.resolutionHash},${sql.json(resolution)})`
      resolutions.set(request.requestId, resolution)
    }
    return resolutions
  }).pipe(Effect.mapError(persistError))

export const makeJevEvaluationStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const requireAutocommit = Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* persistError('Jev evidence must commit independently before inference or decision use')
  })
  const read = (input: string) =>
    readJevEvaluationEvidence(sql, [input]).pipe(Effect.map(({ evidence }) => evidence.get(input) ?? null))
  const lockRequest = (request: JevEvaluationRequest) =>
    sql`
    SELECT payload=${sql.json(request)} AS matches FROM jev_evaluation_requests WHERE request_id=${request.requestId} FOR UPDATE
  `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Matches, strictParseOptions)))
  const insertResolution = (resolution: JevResolution) =>
    sql`
    INSERT INTO jev_evaluation_resolutions (request_id,resolution_hash,payload)
    VALUES (${resolution.requestId},${resolution.resolutionHash},${sql.json(resolution)})
  `.pipe(Effect.as(resolution))
  return {
    read,
    recordAll: (entries: readonly JevEvaluationRecord[]) =>
      Effect.gen(function* () {
        yield* requireAutocommit
        return yield* sql.withTransaction(recordJevEvaluationReceipts(sql, entries))
      }).pipe(Effect.mapError(persistError)),
    abandon: (input: JevEvaluationRequest, abandonedAt: string) =>
      Effect.gen(function* () {
        yield* requireAutocommit
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(input))
        const resolution = yield* Effect.fromResult(
          makeJevResolution(request, null, {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: request.requestId,
            status: JevResolutionStatus.Abandoned,
            abandonedAt,
          }),
        )
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lockRequest(request)
            const existing = yield* read(request.requestId)
            if (existing !== null && existing.resolution !== null) return existing.resolution
            return yield* insertResolution(resolution)
          }),
        )
      }).pipe(Effect.mapError(persistError)),
  } satisfies typeof JevEvaluationStore.Service
})

export const JevEvaluationStoreLive = Layer.effect(JevEvaluationStore, makeJevEvaluationStore)
