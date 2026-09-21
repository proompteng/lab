import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, Option, Schema } from 'effect'

import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  type JevEvaluationReceipt,
  type JevEvaluationRequest,
} from '../jev/evidence'
import { JevClaim, JevEvaluationStore, type JevEvaluationClaim } from '../jev/evaluation'
import {
  decodeJevResolution,
  JevResolutionStatus,
  makeJevResolution,
  type JevEvaluationEvidence,
  type JevResolution,
} from '../jev/resolution'
import { Sha256Schema, strictParseOptions } from '../schemas'

const StoredRow = Schema.Struct({
  request: Schema.Unknown,
  receipt: Schema.NullOr(Schema.Unknown),
  resolution: Schema.NullOr(Schema.Unknown),
})
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
  const requireCandidateObservation = (request: JevEvaluationRequest) =>
    Effect.gen(function* () {
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ content_hash: Sha256Schema, payload: Schema.Unknown })),
        strictParseOptions,
      )(
        yield* sql`
        SELECT content_hash, payload FROM intraday_candidate_observations
        WHERE cycle_id = ${request.cycleId}
          AND payload->>'authorityGenerationHash' = ${request.authorityGenerationHash}
          AND payload->>'observedAt' = ${request.observedAt}
          AND payload->'manifest'->>'observedAt' = ${request.observedAt}
          AND payload->'manifest'->>'snapshotId' = ${request.snapshotId}
          AND payload->'manifest'->'candidateSymbols' ? ${request.symbol}
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(payload->'manifest'->'candidateExclusions') AS excluded
            WHERE excluded->>'symbol' = ${request.symbol}
          )
      `,
      )
      if (rows.length === 0)
        return yield* persistError(
          'Jev request has no matching persisted candidate observation for its cycle, generation, snapshot, symbol and time',
        )
      for (const row of rows) {
        if ((yield* Effect.fromResult(canonicalHashV1Result(row.payload))) !== row.content_hash)
          return yield* persistError('Jev candidate observation content differs from its committed identity')
      }
    })
  const read = (input: string) =>
    Effect.gen(function* () {
      const requestId = yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(input)
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(StoredRow),
        strictParseOptions,
      )(
        yield* sql`
        SELECT request.payload AS request, receipt.payload AS receipt, resolution.payload AS resolution
        FROM jev_evaluation_requests AS request
        LEFT JOIN jev_evaluation_receipts AS receipt USING (request_id)
        LEFT JOIN jev_evaluation_resolutions AS resolution USING (request_id)
        WHERE request.request_id = ${requestId}
      `,
      )
      const row = rows[0]
      if (row === undefined) return null
      const request = yield* Effect.fromResult(decodeJevEvaluationRequest(row.request))
      if (request.requestId !== requestId) return yield* persistError('Stored Jev request identity differs')
      yield* requireCandidateObservation(request)
      const receipt =
        row.receipt === null ? null : yield* Effect.fromResult(decodeJevEvaluationReceipt(request, row.receipt))
      const resolution =
        row.resolution === null ? null : yield* Effect.fromResult(decodeJevResolution(request, receipt, row.resolution))
      if (receipt !== null && resolution === null)
        return yield* persistError('A Jev receipt has no committed resolution')
      return { request, receipt, resolution } satisfies JevEvaluationEvidence
    }).pipe(Effect.mapError(persistError))
  const lockRequest = (request: JevEvaluationRequest) =>
    sql`
      SELECT payload = ${sql.json(request)} AS matches
      FROM jev_evaluation_requests WHERE request_id = ${request.requestId} FOR UPDATE
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Matches, strictParseOptions)))
  const insertResolution = (resolution: JevResolution) =>
    sql`
    INSERT INTO jev_evaluation_resolutions (request_id, resolution_hash, payload)
    VALUES (${resolution.requestId}, ${resolution.resolutionHash}, ${sql.json(resolution)})
  `.pipe(Effect.as(resolution))
  return {
    read,
    begin: (input: JevEvaluationRequest) =>
      Effect.gen(function* () {
        yield* requireAutocommit
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(input))
        yield* requireCandidateObservation(request)
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
        const evidence = yield* read(request.requestId)
        if (evidence === null) return yield* persistError('Claimed Jev request is missing')
        if (evidence.resolution?.status === JevResolutionStatus.Abandoned)
          return { status: JevClaim.Abandoned, resolution: evidence.resolution } satisfies JevEvaluationClaim
        if (evidence.resolution?.status === JevResolutionStatus.Recorded && evidence.receipt !== null)
          return {
            status: JevClaim.Recorded,
            receipt: evidence.receipt,
            resolution: evidence.resolution,
          } satisfies JevEvaluationClaim
        return { status: JevClaim.Pending } satisfies JevEvaluationClaim
      }).pipe(Effect.mapError(persistError)),
    record: (input: JevEvaluationRequest, evidence: JevEvaluationReceipt) =>
      Effect.gen(function* () {
        yield* requireAutocommit
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(input))
        const receipt = yield* Effect.fromResult(decodeJevEvaluationReceipt(request, evidence))
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* lockRequest(request)
            const existing = yield* read(request.requestId)
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
            if (existing !== null && existing.resolution !== null) return existing.resolution
            return yield* insertResolution(
              yield* Effect.fromResult(
                makeJevResolution(request, receipt, {
                  schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                  requestId: request.requestId,
                  status: JevResolutionStatus.Recorded,
                  receiptHash: receipt.receiptHash,
                }),
              ),
            )
          }),
        )
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
