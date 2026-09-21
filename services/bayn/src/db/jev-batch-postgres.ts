import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Layer, Option, Schema } from 'effect'

import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import {
  decodeJevBatchPlan,
  decodeJevBatchResult,
  JevCandidatePlanStatus,
  JevCandidateResultStatus,
  makeJevBatchResult,
  type JevBatchPlan,
  type JevBatchResult,
} from '../jev/batch'
import { JevBatchStore, type JevBatchEvidence } from '../jev/batch-evaluation'
import { JevEvaluationStore } from '../jev/evaluation'
import { makeJevResolution, JevResolutionStatus } from '../jev/resolution'
import { reproduceJevTradingSignalBatch } from '../jev/trading-signals'
import { Sha256Schema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'

const StoredRow = Schema.Struct({ plan: Schema.Unknown, result: Schema.NullOr(Schema.Unknown) })
const OneBatch = Schema.Tuple([Schema.Struct({ batch_id: Sha256Schema })])

export const makeJevBatchStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const evaluations = yield* JevEvaluationStore
  const persistError = (cause: unknown) =>
    operationalError({
      component: 'database',
      operation: 'jev-batch',
      message: 'Jev batch evidence could not be durably verified',
      cause,
    })
  const requireAutocommit = Effect.gen(function* () {
    if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
      return yield* persistError('Jev batches must commit independently before inference or decision use')
  })

  const read = (input: string) =>
    Effect.gen(function* () {
      const batchId = yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(input)
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(StoredRow),
        strictParseOptions,
      )(
        yield* sql`
        SELECT plan.payload AS plan, result.payload AS result
        FROM jev_batch_plans AS plan LEFT JOIN jev_batch_results AS result USING (batch_id)
        WHERE plan.batch_id = ${batchId}
      `,
      )
      const row = rows[0]
      if (row === undefined) return null
      const plan = yield* Effect.fromResult(decodeJevBatchPlan(row.plan))
      if (plan.batchId !== batchId) return yield* persistError('Stored Jev batch identity differs')
      if (row.result === null) return { plan, result: null } satisfies JevBatchEvidence
      const result = yield* Effect.fromResult(decodeJevBatchResult(plan, row.result))
      for (const candidate of result.candidates) {
        if (candidate.status === JevCandidateResultStatus.Excluded) continue
        const evidence = yield* evaluations.read(candidate.requestId)
        if (candidate.status === JevCandidateResultStatus.Unattempted) {
          if (evidence !== null) return yield* persistError('A sealed unattempted candidate has a request claim')
        } else if (
          evidence?.resolution?.resolutionHash !== candidate.resolution.resolutionHash ||
          (candidate.receipt !== null && evidence.receipt?.receiptHash !== candidate.receipt.receiptHash)
        )
          return yield* persistError('Jev batch differs from its independently committed candidate evidence')
      }
      return { plan, result } satisfies JevBatchEvidence
    }).pipe(Effect.mapError(persistError))

  const begin = (input: JevBatchPlan) =>
    Effect.gen(function* () {
      yield* requireAutocommit
      const plan = yield* Effect.fromResult(decodeJevBatchPlan(input))
      const observations = yield* Schema.decodeUnknownEffect(
        Schema.Tuple([Schema.Struct({ payload: Schema.Unknown })]),
        strictParseOptions,
      )(yield* sql`SELECT payload FROM intraday_candidate_observations WHERE content_hash = ${plan.observationHash}`)
      const observation = observations[0].payload
      if ((yield* Effect.fromResult(canonicalHashV1Result(observation))) !== plan.observationHash)
        return yield* persistError('Jev batch observation bytes differ from their stored hash')
      yield* Effect.fromResult(reproduceJevTradingSignalBatch(observation, plan))
      const existing = yield* read(plan.batchId)
      if (existing !== null) return existing
      const now = yield* Clock.currentTimeMillis
      if (now < Date.parse(plan.observedAt) || now >= Date.parse(plan.expiresAt))
        return yield* persistError('An unrecorded Jev batch cannot start outside its validity window')
      yield* sql`
        INSERT INTO jev_batch_plans (batch_id, cycle_id, authority_generation_hash, observation_hash, payload)
        VALUES (${plan.batchId}, ${plan.cycleId}, ${plan.authorityGenerationHash}, ${plan.observationHash}, ${sql.json(plan)})
        ON CONFLICT (batch_id) DO NOTHING
      `
      const saved = yield* read(plan.batchId)
      if (saved === null) return yield* persistError('Committed Jev batch plan is missing')
      return saved
    }).pipe(Effect.mapError(persistError))

  const finish = (input: string) =>
    Effect.gen(function* () {
      yield* requireAutocommit
      const batchId = yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(input)
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* Schema.decodeUnknownEffect(
            OneBatch,
            strictParseOptions,
          )(
            yield* sql`
          SELECT batch_id FROM jev_batch_plans WHERE batch_id = ${batchId} FOR UPDATE
        `,
          )
          const saved = yield* read(batchId)
          if (saved === null) return yield* persistError('Jev batch plan is missing during finalization')
          if (saved.result !== null) return saved
          const pending = []
          for (const planned of saved.plan.candidates) {
            if (planned.status === JevCandidatePlanStatus.Excluded) continue
            yield* sql`SELECT request_id FROM jev_evaluation_requests WHERE request_id = ${planned.request.requestId} FOR UPDATE`
            const evidence = yield* evaluations.read(planned.request.requestId)
            pending.push({ planned, evidence })
          }
          const now = yield* Clock.currentTimeMillis
          if (now < Date.parse(saved.plan.observedAt))
            return yield* persistError('Jev batch clock regressed before observation')
          const expired = now >= Date.parse(saved.plan.expiresAt)
          if (!expired && pending.some(({ evidence }) => evidence?.resolution == null)) return saved
          const completedAt = utcInstantFromEpochMillis(now)
          const candidates: JevBatchResult['candidates'][number][] = []
          for (const planned of saved.plan.candidates) {
            if (planned.status === JevCandidatePlanStatus.Excluded) {
              candidates.push({ symbol: planned.symbol, status: JevCandidateResultStatus.Excluded })
              continue
            }
            const found = pending.find((entry) => entry.planned.symbol === planned.symbol)
            if (found === undefined) return yield* persistError('Jev finalization lost a planned candidate')
            if (found.evidence === null) {
              candidates.push({
                symbol: planned.symbol,
                status: JevCandidateResultStatus.Unattempted,
                requestId: planned.request.requestId,
              })
              continue
            }
            let resolution = found.evidence.resolution
            if (resolution === null) {
              resolution = yield* Effect.fromResult(
                makeJevResolution(planned.request, found.evidence.receipt, {
                  schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                  requestId: planned.request.requestId,
                  status: JevResolutionStatus.Abandoned,
                  abandonedAt: completedAt,
                }),
              )
              yield* sql`INSERT INTO jev_evaluation_resolutions (request_id, resolution_hash, payload)
              VALUES (${resolution.requestId}, ${resolution.resolutionHash}, ${sql.json(resolution)})`
            }
            candidates.push({
              symbol: planned.symbol,
              status: JevCandidateResultStatus.Resolved,
              requestId: planned.request.requestId,
              receipt: found.evidence.receipt,
              resolution,
            })
          }
          const result = yield* Effect.fromResult(
            makeJevBatchResult(saved.plan, {
              schemaVersion: 'bayn.jev-batch-result.v1',
              batchId,
              completedAt,
              candidates,
            }),
          )
          yield* sql`INSERT INTO jev_batch_results (batch_id, result_hash, payload)
          VALUES (${batchId}, ${result.resultHash}, ${sql.json(result)})`
          return { plan: saved.plan, result } satisfies JevBatchEvidence
        }),
      )
    }).pipe(Effect.mapError(persistError))

  return { read, begin, finish } satisfies typeof JevBatchStore.Service
})

export const JevBatchStoreLive = Layer.effect(JevBatchStore, makeJevBatchStore)
