import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Layer, Option, Schema, type Result } from 'effect'

import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { withObservedStage } from '../telemetry'
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  type JevEvaluationReceipt,
  type JevEvaluationRequest,
} from '../jev/evidence'
import { JevClaim, JevEvaluationStore, type JevEvaluationClaim } from '../jev/evaluation'
import { reproduceJevCandidateObservation } from '../jev/observation'
import { reproduceJevRequestFromVerifiedObservation } from '../jev/trading-signals'
import {
  decodeJevBatchPlan,
  decodeJevBatchResult,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  makeJevBatchResult,
} from '../jev/batch'
import { JevPurpose } from '../jev/portfolio'
import { utcInstantFromEpochMillis } from '../time'
import { JevResolutionStatus, makeJevResolution, type JevResolution } from '../jev/resolution'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { readJevEvaluationEvidence, requireJevCandidateObservations } from './jev-evaluation-read'

const Matches = Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })])

export const makeJevEvaluationStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  let verifiedObservation: Result.Result.Success<ReturnType<typeof reproduceJevCandidateObservation>> | undefined
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
  const requireCandidateObservation = (request: JevEvaluationRequest) => requireJevCandidateObservations(sql, [request])
  const read = (input: string) =>
    readJevEvaluationEvidence(sql, [input]).pipe(Effect.map((evidence) => evidence.get(input) ?? null))
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
  // Finalization and receipt recording take the batch lock before the request lock.
  // Native batches with one requested candidate can share a commit. Filter before
  // locking so multiple-request entry batches retain independent receipt writes.
  const lockSingleRequestBatch = (request: JevEvaluationRequest) =>
    Effect.gen(function* () {
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ plan: Schema.Unknown })),
        strictParseOptions,
      )(
        yield* sql`
          SELECT plan.payload AS plan
          FROM jev_batch_plans AS plan
          WHERE plan.cycle_id = ${request.cycleId}
            AND plan.authority_generation_hash = ${request.authorityGenerationHash}
            AND plan.snapshot_id = ${request.snapshotId}
            AND (
              (
                jsonb_array_length(plan.payload->'candidates') = 1
                AND plan.payload #>> '{candidates,0,request,request,state,task,decisionPurpose}' = ${JevPurpose.Manage}
                AND plan.payload #> '{candidates,0,request}' = ${sql.json(request)}
              ) OR (
                SELECT count(*) FILTER (WHERE candidate->>'status' = 'REQUESTED') = 1
                  AND bool_and(
                    candidate->>'status' = 'EXCLUDED' OR (
                      candidate->>'status' = 'REQUESTED'
                      AND candidate #>> '{request,request,state,task,decisionPurpose}' = ${JevPurpose.Entry}
                      AND candidate->'request' = ${sql.json(request)}
                    )
                  )
                FROM jsonb_array_elements(plan.payload->'candidates') AS candidate
              )
            )
          FOR UPDATE OF plan
        `,
      )
      if (rows.length > 1) return yield* persistError('Jev request belongs to multiple single-request batches')
      const row = rows[0]
      if (row === undefined) return null
      const plan = yield* Effect.fromResult(decodeJevBatchPlan(row.plan))
      // Read after acquiring the lock: a concurrent finalizer may have inserted
      // its result while this statement waited, without updating the plan row.
      const results = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ payload: Schema.Unknown })),
        strictParseOptions,
      )(yield* sql`SELECT payload FROM jev_batch_results WHERE batch_id = ${plan.batchId}`)
      const stored = results[0]
      const result = stored === undefined ? null : yield* Effect.fromResult(decodeJevBatchResult(plan, stored.payload))
      return { plan, result }
    })
  const finishSingleRequestBatch = (
    batch: NonNullable<Effect.Success<ReturnType<typeof lockSingleRequestBatch>>>,
    request: JevEvaluationRequest,
    receipt: JevEvaluationReceipt,
    resolution: JevResolution,
  ) =>
    Effect.gen(function* () {
      // A late receipt may be retained after abandonment, but cannot replace the
      // immutable batch result or turn an abandoned request into usable evidence.
      if (batch.result !== null || resolution.status !== JevResolutionStatus.Recorded) return
      const observations = yield* Schema.decodeUnknownEffect(
        Schema.Tuple([Schema.Struct({ payload: Schema.Unknown })]),
        strictParseOptions,
      )(
        yield* sql`SELECT payload FROM intraday_candidate_observations WHERE content_hash = ${batch.plan.observationHash}`,
      )
      const observation = observations[0].payload
      if ((yield* Effect.fromResult(canonicalHashV1Result(observation))) !== batch.plan.observationHash)
        return yield* persistError('Jev batch observation bytes differ from their stored hash')
      const now = yield* Clock.currentTimeMillis
      if (now < Date.parse(batch.plan.observedAt))
        return yield* persistError('Jev batch clock regressed before observation')
      const result = yield* Effect.fromResult(
        makeJevBatchResult(batch.plan, {
          schemaVersion: 'bayn.jev-batch-result.v1',
          batchId: batch.plan.batchId,
          completedAt: utcInstantFromEpochMillis(now),
          candidates: batch.plan.candidates.map((candidate) =>
            candidate.status === JevCandidatePlanStatus.Excluded
              ? { symbol: candidate.symbol, status: JevCandidateResultStatus.Excluded }
              : {
                  symbol: candidate.symbol,
                  status: JevCandidateResultStatus.Resolved,
                  requestId: request.requestId,
                  receipt,
                  resolution,
                },
          ),
        }),
      )
      yield* sql`INSERT INTO jev_batch_results (batch_id, result_hash, payload)
        VALUES (${batch.plan.batchId}, ${result.resultHash}, ${sql.json(result)})`
    })
  return {
    read,
    begin: (input: JevEvaluationRequest) =>
      Effect.gen(function* () {
        yield* requireAutocommit
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(input))
        const observations = yield* requireCandidateObservation(request)
        for (const observation of observations) {
          // requireCandidateObservation checks the freshly read bytes against this identity on every call.
          // Retain only the latest reproduction so concurrent candidates share its verified source cut.
          if (verifiedObservation?.contentHash !== observation.content_hash)
            verifiedObservation = yield* Effect.suspend(() =>
              Effect.fromResult(reproduceJevCandidateObservation(observation.payload)),
            ).pipe(withObservedStage('bayn.jev.observation-reproduction'))
          yield* Effect.fromResult(reproduceJevRequestFromVerifiedObservation(request, verifiedObservation))
        }
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const batches = yield* Schema.decodeUnknownEffect(
              Schema.Tuple([Schema.Struct({ batch_id: Sha256Schema })]),
              strictParseOptions,
            )(
              yield* sql`
          SELECT batch_id FROM jev_batch_plans
          WHERE cycle_id = ${request.cycleId}
            AND authority_generation_hash = ${request.authorityGenerationHash}
            AND snapshot_id = ${request.snapshotId}
            AND EXISTS (
              SELECT 1 FROM jsonb_array_elements(payload->'candidates') AS candidate
              WHERE candidate->>'status' = 'REQUESTED' AND candidate->'request' = ${sql.json(request)}
            )
          FOR SHARE
        `,
            )
            const batchId = batches[0].batch_id
            const inserted = yield* Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ request_id: Sha256Schema })),
              strictParseOptions,
            )(
              yield* sql`
          INSERT INTO jev_evaluation_requests (request_id, cycle_id, authority_generation_hash, payload)
          SELECT ${request.requestId}, ${request.cycleId}, ${request.authorityGenerationHash}, ${sql.json(request)}
          WHERE NOT EXISTS (SELECT 1 FROM jev_batch_results WHERE batch_id = ${batchId})
          ON CONFLICT DO NOTHING RETURNING request_id
        `,
            )
            if (inserted.length === 1 && inserted[0]?.request_id === request.requestId) {
              return { status: JevClaim.Acquired } satisfies JevEvaluationClaim
            }
            // Both the request ID and immutable candidate slot are unique. Concurrent identical
            // claims may race on either index; only a readable exact request can be recovered.
            const evidence = yield* read(request.requestId)
            if (evidence === null) return yield* persistError('A finalized Jev batch cannot acquire another request')
            if (evidence.resolution?.status === JevResolutionStatus.Abandoned)
              return { status: JevClaim.Abandoned, resolution: evidence.resolution } satisfies JevEvaluationClaim
            if (evidence.resolution?.status === JevResolutionStatus.Recorded && evidence.receipt !== null)
              return {
                status: JevClaim.Recorded,
                receipt: evidence.receipt,
                resolution: evidence.resolution,
              } satisfies JevEvaluationClaim
            return { status: JevClaim.Pending } satisfies JevEvaluationClaim
          }),
        )
      }).pipe(Effect.mapError(persistError)),
    record: (input: JevEvaluationRequest, evidence: JevEvaluationReceipt) =>
      Effect.gen(function* () {
        yield* requireAutocommit
        const request = yield* Effect.fromResult(decodeJevEvaluationRequest(input))
        const receipt = yield* Effect.fromResult(decodeJevEvaluationReceipt(request, evidence))
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const batch = yield* lockSingleRequestBatch(request)
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
            const resolution =
              existing?.resolution ??
              (yield* insertResolution(
                yield* Effect.fromResult(
                  makeJevResolution(request, receipt, {
                    schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                    requestId: request.requestId,
                    status: JevResolutionStatus.Recorded,
                    receiptHash: receipt.receiptHash,
                  }),
                ),
              ))
            if (batch !== null) yield* finishSingleRequestBatch(batch, request, receipt, resolution)
            return resolution
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
