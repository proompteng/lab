import { jevRequestForSnapshot } from '../jev/native.test-support'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'

import resolutionMigration from '../../migrations/0077_jev_evaluation_resolution'
import { CycleStore } from '../cycle/store/model'
import { CycleStoreLive } from '../cycle/store/postgres'
import { Authority } from '../execution/contracts'
import { IsoDateSchema } from '../schemas'
import { JevBatchPlanVersion } from '../jev/batch'
import { JevFailure } from '../jev/contract'
import { InferenceUsageStatus } from '../inference-costs'
import { buildInferenceExpensePlan, makeInferenceExpenseQuote } from '../inference-expense'
import { JevEvidenceError, JevOutcome, makeJevEvaluationReceipt, makeJevEvaluationRequest } from '../jev/evidence'
import { JevClient } from '../jev/client'
import { evaluateClaimedJevOnce, JevEvaluationStore } from '../jev/evaluation'
import { tradingSignalInferenceFixture } from '../jev/trading-signal.test-support'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { JevBatchStore } from '../jev/batch-evaluation'
import { evaluationRequestFixture, inferenceFixture } from '../jev/test-support'
import { decodeJevResolution, JevResolutionStatus, makeJevResolution } from '../jev/resolution'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { nativeJevFixture } from '../jev/native.test-support'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { JevEvaluationStoreLive } from './jev-evaluation-postgres'
import { JevBatchStoreLive } from './jev-batch-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_jev_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(CycleStoreLive, CandidateObservationStoreLive, JevBatchStoreLive).pipe(
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
const fixture = nativeJevFixture()
const prepared = Result.getOrThrow(jevRequestForSnapshot(fixture.snapshot, 'AAPL'))
const request = Result.getOrThrow(
  makeJevEvaluationRequest({
    schemaVersion: 'bayn.jev-evaluation-request.v1',
    symbol: 'AAPL',
    authorityGenerationHash: fixture.input.authorityGenerationHash,
    requestHash: prepared.requestHash,
    request: prepared.request,
    cycleId: fixture.draft.identity.cycleId,
    snapshotId: fixture.snapshot.manifest.snapshotId,
    observedAt: fixture.observation.payload.observedAt,
    expiresAt: new Date(
      Date.parse(fixture.observation.payload.observedAt) + fixture.protocol.inferenceValidityMs,
    ).toISOString(),
  }),
)
const receipt = Result.getOrThrow(
  makeJevEvaluationReceipt(request, {
    schemaVersion: 'bayn.jev-evaluation-receipt.v1',
    requestId: request.requestId,
    startedAt: request.observedAt,
    completedAt: request.observedAt,
    outcome: {
      status: JevOutcome.Received,
      inference: tradingSignalInferenceFixture(request.request, request.observedAt),
    },
  }),
)
const batch = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: fixture.observation.payload,
    expiresAt: request.expiresAt,
    planVersion: JevBatchPlanVersion.V6,
  }),
)
const recorded = Result.getOrThrow(
  makeJevResolution(request, receipt, {
    schemaVersion: 'bayn.jev-evaluation-resolution.v1',
    requestId: request.requestId,
    status: JevResolutionStatus.Recorded,
    receiptHash: receipt.receiptHash,
  }),
)

const admit = TestClock.setTime(Date.parse(request.observedAt)).pipe(
  Effect.andThen(Effect.flatMap(JevBatchStore, (store) => store.begin(batch, fixture.observation.payload))),
  Effect.provide(TestClock.layer()),
)

describePostgres('PostgreSQL Jev evaluation evidence', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test')) {
      throw new Error('Jev integration tests require a local _test database')
    }
    runtime = makeRuntime()
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
        yield* (yield* CycleStore).acquire(fixture.draft, fixture.snapshot.manifest.observedAt)
        yield* sql`INSERT INTO authority_generations (
        generation_hash, schema_version, maximum, authority_version, activated_at
      ) VALUES (${request.authorityGenerationHash}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 1, ${request.observedAt})`
        const r = fixture.portfolio.brokerState.reconciliation
        yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at)
          VALUES (${r.reconciliationId}, ${r.schemaVersion}, ${r.accountId}, ${r.expectedHash}, ${r.observedHash}, ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt})`
        yield* (yield* CandidateObservationStore).record(fixture.observation)
      }),
    )
  })
  afterAll(async () => {
    await runtime?.dispose()
  })

  test('retains a zero-cost receipt when the durable claim crosses expiry without dispatch', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        let calls = 0
        const result = yield* TestClock.setTime(Date.parse(request.observedAt)).pipe(
          Effect.andThen(admit),
          Effect.andThen(TestClock.setTime(Date.parse(request.expiresAt))),
          Effect.andThen(evaluateClaimedJevOnce({ request, claimedAt: request.observedAt })),
          Effect.result,
          Effect.provideService(JevClient, {
            evaluate: () =>
              Effect.sync(() => {
                calls += 1
                return inferenceFixture()
              }),
          }),
          Effect.provide(TestClock.layer()),
        )
        expect(Result.isFailure(result)).toBe(true)
        expect(calls).toBe(0)
        const recovered = yield* store.read(request.requestId)
        expect(recovered?.resolution?.status).toBe(JevResolutionStatus.Recorded)
        if (recovered?.receipt === null || recovered?.receipt === undefined || recovered.resolution === null)
          throw new Error('Missing durable undispatched receipt')
        expect(recovered.receipt.outcome).toEqual({
          status: JevOutcome.Failed,
          failure: JevFailure.NotDispatched,
          httpStatus: null,
          responseHash: null,
          rejectedResponse: null,
        })
        const quote = Result.getOrThrow(
          makeInferenceExpenseQuote(
            {
              accountId: 'fixture-account',
              sessionDate: yield* Schema.decodeUnknownEffect(IsoDateSchema)(request.observedAt.slice(0, 10)),
              asOf: request.expiresAt,
              requestId: request.requestId,
              cycleId: request.cycleId,
              authorityGenerationHash: request.authorityGenerationHash,
              request,
              receipt: recovered.receipt,
              resolution: recovered.resolution,
            },
            { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] },
          ),
        )
        expect(quote.line.usageStatus).toBe(InferenceUsageStatus.NotDispatched)
        expect(quote.line.estimatedCostPicoUsd).toBe('0')
        expect(Result.getOrThrow(buildInferenceExpensePlan([quote])).transfers).toHaveLength(0)
      }),
    )
  })

  test('a retained source reproduction does not hide changed observation bytes', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        const sql = yield* PgClient.PgClient
        yield* admit
        // Simulate privileged storage corruption after the source cut has been verified and retained.
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER intraday_candidate_observations_immutable`
        yield* sql`UPDATE intraday_candidate_observations
          SET payload = jsonb_set(payload, '{protocol,maximumQuoteAgeMs}', '1'::jsonb)
          WHERE content_hash = ${fixture.observation.contentHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER intraday_candidate_observations_immutable`
        expect(Result.isFailure(yield* admit.pipe(Effect.result))).toBe(true)
        expect(Result.isFailure(yield* store.read(request.requestId).pipe(Effect.result))).toBe(true)
        expect(yield* sql`SELECT request_id FROM jev_evaluation_receipts`).toEqual([])
      }),
    )
  })

  test('historical request bytes remain readable while superseded input cannot start or resume inference', async () => {
    const { requestId: _, ...material } = request
    const priorInput = evaluationRequestFixture()
    const historical = Result.getOrThrow(
      makeJevEvaluationRequest({
        ...material,
        request: priorInput.request,
        requestHash: priorInput.requestHash,
      }),
    )
    const historicalReceipt = Result.getOrThrow(
      makeJevEvaluationReceipt(historical, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v1',
        requestId: historical.requestId,
        startedAt: historical.observedAt,
        completedAt: historical.observedAt,
        outcome: { status: JevOutcome.Received, inference: inferenceFixture(historical.observedAt) },
      }),
    )
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO jev_evaluation_requests (request_id, cycle_id, authority_generation_hash, payload)
        VALUES (${historical.requestId}, ${historical.cycleId}, ${historical.authorityGenerationHash}, ${sql.json(historical)})`
        const store = yield* JevEvaluationStore
        const resolution = yield* store.record(historical, historicalReceipt)
        expect(yield* store.read(historical.requestId)).toEqual({
          request: historical,
          receipt: historicalReceipt,
          resolution,
        })
      }),
    )
  })

  test('rejects a competing result and preserves the first recorded inference', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* admit
        yield* store.record(request, receipt)
        const { receiptHash: _, ...material } = receipt
        const changed = Result.getOrThrow(
          makeJevEvaluationReceipt(request, {
            ...material,
            completedAt: new Date(Date.parse(request.observedAt) + 1).toISOString(),
          }),
        )
        expect(Result.isFailure(yield* store.record(request, changed).pipe(Effect.result))).toBe(true)
        expect(yield* store.read(request.requestId)).toEqual({ request, receipt, resolution: recorded })
      }),
    )
  })

  test('requires a durable matching request before recording a result', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* JevEvaluationStore).record(request, receipt).pipe(Effect.result)
      }),
    )
    expect(Result.isFailure(result)).toBe(true)
  })

  test('rejects receipt persistence in an ambient transaction', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* JevEvaluationStore
        yield* admit
        expect(Result.isFailure(yield* sql.withTransaction(store.record(request, receipt)).pipe(Effect.result))).toBe(
          true,
        )
        expect(yield* store.read(request.requestId)).toEqual({ request, receipt: null, resolution: null })
        expect(yield* sql`SELECT request_id FROM jev_evaluation_receipts`).toEqual([])
      }),
    )
  })

  test('forbids update, delete and truncate of every evidence table', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* admit
        yield* store.record(request, receipt)
        const sql = yield* PgClient.PgClient
        for (const operation of [
          sql`UPDATE jev_evaluation_requests SET payload = payload`,
          sql`DELETE FROM jev_evaluation_requests`,
          sql`TRUNCATE jev_evaluation_requests CASCADE`,
          sql`UPDATE jev_evaluation_receipts SET payload = payload`,
          sql`DELETE FROM jev_evaluation_receipts`,
          sql`TRUNCATE jev_evaluation_receipts CASCADE`,
          sql`UPDATE jev_evaluation_resolutions SET payload = payload`,
          sql`DELETE FROM jev_evaluation_resolutions`,
          sql`TRUNCATE jev_evaluation_resolutions`,
        ])
          expect(Result.isFailure(yield* operation.pipe(Effect.result))).toBe(true)
        expect(yield* store.read(request.requestId)).toEqual({ request, receipt, resolution: recorded })
      }),
    )
  })

  test('abandonment is terminal and keeps the first recovery time while retaining late evidence', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        expect(yield* store.read(request.requestId)).toBeNull()
        expect(Result.isFailure(yield* store.abandon(request, request.expiresAt).pipe(Effect.result))).toBe(true)
        yield* admit
        expect(Result.isFailure(yield* store.abandon(request, request.observedAt).pipe(Effect.result))).toBe(true)
        const resolution = yield* store.abandon(request, request.expiresAt)
        expect(resolution.status).toBe(JevResolutionStatus.Abandoned)
        expect(yield* store.abandon(request, '2026-09-21T00:00:00.000Z')).toEqual(resolution)
        expect(yield* store.record(request, receipt)).toEqual(resolution)
        expect((yield* store.read(request.requestId))?.resolution).toEqual(resolution)
        expect(yield* store.read(request.requestId)).toEqual({ request, receipt, resolution })
      }),
    )
  })

  test('a committed result remains recorded when expired recovery runs', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* admit
        expect(yield* store.record(request, receipt)).toEqual(recorded)
        expect(yield* store.abandon(request, request.expiresAt)).toEqual(recorded)
        expect(yield* store.read(request.requestId)).toEqual({ request, receipt, resolution: recorded })
      }),
    )
  })

  test('concurrent record and abandonment agree on one immutable resolution', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* admit
        const [record, abandon] = yield* Effect.all(
          [store.record(request, receipt), store.abandon(request, request.expiresAt)],
          { concurrency: 2 },
        )
        expect(record).toEqual(abandon)
        expect(yield* store.read(request.requestId)).toEqual({ request, receipt, resolution: record })
        expect(
          yield* (yield* PgClient.PgClient)`SELECT count(*)::int AS count FROM jev_evaluation_resolutions`,
        ).toEqual([{ count: 1 }])
      }),
    )
  })

  test('rejects abandonment in an ambient transaction', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* JevEvaluationStore
        yield* admit
        expect(
          Result.isFailure(yield* sql.withTransaction(store.abandon(request, request.expiresAt)).pipe(Effect.result)),
        ).toBe(true)
        expect(yield* store.read(request.requestId)).toEqual({ request, receipt: null, resolution: null })
      }),
    )
  })

  test('migrates existing receipts to canonical resolutions without changing their bytes', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* JevEvaluationStore
        yield* admit
        yield* sql`DROP TABLE inference_expense_quotes`
        yield* sql`DROP TABLE jev_evaluation_resolutions`
        yield* sql`ALTER TABLE jev_evaluation_receipts DROP CONSTRAINT jev_receipt_request_hash`
        yield* sql`INSERT INTO jev_evaluation_receipts (request_id, receipt_hash, payload)
        VALUES (${request.requestId}, ${receipt.receiptHash}, ${sql.json(receipt)})`
        const before = yield* sql`SELECT payload::text AS payload FROM jev_evaluation_receipts`
        yield* sql.withTransaction(resolutionMigration)
        expect(yield* sql`SELECT payload::text AS payload FROM jev_evaluation_receipts`).toEqual(before)
        expect(yield* store.read(request.requestId)).toEqual({ request, receipt, resolution: recorded })
      }),
    )
  })

  for (const mode of ['claim', 'record'])
    test(`process death after ${mode} commits recovers from PostgreSQL alone`, async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const directory = yield* fs.makeTempDirectoryScoped()
          const requestPath = `${directory}/request.json`,
            checkpoint = `${directory}/checkpoint`,
            resultPath = `${directory}/result.json`
          yield* admit
          yield* fs.writeFileString(requestPath, JSON.stringify(request))
          const command = (mode: string) =>
            ChildProcess.make(
              process.execPath,
              [
                `${import.meta.dir}/../jev/restart-worker.test-support.ts`,
                mode,
                request.requestId,
                requestPath,
                checkpoint,
                resultPath,
              ],
              { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', killSignal: 'SIGKILL' },
            )
          const first = yield* spawner.spawn(command(mode))
          while (!(yield* fs.exists(checkpoint))) {
            if (!(yield* first.isRunning))
              return yield* new JevEvidenceError({ message: 'Jev worker exited before durable commit' })
            yield* Effect.sleep('25 millis')
          }
          yield* first.kill({ killSignal: 'SIGKILL' })
          yield* Effect.exit(first.exitCode)
          yield* fs.remove(checkpoint)
          yield* fs.remove(requestPath)
          const second = yield* spawner.spawn(command('recover'))
          expect(second.pid).not.toBe(first.pid)
          expect(Number(yield* second.exitCode)).toBe(0)
          const result = yield* fs
            .readFileString(resultPath)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))))
          const recovered = yield* Effect.fromResult(
            decodeJevResolution(request, mode === 'record' ? receipt : null, result),
          )
          expect(recovered.status).toBe(
            mode === 'record' ? JevResolutionStatus.Recorded : JevResolutionStatus.Abandoned,
          )
          expect(yield* (yield* JevEvaluationStore).read(request.requestId)).toEqual({
            request,
            receipt: mode === 'record' ? receipt : null,
            resolution: recovered,
          })
        }).pipe(Effect.scoped, Effect.timeout('25 seconds')),
      )
    }, 30000)
})
