import { beginRecordedJevBatch } from '../jev/batch-admission.test-support'
import {
  persistVisualClaimFixture,
  persistVisualTransitionFixture,
  persistHandoffFixture,
  persistEvaluationFixture,
} from '../jev/evaluation.test-support'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { entryCompletionFixture, stagedCheckpointFixture } from '../jev/entry-inference.test-support'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import type { Statement } from 'effect/sql/Statement'
import { CycleState, CycleTerminalReason } from '../cycle/model'
import { CycleStore } from '../cycle/store/model'
import { operationalError } from '../errors'
import { sha256 } from '../hash'
import { JevBatchPlanVersion, JevCandidateResultStatus, usableEntryBatchInferences } from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import { JevEvaluationStore } from '../jev/evaluation'
import { JevResolutionStatus } from '../jev/resolution'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { utcInstantFromEpochMillis } from '../time'
import { makeJevBatchStore, settleExpiredTerminalJevBatches } from './jev-batch-postgres'
import { makeJevInferenceWorkStore } from './jev-inference-work-postgres'
import { JevInferenceWorkStore } from '../jev/inference-work'
import { streamingSnapshotReference } from '../market-data/streaming/reference'
import {
  describeJevBatchPostgres,
  atObservation,
  excludedFixture,
  excludedPlan,
  first,
  fixture,
  observed,
  plan,
  replayAccountId,
  requested,
} from './jev-batch-postgres.test-support'

setDefaultTimeout(30_000)

describeJevBatchPostgres((postgres) => {
  test('a same-millisecond commit cannot advance a microsecond recovery deadline; original due work settles once', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const batches = yield* JevBatchStore
        const cycles = yield* CycleStore
        const work = yield* JevInferenceWorkStore
        yield* beginRecordedJevBatch(batches, plan, fixture.observation.payload, {
          deferProviderDispatch: true,
          sourceReference: streamingSnapshotReference(fixture.snapshot),
        })
        const deadlineMs = Date.parse(plan.expiresAt)
        const nextAttemptAt = `${plan.expiresAt.slice(0, -1)}123Z`
        yield* sql`INSERT INTO jev_inference_recovery_cursor (account_id, last_expires_at, last_batch_id, next_attempt_at)
          VALUES (${replayAccountId}, ${plan.expiresAt}, ${plan.batchId}, ${nextAttemptAt}::timestamptz)`
        yield* cycles.activate(fixture.draft.identity.cycleId, plan.observedAt)
        yield* TestClock.setTime(deadlineMs)
        yield* cycles.block(fixture.draft.identity.cycleId, CycleTerminalReason.Risk, plan.expiresAt)
        for (let commit = 0; commit < 2; commit++) {
          yield* sql`SELECT pg_notify('bayn_inference_expense_account', '')`
          expect(yield* settleExpiredTerminalJevBatches(sql, replayAccountId)).toEqual({
            candidates: 0,
            sealed: 0,
            pending: 0,
            failed: 0,
          })
          expect(yield* work.settleExpired(replayAccountId)).toEqual({
            sealed: 0,
            failed: 0,
            remaining: true,
            nextAttemptAt,
          })
        }
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
        yield* TestClock.setTime(deadlineMs + 1)
        expect(yield* work.settleExpired(replayAccountId)).toEqual({ sealed: 1, failed: 0, remaining: false })
        expect(yield* work.settleExpired(replayAccountId)).toEqual({ sealed: 0, failed: 0, remaining: false })
        expect(
          yield* sql`SELECT count(*)::integer AS count FROM jev_batch_results WHERE batch_id=${plan.batchId}`,
        ).toEqual([{ count: 1 }])
      }).pipe(
        atObservation,
        Effect.provideService(JevClient, { evaluate: () => Effect.die('Expiry recovery cannot make provider calls') }),
      ),
    )
  })

  test('expiry recovery excludes completed history before evaluating large plan payloads', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const lookups: Statement<Record<string, unknown>>[] = []
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            const query = statement.compile()[0]
            if (query.includes('AS expires_at') || query.includes('AS remaining')) lookups.push(statement)
            return statement
          },
        })
        const work = yield* makeJevInferenceWorkStore.pipe(Effect.provideService(PgClient.PgClient, monitored))
        expect(yield* work.settleExpired(replayAccountId)).toEqual({ sealed: 0, failed: 0, remaining: false })
        expect(lookups).toHaveLength(2)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Exercise the real lookup against a completed history, independently of admission fixtures.
            yield* sql`CREATE TEMP TABLE jev_batch_plans (
              batch_id text PRIMARY KEY, cycle_id text NOT NULL, payload jsonb NOT NULL
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE jev_inference_work (batch_id text PRIMARY KEY) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE jev_batch_results (batch_id text PRIMARY KEY) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE autonomous_cycles (
              cycle_id text PRIMARY KEY, account_id text NOT NULL
            ) ON COMMIT DROP`
            yield* sql`INSERT INTO pg_temp.autonomous_cycles VALUES (${plan.cycleId}, ${replayAccountId})`
            yield* sql`INSERT INTO pg_temp.jev_batch_plans
              SELECT md5(n::text)||md5('batch-'||n::text), ${plan.cycleId},
                jsonb_build_object('expiresAt', ${plan.expiresAt}::text, 'evidence', repeat(md5(n::text), 1024))
              FROM generate_series(1,4096) n`
            yield* sql`INSERT INTO pg_temp.jev_batch_results SELECT batch_id FROM pg_temp.jev_batch_plans`
            yield* sql`INSERT INTO pg_temp.jev_inference_work
              SELECT batch_id FROM pg_temp.jev_batch_plans ORDER BY batch_id LIMIT 1024`
            yield* sql`ANALYZE pg_temp.jev_batch_plans`
            yield* sql`ANALYZE pg_temp.jev_inference_work`
            yield* sql`ANALYZE pg_temp.jev_batch_results`
            yield* sql`ANALYZE pg_temp.autonomous_cycles`
            // A legal unfavorable join order must not reopen completed payloads. Production chose such an order.
            yield* sql`SET LOCAL join_collapse_limit = 1`
            for (const lookup of lookups) {
              const [query, parameters] = lookup.compile()
              const explained = yield* sql.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`, parameters)
              const rows = yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ 'QUERY PLAN': Schema.Array(Schema.Struct({ Plan: Schema.Unknown })) })),
              )(explained)
              const root = rows[0]?.['QUERY PLAN'][0]?.Plan
              if (root === undefined) throw new Error('Missing expiry recovery query plan')
              let expiryFilters = 0
              const scan = Schema.Struct({
                'Actual Rows': Schema.Number,
                'Actual Loops': Schema.Number,
                'Rows Removed by Filter': Schema.optionalKey(Schema.Number),
                Filter: Schema.optionalKey(Schema.String),
                Plans: Schema.optionalKey(Schema.Array(Schema.Unknown)),
              })
              const check = (value: unknown): void => {
                const node = Schema.decodeUnknownSync(scan)(value)
                if (node.Filter?.includes('expiresAt')) {
                  expiryFilters += 1
                  expect((node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops']).toBe(0)
                }
                for (const child of node.Plans ?? []) check(child)
              }
              check(root)
              expect(expiryFilters).toBeGreaterThan(0)
            }
          }),
        )
      }).pipe(atObservation),
    )
  })

  test('pending inference excludes completed payload history and preserves its bounded dispatch order', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const lookups: Statement<Record<string, unknown>>[] = []
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            if (statement.compile()[0].includes('AS claimed')) lookups.push(statement)
            return statement
          },
        })
        const work = yield* makeJevInferenceWorkStore.pipe(Effect.provideService(PgClient.PgClient, monitored))
        expect(yield* work.pending(plan.authorityGenerationHash)).toEqual([])
        expect(yield* work.pending()).toEqual([])
        expect(lookups).toHaveLength(2)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`CREATE TEMP TABLE jev_batch_plans (
              batch_id text PRIMARY KEY, cycle_id text NOT NULL, authority_generation_hash text NOT NULL, payload jsonb NOT NULL
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE jev_inference_work (
              batch_id text PRIMARY KEY, claimed_at timestamptz, admission_deadline_at timestamptz
            ) ON COMMIT DROP`
            yield* sql`CREATE TEMP TABLE jev_batch_results (batch_id text PRIMARY KEY) ON COMMIT DROP`
            // Rebind prepared statements to this transaction's temporary fixture tables.
            yield* sql`SET LOCAL search_path = pg_temp, public`
            yield* sql`INSERT INTO pg_temp.jev_batch_plans
              SELECT md5(n::text)||md5('batch-'||n::text), ${plan.cycleId}, ${plan.authorityGenerationHash},
                jsonb_build_object('expiresAt', ${plan.expiresAt}::text, 'evidence', repeat(md5(n::text), 1024))
              FROM generate_series(1,4096) n`
            yield* sql`INSERT INTO pg_temp.jev_batch_results SELECT batch_id FROM pg_temp.jev_batch_plans`
            yield* sql`INSERT INTO pg_temp.jev_inference_work (batch_id)
              SELECT batch_id FROM pg_temp.jev_batch_plans ORDER BY batch_id LIMIT 1024`
            yield* sql`ANALYZE pg_temp.jev_batch_plans`
            yield* sql`ANALYZE pg_temp.jev_inference_work`
            yield* sql`ANALYZE pg_temp.jev_batch_results`
            yield* sql`SET LOCAL join_collapse_limit = 1`
            for (const lookup of lookups) {
              const [query, parameters] = lookup.compile()
              const explained = yield* sql.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`, parameters)
              const rows = yield* Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ 'QUERY PLAN': Schema.Array(Schema.Struct({ Plan: Schema.Unknown })) })),
              )(explained)
              const root = rows[0]?.['QUERY PLAN'][0]?.Plan
              if (root === undefined) throw new Error('Missing pending inference query plan')
              let expiryFilters = 0
              const scan = Schema.Struct({
                'Actual Rows': Schema.Number,
                'Actual Loops': Schema.Number,
                'Rows Removed by Filter': Schema.optionalKey(Schema.Number),
                Filter: Schema.optionalKey(Schema.String),
                Plans: Schema.optionalKey(Schema.Array(Schema.Unknown)),
              })
              const check = (value: unknown): void => {
                const node = Schema.decodeUnknownSync(scan)(value)
                if (node.Filter?.includes('expiresAt')) {
                  expiryFilters += 1
                  expect((node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops']).toBe(0)
                }
                for (const child of node.Plans ?? []) check(child)
              }
              check(root)
              expect(expiryFilters).toBeGreaterThan(0)
            }
            const pending = Array.from({ length: 73 }, (_, index) => ({
              batchId: sha256(`pending-${index}`),
              expiresAt: utcInstantFromEpochMillis(observed + (index < 71 ? (index % 4) + 1 : 71 - index)),
              generation: index === 70 ? sha256('other-generation') : plan.authorityGenerationHash,
              claimed: index % 2 === 0,
              admissionDeadlineAt: index % 3 === 0 ? null : utcInstantFromEpochMillis(observed + 15_000),
            }))
            for (const row of pending) {
              yield* sql`INSERT INTO pg_temp.jev_batch_plans VALUES (
                ${row.batchId}, ${plan.cycleId}, ${row.generation},
                ${sql.json({ schemaVersion: plan.schemaVersion, observedAt: plan.observedAt, expiresAt: row.expiresAt })}
              )`
              yield* sql`INSERT INTO pg_temp.jev_inference_work VALUES (
                ${row.batchId}, ${row.claimed ? plan.observedAt : null}, ${row.admissionDeadlineAt}
              )`
            }
            for (const [index, lookup] of lookups.entries()) {
              const [query, parameters] = lookup.compile()
              const expected = pending
                .filter((row) => Date.parse(row.expiresAt) > observed)
                .filter((row) => index === 1 || row.generation === plan.authorityGenerationHash)
                .sort((left, right) =>
                  left.expiresAt < right.expiresAt
                    ? -1
                    : left.expiresAt > right.expiresAt
                      ? 1
                      : left.batchId < right.batchId
                        ? -1
                        : 1,
                )
                .slice(0, 64)
                .map((row) => ({
                  batch_id: row.batchId,
                  cycle_id: plan.cycleId,
                  authority_generation_hash: row.generation,
                  plan_version: plan.schemaVersion,
                  observed_at: plan.observedAt,
                  expires_at: row.expiresAt,
                  claimed: row.claimed,
                  admission_deadline_at: row.admissionDeadlineAt?.replace('Z', '000Z') ?? null,
                }))
              expect(yield* sql.unsafe(query, parameters)).toEqual(expected)
            }
          }),
        )
      }).pipe(atObservation),
    )
  })

  test('all-excluded lost admission acknowledgement recovers the complete commit after expiry', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        const lostAcknowledgement = operationalError({
          component: 'database',
          operation: 'test',
          message: 'lost excluded batch acknowledgement',
        })
        expect(
          Result.isFailure(
            yield* beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload).pipe(
              Effect.andThen(Effect.fail(lostAcknowledgement)),
              Effect.result,
            ),
          ),
        ).toBe(true)
        const saved = yield* batches.read(excludedPlan.batchId)
        if (saved === null || saved.result === null)
          throw new Error('Lost acknowledgement did not retain a complete batch')
        yield* TestClock.adjust('1 minute')
        expect(yield* beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload)).toMatchObject({
          plan: saved.plan,
          result: saved.result,
          dispatches: [],
        })
        expect(yield* Effect.flatMap(JevBatchStore, (store) => store.finish(excludedPlan.batchId))).toEqual(saved)
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([{ batch_id: excludedPlan.batchId }])
      }).pipe(atObservation),
    )
  })

  test('all-excluded plans retained by an earlier worker remain finalizable after expiry', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        yield* sql`INSERT INTO jev_batch_plans (batch_id, cycle_id, authority_generation_hash, observation_hash, payload)
          VALUES (${excludedPlan.batchId}, ${excludedPlan.cycleId}, ${excludedPlan.authorityGenerationHash},
            ${excludedPlan.observationHash}, ${sql.json(excludedPlan)})`
        yield* TestClock.adjust('1 minute')
        expect(yield* beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload)).toMatchObject({
          plan: excludedPlan,
          result: null,
        })
        expect(yield* batches.pending(excludedPlan.cycleId)).toEqual([excludedPlan.batchId])
        const saved = yield* Effect.flatMap(JevBatchStore, (store) => store.finish(excludedPlan.batchId))
        expect(saved.result).not.toBeNull()
        expect(
          saved.result?.candidates.every((candidate) => candidate.status === JevCandidateResultStatus.Excluded),
        ).toBe(true)
        expect(yield* beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload)).toMatchObject({
          plan: saved.plan,
          result: saved.result,
          dispatches: [],
        })
        expect(yield* batches.pending(excludedPlan.cycleId)).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('all-excluded admission still rejects a regressed clock and an uncommitted expired plan', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        for (const now of [observed - 1, Date.parse(excludedPlan.expiresAt)]) {
          yield* TestClock.setTime(now)
          const failed = yield* beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload).pipe(
            Effect.result,
          )
          expect(Result.isFailure(failed)).toBe(true)
          if (Result.isFailure(failed))
            expect(failed.failure._tag).toBe(now < observed ? 'OperationalError' : 'JevBatchExpired')
        }
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('expired recovery seals pending and unattempted candidates and preserves later response evidence separately', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const requests = yield* JevEvaluationStore
        yield* beginRecordedJevBatch(store, plan, fixture.observation.payload)
        const journal = yield* EntryInferenceJournal
        const checkpoint = stagedCheckpointFixture(first.request, plan.observedAt)
        for (const claim of checkpoint.claims) {
          yield* persistVisualClaimFixture(journal, claim)
          const terminal = checkpoint.terminals.find((row) => row.stage === claim.stage)
          if (terminal !== undefined)
            yield* persistVisualTransitionFixture(journal, { terminal: terminal, successor: { kind: 'NONE' } })
        }

        yield* persistHandoffFixture(
          yield* EntryInferenceJournal,
          entryCompletionFixture(first.request, plan.observedAt).handoff,
        )

        expect((yield* Effect.flatMap(JevBatchStore, (store) => store.finish(plan.batchId))).result).toBeNull()
        yield* TestClock.adjust('10 seconds')
        const sealed = yield* Effect.flatMap(JevBatchStore, (store) => store.finish(plan.batchId))
        const result = sealed.result
        if (result === null) throw new Error('Expired batch did not finalize')
        expect(
          result.candidates.filter((candidate) => candidate.status === JevCandidateResultStatus.Unattempted),
        ).toHaveLength(0)
        const resolved = result.candidates.find((candidate) => candidate.symbol === first.symbol)
        if (resolved?.status !== JevCandidateResultStatus.Resolved) throw new Error('Missing abandoned candidate')
        expect(resolved.resolution.status).toBe(JevResolutionStatus.Abandoned)
        expect(resolved.receipt).toBeNull()
        const late = Result.getOrThrow(
          makeJevEvaluationReceipt(first.request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v3',
            requestId: first.request.requestId,
            startedAt: plan.observedAt,
            completedAt: plan.expiresAt,
            outcome: {
              status: JevOutcome.Completed,
              completion: entryCompletionFixture(first.request, plan.observedAt, 0.9),
            },
          }),
        )
        yield* persistEvaluationFixture(requests, first.request, late)
        expect((yield* requests.read(first.request.requestId))?.receipt).toEqual(late)
        expect(yield* store.read(plan.batchId)).toEqual(sealed)
        expect(yield* Effect.flatMap(JevBatchStore, (store) => store.finish(plan.batchId))).toEqual(sealed)
        for (const candidate of requested.slice(1))
          expect((yield* requests.read(candidate.request.requestId))?.resolution?.status).toBe(
            JevResolutionStatus.Abandoned,
          )
        expect(
          Result.isFailure(
            usableEntryBatchInferences(
              plan,
              result,
              observed + fixture.protocol.inferenceValidityMs,
              JevBatchPlanVersion.V8,
            ),
          ),
        ).toBe(true)
      }).pipe(atObservation),
    )
  })

  test('durably settles a terminal batch after its original deadline across a fresh store', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* JevBatchStore
        const cycles = yield* CycleStore
        const cycleId = fixture.draft.identity.cycleId
        const accountId = fixture.draft.identity.accountId
        const t59 = observed + 4_000
        const t60 = observed + 5_000
        const t65 = observed + 10_000

        yield* TestClock.setTime(t59)
        yield* sql`UPDATE simulated_execution_clocks
          SET observed_at = ${utcInstantFromEpochMillis(t59)}
          WHERE account_id = ${accountId}`
        expect((yield* beginRecordedJevBatch(store, plan, fixture.observation.payload)).result).toBeNull()
        yield* cycles.activate(cycleId, utcInstantFromEpochMillis(t59))
        yield* TestClock.setTime(t60)
        yield* sql`UPDATE simulated_execution_clocks
          SET observed_at = ${utcInstantFromEpochMillis(t60)}
          WHERE account_id = ${accountId}`
        const terminal = yield* cycles.block(cycleId, CycleTerminalReason.Risk, utcInstantFromEpochMillis(t60))
        expect(terminal.cycle.state).toBe(CycleState.Blocked)
        expect((yield* store.finish(plan.batchId)).result).toBeNull()
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])

        yield* TestClock.setTime(t65)
        yield* sql`UPDATE simulated_execution_clocks
          SET observed_at = ${utcInstantFromEpochMillis(t65)}
          WHERE account_id = ${accountId}`
        const firstPass = yield* settleExpiredTerminalJevBatches(sql, accountId)
        expect(firstPass).toEqual({ candidates: 1, sealed: 1, pending: 0, failed: 0 })
        const restartedStore = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, sql))
        const sealed = yield* restartedStore.read(plan.batchId)
        if (sealed?.result === null || sealed === null) throw new Error('Restart did not observe the sealed batch')
        expect(
          sealed.result.candidates
            .filter((candidate) => candidate.status === JevCandidateResultStatus.Resolved)
            .every(
              (candidate) =>
                candidate.receipt === null && candidate.resolution.status === JevResolutionStatus.Abandoned,
            ),
        ).toBe(true)
        const resultHash = sealed.result.resultHash
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_batch_results`).toEqual([{ count: 1 }])

        const replay = yield* settleExpiredTerminalJevBatches(sql, accountId)
        expect(replay).toEqual({ candidates: 0, sealed: 0, pending: 0, failed: 0 })
        expect(yield* sql`SELECT result_hash FROM jev_batch_results`).toEqual([{ result_hash: resultHash }])
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_resolutions`).toEqual([
          { count: requested.length },
        ])
      }).pipe(atObservation),
    )
  })

  test('does not invent a plan after its deadline or start one before observation', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        for (const now of [observed - 1, observed + fixture.protocol.inferenceValidityMs]) {
          yield* TestClock.setTime(now)
          const result = yield* beginRecordedJevBatch(store, plan, fixture.observation.payload).pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result))
            expect(result.failure._tag).toBe(now < observed ? 'OperationalError' : 'JevBatchExpired')
        }
        expect(yield* store.read(plan.batchId)).toBeNull()
        expect(yield* (yield* PgClient.PgClient)`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
      }).pipe(atObservation),
    )
  })
})
