import { evaluateAdmittedFixture } from '../jev/evaluation.test-support'
import {
  persistVisualClaimFixture,
  persistVisualTransitionFixture,
  persistHandoffFixture,
  persistEvaluationFixture,
} from '../jev/evaluation.test-support'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { entryCompletionFixture, stagedCheckpointFixture } from '../jev/entry-inference.test-support'
import { EntryInferenceJournalLive } from './entry-inference-postgres'
import { DecisionsClient } from '../jev/decisions'
import { chartProviderFixture } from '../jev/entry-inference.test-support'
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
import { InferenceUsageStatus } from '../inference-costs'
import { buildInferenceExpensePlan, makeInferenceExpenseQuotes } from '../inference-expense'
import { JevEvidenceError, JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import { JevClient } from '../jev/client'
import { JevEvaluationStore } from '../jev/evaluation'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { JevBatchStore } from '../jev/batch-evaluation'
import { inferenceFixture } from '../jev/test-support'
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
    Layer.mergeAll(
      CycleStoreLive,
      CandidateObservationStoreLive,
      JevBatchStoreLive,
      EntryInferenceJournalLive,
      Layer.succeed(DecisionsClient, chartProviderFixture),
    ).pipe(
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
const replayAccountId = `replay-${'d'.repeat(64)}`
const fixture = nativeJevFixture(undefined, undefined, replayAccountId, {
  ...defaultJevProtocolDocument,
  candidateSymbols: ['AAPL'],
})
const batch = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: fixture.observation.payload,
    expiresAt: new Date(
      Date.parse(fixture.observation.payload.observedAt) + fixture.protocol.inferenceValidityMs,
    ).toISOString(),
    planVersion: JevBatchPlanVersion.V8,
  }),
)
const candidate = batch.candidates.find((candidate) => candidate.symbol === 'AAPL')
if (candidate?.status !== 'REQUESTED') throw Error('Fixture requires its exact admitted request')
const request = candidate.request
const receipt = Result.getOrThrow(
  makeJevEvaluationReceipt(request, {
    schemaVersion: 'bayn.jev-evaluation-receipt.v3',
    requestId: request.requestId,
    startedAt: request.observedAt,
    completedAt: request.observedAt,
    outcome: { status: JevOutcome.Completed, completion: entryCompletionFixture(request, request.observedAt, 0.9) },
  }),
)
const commitHandoff = Effect.gen(function* () {
  const journal = yield* EntryInferenceJournal
  const checkpoint = stagedCheckpointFixture(request)
  for (const claim of checkpoint.claims) {
    yield* persistVisualClaimFixture(journal, claim)
    const terminal = checkpoint.terminals.find((row) => row.stage === claim.stage)
    if (terminal !== undefined)
      yield* persistVisualTransitionFixture(journal, { terminal: terminal, successor: { kind: 'NONE' } })
  }

  yield* persistHandoffFixture(journal, entryCompletionFixture(request).handoff)
})
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
        yield* sql`INSERT INTO simulated_execution_clocks (account_id, source_manifest_hash, observed_at)
          VALUES (${replayAccountId}, ${'d'.repeat(64)}, ${request.observedAt})`
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

  test('an expired admission never dispatches or fabricates zero cost for its durable claim', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        let calls = 0
        const admission = yield* admit
        const dispatch = admission.dispatches[0]
        if (dispatch === undefined || dispatch.visualClaim === null)
          throw new Error('Missing durable fixture admission')
        yield* TestClock.setTime(Date.parse(request.expiresAt))
        const result = yield* evaluateAdmittedFixture(dispatch).pipe(
          Effect.result,
          Effect.provideService(JevClient, {
            evaluate: () =>
              Effect.sync(() => {
                calls += 1
                return inferenceFixture()
              }),
          }),
        )
        expect(Result.isFailure(result)).toBe(true)
        expect(calls).toBe(0)
        yield* (yield* JevBatchStore).finish(batch.batchId)
        const recovered = yield* store.read(request.requestId)
        expect(recovered?.resolution?.status).toBe(JevResolutionStatus.Abandoned)
        expect(recovered?.receipt).toBeNull()
        if (recovered === null || recovered.resolution === null) throw new Error('Missing durable abandonment')
        const quotes = Result.getOrThrow(
          makeInferenceExpenseQuotes(
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
              handoff: null,
              stagedCheckpoint: { claims: [dispatch.visualClaim], terminals: [], skips: [] },
            },
            { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] },
          ),
        )
        expect(quotes).toHaveLength(3)
        expect(
          quotes.every(
            (quote) =>
              quote.line.usageStatus === InferenceUsageStatus.Unknown && quote.line.estimatedCostPicoUsd === null,
          ),
        ).toBe(true)
        expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers).toHaveLength(0)
      }).pipe(Effect.provide(TestClock.layer())),
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

  test('rejects a competing result and preserves the first recorded inference', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* admit
        yield* commitHandoff
        yield* persistEvaluationFixture(store, request, receipt)
        const { receiptHash: _, ...material } = receipt
        const changed = Result.getOrThrow(
          makeJevEvaluationReceipt(request, {
            ...material,
            completedAt: new Date(Date.parse(request.observedAt) + 1).toISOString(),
          }),
        )
        expect(Result.isFailure(yield* persistEvaluationFixture(store, request, changed).pipe(Effect.result))).toBe(
          true,
        )
        expect(yield* store.read(request.requestId)).toEqual({ request, receipt, resolution: recorded })
      }),
    )
  })

  test('requires a durable matching request before recording a result', async () => {
    const result = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* persistEvaluationFixture(yield* JevEvaluationStore, request, receipt).pipe(Effect.result)
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
        expect(
          Result.isFailure(
            yield* sql.withTransaction(persistEvaluationFixture(store, request, receipt)).pipe(Effect.result),
          ),
        ).toBe(true)
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
        yield* commitHandoff
        yield* persistEvaluationFixture(store, request, receipt)
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
        yield* commitHandoff
        expect(Result.isFailure(yield* store.abandon(request, request.observedAt).pipe(Effect.result))).toBe(true)
        const resolution = yield* store.abandon(request, request.expiresAt)
        expect(resolution.status).toBe(JevResolutionStatus.Abandoned)
        expect(yield* store.abandon(request, '2026-09-21T00:00:00.000Z')).toEqual(resolution)
        expect(yield* persistEvaluationFixture(store, request, receipt)).toEqual(resolution)
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
        yield* commitHandoff
        expect(yield* persistEvaluationFixture(store, request, receipt)).toEqual(recorded)
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
        yield* commitHandoff
        const [record, abandon] = yield* Effect.all(
          [persistEvaluationFixture(store, request, receipt), store.abandon(request, request.expiresAt)],
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
        yield* commitHandoff
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
