import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { Effect, Layer, ManagedRuntime, Redacted, Result } from 'effect'

import { CycleStore, CycleStoreLive } from '../cycle/store'
import { Authority } from '../execution/contracts'
import { canonicalHashV1 } from '../hash'
import { JevOutcome, makeJevEvaluationReceipt, makeJevEvaluationRequest } from '../jev/evidence'
import { JevClaim, JevEvaluationStore } from '../jev/evaluation'
import { evaluationRequestFixture, inferenceFixture } from '../jev/test-support'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { candidateObservationFixture } from '../testing/candidate-observation-fixture'
import { JevEvaluationStoreLive } from './jev-evaluation-postgres'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_jev_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const makeRuntime = () =>
  ManagedRuntime.make(
    Layer.mergeAll(CycleStoreLive, JevEvaluationStoreLive).pipe(
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
const { requestId: _, ...material } = evaluationRequestFixture()
const request = Result.getOrThrow(makeJevEvaluationRequest({ ...material, cycleId: fixture.draft.identity.cycleId }))
const receipt = Result.getOrThrow(
  makeJevEvaluationReceipt(request, {
    schemaVersion: 'bayn.jev-evaluation-receipt.v1',
    requestId: request.requestId,
    startedAt: request.observedAt,
    completedAt: request.observedAt,
    outcome: { status: JevOutcome.Received, inference: inferenceFixture() },
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
        yield* sql`INSERT INTO authority_generations (
        generation_hash, schema_version, maximum, authority_version, activated_at
      ) VALUES (${request.authorityGenerationHash}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 1, ${request.observedAt})`
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
        expect(yield* store.begin(request)).toEqual({ status: JevClaim.Recorded, receipt })
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
            completedAt: '1970-01-01T00:00:00.001Z',
          }),
        )
        expect(Result.isFailure(yield* store.record(request, changed).pipe(Effect.result))).toBe(true)
        expect(yield* store.begin(request)).toEqual({ status: JevClaim.Recorded, receipt })
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

  test('forbids update, delete and truncate of both evidence tables', async () => {
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
          sql`TRUNCATE jev_evaluation_receipts`,
        ])
          expect(Result.isFailure(yield* operation.pipe(Effect.result))).toBe(true)
        expect(yield* store.begin(request)).toEqual({ status: JevClaim.Recorded, receipt })
      }),
    )
  })
})
