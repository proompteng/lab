import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, FileSystem, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

import resolutionMigration from '../../migrations/0077_jev_evaluation_resolution'
import { CycleStore, CycleStoreLive } from '../cycle/store'
import { Authority } from '../execution/contracts'
import { canonicalHashV1 } from '../hash'
import { JevBatchPlanVersion } from '../jev/batch'
import { JevEvidenceError, JevOutcome, makeJevEvaluationReceipt, makeJevEvaluationRequest } from '../jev/evidence'
import { JevClient } from '../jev/client'
import { evaluateJevOnce, JevClaim, JevEvaluationStore } from '../jev/evaluation'
import { tradingSignalInferenceFixture } from '../jev/trading-signal.test-support'
import { makeJevTradingSignalBatch, makeJevTradingSignalRequest } from '../jev/trading-signals'
import { JevBatchStore } from '../jev/batch-evaluation'
import { evaluationRequestFixture, inferenceFixture } from '../jev/test-support'
import { decodeJevResolution, JevResolutionStatus, makeJevResolution } from '../jev/resolution'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { candidateObservationFixture } from '../testing/candidate-observation-fixture'
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
const fixture = candidateObservationFixture()
const prepared = Result.getOrThrow(
  makeJevTradingSignalRequest(fixture.snapshot, 'AAPL', fixture.protocol.benchmarkSymbol),
)
const request = Result.getOrThrow(
  makeJevEvaluationRequest({
    schemaVersion: 'bayn.jev-evaluation-request.v1',
    symbol: 'AAPL',
    authorityGenerationHash: fixture.input.authorityGenerationHash,
    requestHash: prepared.requestHash,
    request: prepared.request,
    cycleId: fixture.draft.identity.cycleId,
    snapshotId: fixture.snapshot.manifest.snapshotId,
    observedAt: fixture.input.observedAt,
    expiresAt: new Date(Date.parse(fixture.input.observedAt) + 5000).toISOString(),
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
    planVersion: JevBatchPlanVersion.V1,
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
        yield* (yield* CycleStore).acquire(fixture.draft, fixture.cycle.createdAt)
        yield* (yield* CandidateObservationStore).record(fixture.observation)
        yield* sql`INSERT INTO authority_generations (
        generation_hash, schema_version, maximum, authority_version, activated_at
      ) VALUES (${request.authorityGenerationHash}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 1, ${request.observedAt})`
        yield* TestClock.setTime(Date.parse(request.observedAt)).pipe(
          Effect.andThen((yield* JevBatchStore).begin(batch)),
          Effect.provide(TestClock.layer()),
        )
      }),
    )
  })
  afterAll(async () => {
    await runtime?.dispose()
  })

  test('only one concurrent caller owns inference; later callers recover the exact durable result', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        const claims = yield* Effect.all([store.begin(request), store.begin(request)], { concurrency: 2 })
        expect(claims.map((claim) => claim.status).sort()).toEqual([JevClaim.Acquired, JevClaim.Pending])
        yield* store.record(request, receipt)
        yield* store.record(request, receipt)
        expect(yield* store.begin(request)).toEqual({ status: JevClaim.Recorded, receipt, resolution: recorded })
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT request_id FROM jev_evaluation_receipts`).toEqual([{ request_id: request.requestId }])
      }),
    )
  })

  test('rejects a different prompt for the same candidate and market snapshot', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* store.begin(request)
        const nextPrompt = { ...request.request, state: { changed: 'different inference' } }
        const { requestId: _, ...material } = request
        const changed = Result.getOrThrow(
          makeJevEvaluationRequest({ ...material, request: nextPrompt, requestHash: canonicalHashV1(nextPrompt) }),
        )
        expect(Result.isFailure(yield* store.begin(changed).pipe(Effect.result))).toBe(true)
        expect(yield* store.begin(request)).toEqual({ status: JevClaim.Pending })
      }),
    )
  })

  test('rejects substituted model input before it can acquire the immutable candidate slot', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        const { requestId: _, ...material } = request
        for (const payload of [
          { ...request.request, state: { fabricated: 'unrelated favorable market' } },
          { ...request.request, questions: { changed: { type: 'noul', instructions: 'Is this favorable?' } } },
        ]) {
          const substituted = Result.getOrThrow(
            makeJevEvaluationRequest({ ...material, request: payload, requestHash: canonicalHashV1(payload) }),
          )
          expect(Result.isFailure(yield* store.begin(substituted).pipe(Effect.result))).toBe(true)
        }
        expect(yield* (yield* PgClient.PgClient)`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
        expect(yield* store.begin(request)).toEqual({ status: JevClaim.Acquired })
      }),
    )
  })

  test('a retained source reproduction does not hide changed observation bytes', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        const sql = yield* PgClient.PgClient
        expect(yield* store.begin(request)).toEqual({ status: JevClaim.Acquired })
        // Simulate privileged storage corruption after the source cut has been verified and retained.
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER intraday_candidate_observations_immutable`
        yield* sql`UPDATE intraday_candidate_observations
          SET payload = jsonb_set(payload, '{protocol,maximumQuoteAgeMs}', '1'::jsonb)
          WHERE content_hash = ${fixture.observation.contentHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER intraday_candidate_observations_immutable`
        expect(Result.isFailure(yield* store.begin(request).pipe(Effect.result))).toBe(true)
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
        expect(Result.isFailure(yield* store.begin(historical).pipe(Effect.result))).toBe(true)
      }),
    )
  })

  test('rejects validly hashed claims without a matching persisted cycle observation', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const otherGeneration = 'd'.repeat(64)
        yield* sql`INSERT INTO authority_generations (
        generation_hash, schema_version, maximum, authority_version, activated_at
      ) VALUES (${otherGeneration}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 2, ${request.observedAt})`
        const { requestId: _, ...base } = request
        for (const change of [
          { snapshotId: 'e'.repeat(64) },
          { authorityGenerationHash: otherGeneration },
          { symbol: 'ZZZZ' },
          { observedAt: new Date(Date.parse(request.observedAt) + 1).toISOString() },
        ]) {
          const changed = Result.getOrThrow(makeJevEvaluationRequest({ ...base, ...change }))
          const result = yield* (yield* JevEvaluationStore).begin(changed).pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
        }
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
      }),
    )
  })

  test('rejects a candidate observation whose retained content hash is forged', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO intraday_candidate_observations (content_hash, cycle_id, observed_at, payload)
        VALUES (${'f'.repeat(64)}, ${request.cycleId}, ${request.observedAt}::timestamptz, ${sql.json(fixture.observation.payload)})`
        expect(Result.isFailure(yield* (yield* JevEvaluationStore).begin(request).pipe(Effect.result))).toBe(true)
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
      }),
    )
  })

  test('rejects a competing result and preserves the first recorded inference', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* store.begin(request)
        yield* store.record(request, receipt)
        const { receiptHash: _, ...material } = receipt
        const changed = Result.getOrThrow(
          makeJevEvaluationReceipt(request, {
            ...material,
            completedAt: new Date(Date.parse(request.observedAt) + 1).toISOString(),
          }),
        )
        expect(Result.isFailure(yield* store.record(request, changed).pipe(Effect.result))).toBe(true)
        expect(yield* store.begin(request)).toEqual({ status: JevClaim.Recorded, receipt, resolution: recorded })
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

  test('rejects an ambient transaction before claiming or invoking the provider', async () => {
    let calls = 0
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const result = yield* TestClock.setTime(Date.parse(request.observedAt)).pipe(
          Effect.andThen(sql.withTransaction(evaluateJevOnce(request))),
          Effect.result,
          Effect.provideService(JevClient, {
            evaluate: () =>
              Effect.sync(() => {
                calls += 1
                return tradingSignalInferenceFixture(request.request, request.observedAt)
              }),
          }),
          Effect.provide(TestClock.layer()),
        )
        expect(Result.isFailure(result)).toBe(true)
        expect(calls).toBe(0)
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_receipts`).toEqual([])
      }),
    )
  })

  test('rejects receipt persistence in an ambient transaction', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* JevEvaluationStore
        yield* store.begin(request)
        expect(Result.isFailure(yield* sql.withTransaction(store.record(request, receipt)).pipe(Effect.result))).toBe(
          true,
        )
        expect(yield* store.begin(request)).toEqual({ status: JevClaim.Pending })
        expect(yield* sql`SELECT request_id FROM jev_evaluation_receipts`).toEqual([])
      }),
    )
  })

  test('forbids update, delete and truncate of every evidence table', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* store.begin(request)
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
        expect(yield* store.begin(request)).toEqual({ status: JevClaim.Recorded, receipt, resolution: recorded })
      }),
    )
  })

  test('abandonment is terminal and keeps the first recovery time while retaining late evidence', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        expect(yield* store.read(request.requestId)).toBeNull()
        expect(Result.isFailure(yield* store.abandon(request, request.expiresAt).pipe(Effect.result))).toBe(true)
        yield* store.begin(request)
        expect(Result.isFailure(yield* store.abandon(request, request.observedAt).pipe(Effect.result))).toBe(true)
        const resolution = yield* store.abandon(request, request.expiresAt)
        expect(resolution.status).toBe(JevResolutionStatus.Abandoned)
        expect(yield* store.abandon(request, '2026-09-21T00:00:00.000Z')).toEqual(resolution)
        expect(yield* store.record(request, receipt)).toEqual(resolution)
        expect(yield* store.begin(request)).toEqual({ status: JevClaim.Abandoned, resolution })
        expect(yield* store.read(request.requestId)).toEqual({ request, receipt, resolution })
      }),
    )
  })

  test('a committed result remains recorded when expired recovery runs', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* store.begin(request)
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
        yield* store.begin(request)
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
        yield* store.begin(request)
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
        yield* store.begin(request)
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
