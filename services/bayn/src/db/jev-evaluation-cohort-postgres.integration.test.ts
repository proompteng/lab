import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Effectable, Layer, ManagedRuntime, Redacted, Result } from 'effect'
import type { Statement } from 'effect/sql/Statement'
import { TestClock } from 'effect/testing'

import { CycleStore } from '../cycle/store/model'
import { CycleStoreLive } from '../cycle/store/postgres'
import { Authority } from '../execution/contracts'
import { JevBatchPlanVersion } from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { stagedCheckpointFixture } from '../jev/entry-inference.test-support'
import { JevEvaluationStore } from '../jev/evaluation'
import {
  persistHandoffFixture,
  persistVisualClaimFixture,
  persistVisualTransitionFixture,
} from '../jev/evaluation.test-support'
import { entryInferenceAvailableAt, makeJevEvaluationReceipt } from '../jev/evidence'
import { nativeJevBatchResult, nativeJevFixture } from '../jev/native.test-support'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { JevResolutionStatus } from '../jev/resolution'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { EntryInferenceJournalLive } from './entry-inference-postgres'
import { JevBatchStoreLive } from './jev-batch-postgres'
import { JevEvaluationStoreLive, makeJevEvaluationStore } from './jev-evaluation-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_jev_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const replayAccountId = `replay-${'d'.repeat(64)}`
const fixture = nativeJevFixture(undefined, undefined, replayAccountId, {
  ...defaultJevProtocolDocument,
  candidateSymbols: ['AAPL', 'AMZN', 'IWM', 'NVDA'],
})
const observedAt = fixture.observation.payload.observedAt
const plan = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: fixture.observation.payload,
    expiresAt: new Date(Date.parse(observedAt) + fixture.protocol.inferenceValidityMs).toISOString(),
    planVersion: JevBatchPlanVersion.V8,
  }),
)
const result = nativeJevBatchResult(plan, observedAt)
const entries = plan.candidates.map((candidate, index) => {
  const completed = result.candidates[index]
  if (candidate.status !== 'REQUESTED' || completed?.status !== 'RESOLVED' || completed.receipt === null)
    throw new Error('Cohort fixture requires four completed candidates')
  return { request: candidate.request, receipt: completed.receipt }
})

const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(CycleStoreLive, CandidateObservationStoreLive, JevBatchStoreLive, EntryInferenceJournalLive).pipe(
      Layer.provideMerge(JevEvaluationStoreLive),
      Layer.provideMerge(
        PostgresClientLive({
          operationTimeoutMs: 5000,
          postgres: { url: Redacted.make(testUrl), tls: false, caPath: '/unused' },
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    ),
  )

const measuredStore = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient
  const measurements = { statements: 0, commits: 0 }
  const measured = new Proxy(sql, {
    apply(target, receiver, args) {
      const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, args)
      const observed = Effectable.Prototype({
        label: 'Measured receipt statement',
        evaluate: () => Effect.sync(() => measurements.statements++).pipe(Effect.andThen(statement)),
      })
      return new Proxy(statement, {
        get(target, property, receiver) {
          return Object.hasOwn(observed, property)
            ? Reflect.get(observed, property, receiver)
            : Reflect.get(target, property, receiver)
        },
      })
    },
    get(target, property, receiver) {
      if (property === 'withTransaction')
        return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          target.withTransaction(effect).pipe(Effect.tap(() => Effect.sync(() => measurements.commits++)))
      return Reflect.get(target, property, receiver)
    },
  })
  const store = yield* makeJevEvaluationStore.pipe(Effect.provideService(PgClient.PgClient, measured))
  return { store, measurements }
})

describePostgres('PostgreSQL cohort receipt persistence', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Cohort integration tests require a local _test database')
    runtime = makeRuntime()
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
        yield* sql`INSERT INTO simulated_execution_clocks (account_id, source_manifest_hash, observed_at)
          VALUES (${replayAccountId}, ${'d'.repeat(64)}, ${observedAt})`
        yield* (yield* CycleStore).acquire(fixture.draft, observedAt)
        yield* sql`INSERT INTO authority_generations (
          generation_hash, schema_version, maximum, authority_version, activated_at
        ) VALUES (${plan.authorityGenerationHash}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 1, ${observedAt})`
        const r = fixture.portfolio.brokerState.reconciliation
        yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
          VALUES (${r.reconciliationId}, ${r.schemaVersion}, ${r.accountId}, ${r.expectedHash}, ${r.observedHash}, ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt})`
        yield* (yield* CandidateObservationStore).record(fixture.observation)
        yield* TestClock.setTime(Date.parse(observedAt))
        yield* (yield* JevBatchStore).begin(plan, fixture.observation.payload)
        const journal = yield* EntryInferenceJournal
        for (const { request, receipt } of entries) {
          const checkpoint = stagedCheckpointFixture(request)
          for (const claim of checkpoint.claims) {
            yield* persistVisualClaimFixture(journal, claim)
            const terminal = checkpoint.terminals.find((row) => row.stage === claim.stage)
            if (terminal !== undefined)
              yield* persistVisualTransitionFixture(journal, { terminal, successor: { kind: 'NONE' } })
          }
          if (receipt.outcome.status !== 'COMPLETED') throw new Error('Cohort fixture requires completed inference')
          yield* persistHandoffFixture(journal, receipt.outcome.completion.handoff)
        }
      }).pipe(Effect.provide(TestClock.layer())),
    )
  })
  afterAll(async () => {
    await runtime?.dispose()
  })

  test('fresh and replayed cohorts use bounded SQL and independently commit exact evidence', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const { store, measurements } = yield* measuredStore
        const resolutions = yield* store.recordAll(entries)
        expect(measurements).toEqual({ statements: 7, commits: 1 })
        const sql = yield* PgClient.PgClient
        const committed =
          yield* sql`SELECT request.request_id, receipt.payload AS receipt, resolution.payload AS resolution
          FROM jev_evaluation_requests request
          JOIN jev_evaluation_receipts receipt USING (request_id)
          JOIN jev_evaluation_resolutions resolution USING (request_id)`
        expect(committed).toHaveLength(entries.length)
        for (const { request, receipt } of entries)
          expect(committed.find((row) => row['request_id'] === request.requestId)).toEqual({
            request_id: request.requestId,
            receipt,
            resolution: resolutions.get(request.requestId),
          })
        expect(yield* store.recordAll([...entries].reverse())).toEqual(resolutions)
        expect(measurements).toEqual({ statements: 13, commits: 2 })
      }),
    )
  })

  test('one cohort preserves recorded and abandoned resolutions while retaining fresh and late evidence', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        const [recorded, abandoned, late, fresh] = entries
        if (recorded === undefined || abandoned === undefined || late === undefined || fresh === undefined)
          throw new Error('Missing cohort fixture')
        const original = (yield* store.recordAll([recorded])).get(recorded.request.requestId)
        const terminal = yield* store.abandon(abandoned.request, abandoned.request.expiresAt)
        const { receiptHash: _, ...material } = late.receipt
        const lateReceipt = Result.getOrThrow(
          makeJevEvaluationReceipt(late.request, {
            ...material,
            completedAt: new Date(Date.parse(late.request.expiresAt) + 1).toISOString(),
          }),
        )
        const cohort = [recorded, abandoned, { request: late.request, receipt: lateReceipt }, fresh]
        const { store: measured, measurements } = yield* measuredStore
        const resolutions = yield* measured.recordAll(cohort)
        expect(measurements).toEqual({ statements: 7, commits: 1 })
        expect(resolutions.get(recorded.request.requestId)).toEqual(original)
        expect(resolutions.get(abandoned.request.requestId)).toEqual(terminal)
        expect(terminal.status).toBe(JevResolutionStatus.Abandoned)
        expect(resolutions.get(late.request.requestId)?.status).toBe(JevResolutionStatus.Recorded)
        expect(resolutions.get(fresh.request.requestId)?.status).toBe(JevResolutionStatus.Recorded)
        for (const entry of cohort) {
          const resolution = resolutions.get(entry.request.requestId)
          if (resolution === undefined) throw new Error('A cohort resolution is missing')
          expect(yield* store.read(entry.request.requestId)).toEqual({
            ...entry,
            resolution,
          })
        }
        expect(
          Result.isFailure(
            entryInferenceAvailableAt(
              late.request,
              lateReceipt,
              Date.parse(lateReceipt.completedAt),
              'bayn.entry-inference-input.v8',
            ),
          ),
        ).toBe(true)
        expect(yield* measured.recordAll([...cohort].reverse())).toEqual(resolutions)
        expect(measurements).toEqual({ statements: 13, commits: 2 })
      }),
    )
  })

  test('one conflicting receipt rolls back every fresh cohort receipt and resolution', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        const first = entries[0]
        if (first === undefined) throw new Error('Missing cohort fixture')
        const original = yield* store.recordAll([first])
        const { receiptHash: _, ...material } = first.receipt
        const changed = Result.getOrThrow(
          makeJevEvaluationReceipt(first.request, {
            ...material,
            completedAt: new Date(Date.parse(first.request.observedAt) + 1).toISOString(),
          }),
        )
        const { store: measured, measurements } = yield* measuredStore
        expect(
          Result.isFailure(
            yield* measured
              .recordAll([{ request: first.request, receipt: changed }, ...entries.slice(1)])
              .pipe(Effect.result),
          ),
        ).toBe(true)
        expect(measurements.commits).toBe(0)
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT request_id, payload FROM jev_evaluation_receipts`).toEqual([
          { request_id: first.request.requestId, payload: first.receipt },
        ])
        expect(yield* sql`SELECT request_id, payload FROM jev_evaluation_resolutions`).toEqual([
          { request_id: first.request.requestId, payload: original.get(first.request.requestId) },
        ])
      }),
    )
  })

  test('an omitted receipt row fails exact cohort verification and rolls back', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`CREATE FUNCTION omit_fixture_receipt() RETURNS trigger LANGUAGE plpgsql AS
          'BEGIN RETURN NULL; END'`
        yield* sql`CREATE TRIGGER omit_fixture_receipt BEFORE INSERT ON jev_evaluation_receipts
          FOR EACH ROW EXECUTE FUNCTION omit_fixture_receipt()`
        const { store, measurements } = yield* measuredStore
        expect(Result.isFailure(yield* store.recordAll(entries).pipe(Effect.result))).toBe(true)
        expect(measurements.commits).toBe(0)
        expect(yield* sql`SELECT request_id FROM jev_evaluation_receipts`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_resolutions`).toEqual([])
      }),
    )
  })

  test('competing reversed cohorts serialize into one immutable result per request', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        const [first, second] = yield* Effect.all([store.recordAll(entries), store.recordAll([...entries].reverse())], {
          concurrency: 2,
        })
        expect(second).toEqual(first)
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT count(*)::int AS count FROM jev_evaluation_receipts`).toEqual([{ count: 4 }])
        expect(yield* sql`SELECT count(*)::int AS count FROM jev_evaluation_resolutions`).toEqual([{ count: 4 }])
        for (const entry of entries) {
          const resolution = first.get(entry.request.requestId)
          if (resolution === undefined) throw new Error('A competing cohort resolution is missing')
          expect(yield* store.read(entry.request.requestId)).toEqual({
            ...entry,
            resolution,
          })
        }
      }),
    )
  })
})
