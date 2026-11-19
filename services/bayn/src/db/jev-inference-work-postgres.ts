import { PgClient } from '@effect/sql-pg'
import { Clock, Effect, Layer, Option, Result, Schema } from 'effect'

import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { decodeJevBatchPlan, JevBatchPlanSchema, JevCandidatePlanStatus } from '../jev/batch'
import { makeJevDispatch } from '../jev/evaluation'
import { JevInferenceWorkStore, type JevInferenceJob } from '../jev/inference-work'
import { restoreJevObservation } from '../jev/observation'
import { StagedDispatchClaimSchema } from '../jev/staged-checkpoint'
import { utcInstantFromEpochMillis } from '../time'
import { withObservedStage } from '../telemetry'
import { Sha256Schema, UtcDatabaseInstantSchema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { makeJevBatchStore } from './jev-batch-postgres'

const WorkRow = Schema.Struct({
  batch_id: Sha256Schema,
  cycle_id: Sha256Schema,
  authority_generation_hash: Sha256Schema,
  observed_at: UtcInstantSchema,
  expires_at: UtcInstantSchema,
  plan_version: JevBatchPlanSchema.fields.schemaVersion,
  claimed: Schema.Boolean,
  admission_deadline_at: Schema.NullOr(UtcDatabaseInstantSchema),
}).check(
  Schema.makeFilter(
    (row) => {
      const lifetime = Date.parse(row.expires_at) - Date.parse(row.observed_at)
      return lifetime > 0 && lifetime <= 10_000
    },
    { expected: 'a sealed inference job with a bounded validity window' },
  ),
)
const WorkClaimRow = Schema.Struct({
  plan: Schema.Unknown,
  source_matches: Schema.Boolean,
  dispatches: Schema.Array(
    Schema.Struct({
      requestId: Sha256Schema,
      claimedAt: UtcInstantSchema,
      visualClaim: Schema.NullOr(StagedDispatchClaimSchema),
    }),
  ),
})

const jobFromRow = (row: typeof WorkRow.Type): JevInferenceJob => ({
  schemaVersion: 'bayn.jev-inference-job.v1',
  jobId: row.batch_id,
  batchId: row.batch_id,
  cycleId: row.cycle_id,
  authorityGenerationHash: row.authority_generation_hash,
  expiresAt: row.expires_at,
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
        SELECT work.batch_id, plan.cycle_id, plan.authority_generation_hash,
          plan.payload->>'observedAt' AS observed_at, plan.payload->>'expiresAt' AS expires_at,
          plan.payload->>'schemaVersion' AS plan_version, work.claimed_at IS NOT NULL AS claimed,
          to_char(work.admission_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS admission_deadline_at
        FROM jev_inference_work AS work JOIN jev_batch_plans AS plan USING (batch_id)
        WHERE work.batch_id = ${jobId}`,
      )
      const row = rows[0]
      if (row === undefined) return null
      if (row.batch_id !== jobId) return yield* failure('Jev inference work differs from its plan identity')
      return jobFromRow(row)
    }).pipe(Effect.mapError(failure), withObservedStage('bayn.jev.worker.job-read', { dependency: 'postgresql' }))

  const pending = (input?: string) =>
    Effect.gen(function* () {
      const generation =
        input === undefined ? undefined : yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(input)
      const now = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
      // Exclude completed results before detoasting their retained plan payloads on each dispatch poll.
      const rows = yield* decodeRows(
        yield* sql`
        WITH unresolved AS MATERIALIZED (
          SELECT work.batch_id, plan.cycle_id, plan.authority_generation_hash, work.claimed_at, work.admission_deadline_at, plan.payload
          FROM jev_inference_work AS work JOIN jev_batch_plans AS plan USING (batch_id)
          WHERE ${generation === undefined ? sql`true` : sql`plan.authority_generation_hash = ${generation}`}
            AND NOT EXISTS (SELECT 1 FROM jev_batch_results AS result WHERE result.batch_id = work.batch_id)
        )
        SELECT batch_id, cycle_id, authority_generation_hash,
          payload->>'observedAt' AS observed_at, payload->>'expiresAt' AS expires_at,
          payload->>'schemaVersion' AS plan_version, claimed_at IS NOT NULL AS claimed,
          to_char(admission_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS admission_deadline_at
        FROM unresolved WHERE payload->>'expiresAt' > ${now}
        ORDER BY payload->>'expiresAt', batch_id LIMIT 64`,
      )
      return rows.map(jobFromRow)
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
      // Filter committed results before reading expiry from potentially large plan payloads.
      // Materialization keeps the planner from detoasting the completed history on every recovery wake.
      const unresolved = sql`SELECT work.batch_id, plan.payload
        FROM jev_inference_work AS work JOIN jev_batch_plans AS plan USING (batch_id)
        JOIN autonomous_cycles AS cycle ON cycle.cycle_id = plan.cycle_id
        WHERE cycle.account_id = ${accountId}
          AND NOT EXISTS (SELECT 1 FROM jev_batch_results AS result WHERE result.batch_id = work.batch_id)`
      const select = (after: typeof CursorRow.Type | undefined) =>
        sql`WITH unresolved AS MATERIALIZED (${unresolved})
          SELECT batch_id, payload->>'expiresAt' AS expires_at FROM unresolved
          WHERE payload->>'expiresAt' <= ${now}
            AND ${after === undefined ? sql`true` : sql`(payload->>'expiresAt', batch_id COLLATE "C") > (${after.last_expires_at}, ${after.last_batch_id} COLLATE "C")`}
          ORDER BY payload->>'expiresAt', batch_id COLLATE "C" LIMIT 64`.pipe(
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
        yield* sql`WITH unresolved AS MATERIALIZED (${unresolved})
          SELECT EXISTS (SELECT 1 FROM unresolved WHERE payload->>'expiresAt' <= ${now}) AS remaining`,
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
        yield* sql`WITH claimed AS (
          UPDATE jev_inference_work SET claimed_at = clock_timestamp()
          WHERE batch_id = ${jobId} AND claimed_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM jev_batch_results WHERE batch_id = ${jobId})
          RETURNING batch_id, dispatches, source_sha256
        )
        SELECT claimed.dispatches, plan.payload AS plan,
          COALESCE(sha256(convert_to(observation.payload::text, 'UTF8')) = claimed.source_sha256, false) AS source_matches
        FROM claimed JOIN jev_batch_plans AS plan USING (batch_id)
        JOIN intraday_candidate_observations AS observation ON observation.content_hash = plan.observation_hash`.pipe(
          withObservedStage('bayn.jev.worker.source-seal', { dependency: 'postgresql' }),
        ),
      )
      const row = rows[0]
      if (row === undefined) return null
      if (!row.source_matches) return yield* failure('Claimed inference differs from its admission source seal')
      const plan = yield* Effect.fromResult(decodeJevBatchPlan(row.plan))
      if (plan.batchId !== jobId) return yield* failure('Claimed inference differs from its immutable plan')
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
          const dispatch = yield* Effect.fromResult(makeJevDispatch({ request, claimedAt: retained.claimedAt }))
          if (
            (yield* Effect.fromResult(canonicalHashV1Result(dispatch.visualClaim))) !==
            (yield* Effect.fromResult(canonicalHashV1Result(retained.visualClaim)))
          )
            return yield* failure('Claimed inference visual request differs from its original admission')
          return dispatch
        }),
      ).pipe(withObservedStage('bayn.jev.worker.dispatch-replay'))
      const loadObservation = Effect.gen(function* () {
        const [row] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ observation: Schema.Unknown })]),
          strictParseOptions,
        )(
          yield* sql`SELECT payload AS observation FROM intraday_candidate_observations
          WHERE content_hash = ${plan.observationHash}`,
        )
        return row.observation
      }).pipe(
        Effect.mapError(failure),
        withObservedStage('bayn.jev.worker.completion-source', { dependency: 'postgresql' }),
      )
      return { admission: { plan, result: null, dispatches }, loadObservation }
    }).pipe(Effect.mapError(failure), withObservedStage('bayn.jev.worker.claim'))

  const resume = (cycleInput: string, generationInput: string) =>
    Effect.gen(function* () {
      const cycleId = yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(cycleInput)
      const generation = yield* Schema.decodeUnknownEffect(Sha256Schema, strictParseOptions)(generationInput)
      const now = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({ batch_id: Sha256Schema, observation_hash: Sha256Schema, source_matches: Schema.Boolean }),
        ),
        strictParseOptions,
      )(
        yield* sql`SELECT work.batch_id, plan.observation_hash,
          COALESCE(sha256(convert_to(observation.payload::text, 'UTF8')) = work.source_sha256, false) AS source_matches
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
      if (!row.source_matches) return yield* failure('Completed inference differs from its admission source seal')
      const loadSource = Effect.gen(function* () {
        const [source] = yield* Schema.decodeUnknownEffect(
          Schema.Tuple([Schema.Struct({ payload: Schema.Unknown })]),
          strictParseOptions,
        )(yield* sql`SELECT payload FROM intraday_candidate_observations WHERE content_hash = ${row.observation_hash}`)
        return yield* Effect.fromResult(restoreJevObservation(source.payload))
      }).pipe(
        Effect.mapError(failure),
        withObservedStage('bayn.jev.decision-source-restore', { dependency: 'postgresql' }),
      )
      return { batchId: row.batch_id, loadSource }
    }).pipe(Effect.mapError(failure))

  return { read, pending, claim, resume, settleExpired } satisfies typeof JevInferenceWorkStore.Service
})

export const JevInferenceWorkStoreLive = Layer.effect(JevInferenceWorkStore, makeJevInferenceWorkStore)
