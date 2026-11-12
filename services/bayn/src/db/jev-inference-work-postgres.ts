import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Layer, Option, Result, Schema } from 'effect'

import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { decodeJevBatchPlan, JevCandidatePlanStatus, type JevBatchPlan } from '../jev/batch'
import { makeJevDispatch } from '../jev/evaluation'
import { JevInferenceWorkStore, type JevInferenceJob } from '../jev/inference-work'
import { restoreJevObservation } from '../jev/observation'
import { JevObservationSchema } from '../jev/observation-contract'
import { prepareClaimedEntry } from '../jev/entry-inference'
import { StagedDispatchClaimSchema } from '../jev/staged-checkpoint'
import { reproduceJevTradingSignalBatchEvidence } from '../jev/trading-signals'
import { utcInstantFromEpochMillis } from '../time'
import { Sha256Schema, UtcDatabaseInstantSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { makeJevBatchStore } from './jev-batch-postgres'

const WorkRow = Schema.Struct({
  plan: Schema.Unknown,
  claimed: Schema.Boolean,
  admission_deadline_at: Schema.NullOr(UtcDatabaseInstantSchema),
})
const WorkClaimRow = Schema.Struct({
  dispatches: Schema.Array(
    Schema.Struct({
      requestId: Sha256Schema,
      claimedAt: UtcInstantSchema,
      visualClaim: Schema.NullOr(StagedDispatchClaimSchema),
    }),
  ),
})

const jobFromRow = (plan: JevBatchPlan, row: typeof WorkRow.Type): JevInferenceJob => ({
  schemaVersion: 'bayn.jev-inference-job.v1',
  jobId: plan.batchId,
  batchId: plan.batchId,
  cycleId: plan.cycleId,
  authorityGenerationHash: plan.authorityGenerationHash,
  expiresAt: plan.expiresAt,
  ...(row.admission_deadline_at === null ? {} : { admissionDeadlineAt: Date.parse(row.admission_deadline_at) }),
  status: row.claimed ? 'Claimed' : 'Prepared',
})

export const makeJevInferenceWorkStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const batches = yield* makeJevBatchStore
  const failure = (cause: unknown) =>
    operationalError({
      component: 'database',
      operation: 'jev-batch',
      message: 'Jev inference dispatch ownership could not be durably verified',
      cause,
    })
  const decodeRows = (input: unknown) => Schema.decodeUnknownEffect(Schema.Array(WorkRow), strictParseOptions)(input)
  const read = (input: string) =>
    Effect.gen(function* () {
      const jobId = yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(input)
      const rows = yield* decodeRows(
        yield* sql`
        SELECT plan.payload AS plan, work.claimed_at IS NOT NULL AS claimed,
          to_char(work.admission_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS admission_deadline_at
        FROM jev_inference_work AS work JOIN jev_batch_plans AS plan USING (batch_id)
        WHERE work.batch_id = ${jobId}`,
      )
      const row = rows[0]
      if (row === undefined) return null
      const plan = yield* Effect.fromResult(decodeJevBatchPlan(row.plan))
      if (plan.batchId !== jobId) return yield* failure('Jev inference work differs from its plan identity')
      return jobFromRow(plan, row)
    }).pipe(Effect.mapError(failure))

  const pending = (input?: string) =>
    Effect.gen(function* () {
      const generation =
        input === undefined ? undefined : yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(input)
      const now = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
      const rows = yield* decodeRows(
        yield* sql`
        SELECT plan.payload AS plan, work.claimed_at IS NOT NULL AS claimed,
          to_char(work.admission_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS admission_deadline_at
        FROM jev_inference_work AS work JOIN jev_batch_plans AS plan USING (batch_id)
        LEFT JOIN jev_batch_results AS result USING (batch_id)
        WHERE result.batch_id IS NULL
          AND plan.payload->>'expiresAt' > ${now}
          AND ${generation === undefined ? sql`true` : sql`plan.authority_generation_hash = ${generation}`}
        ORDER BY plan.payload->>'expiresAt', work.batch_id LIMIT 64`,
      )
      return yield* Effect.forEach(rows, (row) =>
        Effect.fromResult(decodeJevBatchPlan(row.plan)).pipe(Effect.map((plan) => jobFromRow(plan, row))),
      )
    }).pipe(Effect.mapError(failure))

  const settleExpired = (input: string) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* failure('Inference expiry recovery must commit independently')
      const accountId = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString, strictParseOptions)(input)
      const now = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
      const CursorRow = Schema.Struct({
        last_expires_at: Schema.String,
        last_batch_id: Sha256Schema,
        next_attempt_at: Schema.NullOr(UtcDatabaseInstantSchema),
        waiting: Schema.Boolean,
      })
      const cursors = yield* Schema.decodeUnknownEffect(
        Schema.Array(CursorRow),
        strictParseOptions,
      )(
        yield* sql`SELECT last_expires_at, last_batch_id,
          COALESCE(next_attempt_at > ${now}::timestamptz, false) AS waiting,
          to_char(next_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS next_attempt_at
          FROM jev_inference_recovery_cursor
          WHERE account_id = ${accountId}`,
      )
      const cursor = cursors[0]
      if (cursor !== undefined && cursor.next_attempt_at !== null && cursor.waiting)
        return {
          sealed: 0,
          failed: 0,
          remaining: true,
          nextAttemptAt: cursor.next_attempt_at,
        }
      const select = (after: typeof CursorRow.Type | undefined) =>
        sql`SELECT work.batch_id, plan.payload->>'expiresAt' AS expires_at
          FROM jev_inference_work AS work JOIN jev_batch_plans AS plan USING (batch_id)
          JOIN autonomous_cycles AS cycle ON cycle.cycle_id = plan.cycle_id
          LEFT JOIN jev_batch_results AS result USING (batch_id)
          WHERE cycle.account_id = ${accountId} AND result.batch_id IS NULL
            AND plan.payload->>'expiresAt' <= ${now}
            AND ${after === undefined ? sql`true` : sql`(plan.payload->>'expiresAt', work.batch_id COLLATE "C") > (${after.last_expires_at}, ${after.last_batch_id} COLLATE "C")`}
          ORDER BY plan.payload->>'expiresAt', work.batch_id COLLATE "C" LIMIT 64`.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Array(Schema.Struct({ batch_id: Sha256Schema, expires_at: Schema.String })),
              strictParseOptions,
            ),
          ),
        )
      let candidates = yield* select(cursor)
      if (candidates.length === 0 && cursor !== undefined) candidates = yield* select(undefined)
      let sealed = 0
      let failed = 0
      for (const candidate of candidates) {
        const settled = yield* batches.finish(candidate.batch_id).pipe(Effect.result)
        if (Result.isSuccess(settled) && settled.success.result !== null) sealed += 1
        else {
          failed += 1
          yield* Effect.logWarning('Jev inference expiry recovery retained unresolved evidence').pipe(
            Effect.annotateLogs({ batchId: candidate.batch_id }),
          )
        }
      }
      const last = candidates.at(-1)
      const nextAttemptAt =
        failed > 0 ? utcInstantFromEpochMillis((yield* Clock.currentTimeMillis) + 30_000) : undefined
      // Progress is metadata only. Advance across failed historical rows too, so
      // one bad page cannot hide later expense evidence after a process restart.
      if (last !== undefined)
        yield* sql`INSERT INTO jev_inference_recovery_cursor (account_id, last_expires_at, last_batch_id, next_attempt_at)
          VALUES (${accountId}, ${last.expires_at}, ${last.batch_id}, ${nextAttemptAt ?? null}::timestamptz)
          ON CONFLICT (account_id) DO UPDATE
            SET last_expires_at = EXCLUDED.last_expires_at, last_batch_id = EXCLUDED.last_batch_id,
              next_attempt_at = EXCLUDED.next_attempt_at`
      const [remaining] = yield* Schema.decodeUnknownEffect(
        Schema.Tuple([Schema.Struct({ remaining: Schema.Boolean })]),
        strictParseOptions,
      )(
        yield* sql`SELECT EXISTS (
        SELECT 1 FROM jev_inference_work AS work JOIN jev_batch_plans AS plan USING (batch_id)
          JOIN autonomous_cycles AS cycle ON cycle.cycle_id = plan.cycle_id
        LEFT JOIN jev_batch_results AS result USING (batch_id)
        WHERE cycle.account_id = ${accountId} AND result.batch_id IS NULL
          AND plan.payload->>'expiresAt' <= ${now}
      ) AS remaining`,
      )
      return {
        sealed,
        failed,
        remaining: remaining.remaining,
        ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
      }
    }).pipe(Effect.mapError(failure))

  const claim = (input: string) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService)))
        return yield* failure('Jev inference must claim independently before provider work')
      const jobId = yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(input)
      // Commit the exclusive expense claim before any provider I/O. A lost worker
      // leaves a claimed job, which can settle evidence but never regain dispatch.
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(WorkClaimRow),
        strictParseOptions,
      )(
        yield* sql`UPDATE jev_inference_work SET claimed_at = clock_timestamp()
        WHERE batch_id = ${jobId} AND claimed_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM jev_batch_results WHERE batch_id = ${jobId})
        RETURNING dispatches`,
      )
      const row = rows[0]
      if (row === undefined) return null
      const job = yield* read(jobId)
      if (job === null) return yield* failure('Claimed Jev inference work disappeared')
      const sources = yield* Schema.decodeUnknownEffect(
        Schema.Tuple([Schema.Struct({ plan: Schema.Unknown, observation: Schema.Unknown })]),
        strictParseOptions,
      )(
        yield* sql`SELECT plan.payload AS plan, observation.payload AS observation
        FROM jev_batch_plans AS plan
        JOIN intraday_candidate_observations AS observation ON observation.content_hash = plan.observation_hash
        WHERE plan.batch_id = ${jobId}`,
      )
      const plan = yield* Effect.fromResult(decodeJevBatchPlan(sources[0].plan))
      const sourceObservation = yield* Schema.decodeUnknownEffect(
        JevObservationSchema,
        strictParseOptions,
      )(sources[0].observation)
      const observation = yield* Effect.fromResult(restoreJevObservation(sourceObservation))
      yield* Effect.fromResult(reproduceJevTradingSignalBatchEvidence(sourceObservation, plan))
      if (plan.batchId !== jobId || observation.contentHash !== plan.observationHash)
        return yield* failure('Claimed inference differs from its immutable source')
      const requests = plan.candidates.flatMap((candidate) =>
        candidate.status === JevCandidatePlanStatus.Requested ? [candidate.request] : [],
      )
      if (
        row.dispatches.length !== requests.length ||
        new Set(row.dispatches.map(({ requestId }) => requestId)).size !== requests.length
      )
        return yield* failure('Claimed inference dispatches do not cover the admitted cohort')
      const dispatches = yield* Effect.forEach(requests, (request) =>
        Effect.gen(function* () {
          const retained = row.dispatches.find(({ requestId }) => requestId === request.requestId)
          if (retained === undefined) return yield* failure('Claimed inference request is absent from its cohort')
          const prepared = yield* Effect.fromResult(
            prepareClaimedEntry({
              requestId: request.requestId,
              input: request.request,
              observedAt: request.observedAt,
              expiresAt: request.expiresAt,
              claimedAt: retained.claimedAt,
            }),
          )
          if (
            (yield* Effect.fromResult(canonicalHashV1Result(prepared.visualClaim))) !==
            (yield* Effect.fromResult(canonicalHashV1Result(retained.visualClaim)))
          )
            return yield* failure('Claimed inference visual request differs from its original admission')
          return makeJevDispatch({ request, claimedAt: retained.claimedAt, visualClaim: retained.visualClaim })
        }),
      )
      return { job, admission: { plan, result: null, dispatches }, observation: observation.observation }
    }).pipe(Effect.mapError(failure))

  const resume = (cycleInput: string, generationInput: string) =>
    Effect.gen(function* () {
      const cycleId = yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(cycleInput)
      const generation = yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(generationInput)
      const now = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ batch_id: Sha256Schema, observation: JevObservationSchema })),
        strictParseOptions,
      )(
        yield* sql`SELECT work.batch_id, observation.payload AS observation
        FROM jev_inference_work AS work JOIN jev_batch_plans AS plan USING (batch_id)
        JOIN jev_batch_results AS result USING (batch_id)
        JOIN intraday_candidate_observations AS observation ON observation.content_hash = plan.observation_hash
        WHERE plan.cycle_id = ${cycleId} AND plan.authority_generation_hash = ${generation}
          AND (plan.payload->>'expiresAt')::timestamptz > ${now}::timestamptz
          AND (work.admission_deadline_at IS NULL OR work.admission_deadline_at > ${now}::timestamptz)
        ORDER BY plan.payload->>'observedAt' DESC, work.batch_id DESC LIMIT 1`,
      )
      const row = rows[0]
      if (row === undefined) return null
      const restored = yield* Effect.fromResult(restoreJevObservation(row.observation))
      return { batchId: row.batch_id, observation: restored.observation }
    }).pipe(Effect.mapError(failure))

  return { read, pending, claim, resume, settleExpired } satisfies typeof JevInferenceWorkStore.Service
})

export const JevInferenceWorkStoreLive = Layer.effect(JevInferenceWorkStore, makeJevInferenceWorkStore)
