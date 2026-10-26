import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import { PgMigrator } from '@effect/sql-pg'
import { Clock, Effect, Layer, ManagedRuntime, Redacted, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'
import sequentialEntryInference from '../../migrations/0147_sequential_entry_inference'
import relativeChartVolume from '../../migrations/0148_relative_chart_volume'

import { CycleStore } from '../cycle/store/model'
import { CycleStoreLive } from '../cycle/store/postgres'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { chartInferenceFixture, entryCompletionFixture } from '../jev/entry-inference.test-support'
import { DecisionsClient } from '../jev/decisions'
import { JevClient } from '../jev/client'
import { prepareJevRequest } from '../jev/contract'
import { JevBatchPlanVersion, JevCandidatePlanStatus } from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevEvaluationStore, evaluateClaimedJevOnce } from '../jev/evaluation'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import { JevResolutionStatus } from '../jev/resolution'
import { nativeJevFixture, nativeJevInference } from '../jev/native.test-support'
import { utcInstantFromEpochMillis } from '../time'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { baynTestPostgresUrl, baynTestTigerBeetleAddress } from '../test-environment.test-support'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { EntryInferenceJournalLive } from './entry-inference-postgres'
import { JevBatchStoreLive } from './jev-batch-postgres'
import { JevEvaluationStoreLive } from './jev-evaluation-postgres'
import { postgresMigrations } from './postgres-migrations'
import { migrationLoader } from './migrations'
import { canonicalHashV1Result } from '../hash'
import { inferenceExpenseRateCard, makeInferenceExpenseQuotes, buildInferenceExpensePlan } from '../inference-expense'
import { makeInferenceExpenseStore } from '../inference-expense-postgres'
import { InferenceStage } from '../inference-costs'
import { JevFailure } from '../jev/contract'
import { runInferenceExpensePass } from '../inference-expense-runtime'
import { makeTigerBeetleRequestClient } from '../tigerbeetle-client'
import { readInferenceExpenseSnapshot } from '../inference-costs-postgres'
import { readInferenceExpenseLedger } from '../inference-expense-journal'

const integration = baynTestPostgresUrl === undefined ? describe.skip : describe
const url = baynTestPostgresUrl ?? 'postgresql://localhost/bayn_sequential_entry_0391_test'
const fixture = nativeJevFixture()
const batch = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: fixture.observation.payload,
    expiresAt: new Date(
      Date.parse(fixture.observation.payload.observedAt) + fixture.protocol.inferenceValidityMs,
    ).toISOString(),
    planVersion: JevBatchPlanVersion.V7,
  }),
)
const candidate = batch.candidates.find((value) => value.status === JevCandidatePlanStatus.Requested)
if (candidate?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing native entry request')
const request = candidate.request
const completion = entryCompletionFixture(request)
const receipt = Result.getOrThrow(
  makeJevEvaluationReceipt(request, {
    schemaVersion: 'bayn.jev-evaluation-receipt.v2',
    requestId: request.requestId,
    startedAt: request.observedAt,
    completedAt: request.observedAt,
    outcome: { status: JevOutcome.Completed, completion },
  }),
)
const runtimeLayer = Layer.mergeAll(
  CycleStoreLive,
  CandidateObservationStoreLive,
  JevBatchStoreLive,
  JevEvaluationStoreLive,
  EntryInferenceJournalLive,
).pipe(
  Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 })),
  Layer.provideMerge(NodeServices.layer),
)
const makeRuntime = () => ManagedRuntime.make(runtimeLayer)

integration('committed sequential provider handoff', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(url)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Provider handoff tests require an isolated local _test database')
    runtime = makeRuntime()
  })
  afterAll(async () => runtime?.dispose())
  beforeEach(async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
        yield* (yield* CycleStore).acquire(fixture.draft, request.observedAt)
        yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
      VALUES (${request.authorityGenerationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${request.observedAt})`
        const r = fixture.portfolio.brokerState.reconciliation
        yield* sql`INSERT INTO reconciliations (reconciliation_id,schema_version,account_id,expected_hash,observed_hash,content_hash,status,discrepancies,reconciled_at)
      VALUES (${r.reconciliationId},${r.schemaVersion},${r.accountId},${r.expectedHash},${r.observedHash},${r.contentHash},${r.status},'[]'::jsonb,${r.reconciledAt})`
        yield* (yield* CandidateObservationStore).record(fixture.observation)
        yield* TestClock.setTime(Date.parse(request.observedAt)).pipe(
          Effect.andThen(Effect.flatMap(JevBatchStore, (store) => store.begin(batch, fixture.observation.payload))),
          Effect.provide(TestClock.layer()),
        )
      }),
    ),
  )

  test('commits the exact handoff once and binds the completed receipt to it', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const journal = yield* EntryInferenceJournal
        const claims = yield* Effect.all(
          [journal.recordHandoff(completion.handoff), journal.recordHandoff(completion.handoff)],
          { concurrency: 2 },
        )

        expect(claims.filter((value) => value.dispatchAllowed)).toHaveLength(1)
        const store = yield* JevEvaluationStore
        yield* store.record(request, receipt)
        expect((yield* store.read(request.requestId))?.receipt).toEqual(receipt)
      }),
    ))

  test('runs the native evaluator through committed chart evidence before dependent Jev inference', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const events: string[] = []
        const result = yield* TestClock.setTime(Date.parse(request.observedAt)).pipe(
          Effect.andThen(evaluateClaimedJevOnce({ request, claimedAt: request.observedAt })),
          Effect.provideService(DecisionsClient, {
            evaluate: () =>
              Effect.gen(function* () {
                events.push('chart')
                return chartInferenceFixture(request.request, utcInstantFromEpochMillis(yield* Clock.currentTimeMillis))
              }),
          }),
          Effect.provideService(JevClient, {
            evaluate: (raw) =>
              Effect.gen(function* () {
                const prepared = Result.getOrThrow(prepareJevRequest(raw))
                const [stored] = yield* sql`SELECT payload #>> '{disposition,jevRequestHash}' AS request_hash
          FROM jev_inference_handoffs WHERE request_id=${request.requestId}`.pipe(Effect.orDie)
                expect(stored?.['request_hash']).toBe(prepared.requestHash)
                events.push('jev-after-committed-handoff')
                return nativeJevInference(prepared.request, utcInstantFromEpochMillis(yield* Clock.currentTimeMillis))
              }),
          }),
          Effect.provide(TestClock.layer()),
        )
        expect(events).toEqual(['chart', 'jev-after-committed-handoff'])
        expect(result.inference.jev.status).toBe('RECEIVED')
        expect((yield* (yield* JevEvaluationStore).read(request.requestId))?.receipt).toEqual(result.receipt)
      }),
    ))
  test('rejects a receipt with no committed handoff', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        expect(Result.isFailure(yield* store.record(request, receipt).pipe(Effect.result))).toBe(true)
        expect((yield* store.read(request.requestId))?.receipt).toBeNull()
      }),
    ))

  test('retains late chart costs after abandonment without allowing dependent dispatch', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevEvaluationStore
        yield* store.abandon(request, request.expiresAt)
        expect(yield* (yield* EntryInferenceJournal).recordHandoff(completion.handoff)).toEqual({
          dispatchAllowed: false,
        })
        const sql = yield* PgClient.PgClient
        expect(
          yield* sql`SELECT handoff_hash FROM jev_inference_handoffs WHERE request_id=${request.requestId}`,
        ).toEqual([{ handoff_hash: completion.handoff.handoffHash }])
        expect((yield* store.read(request.requestId))?.resolution?.status).toBe(JevResolutionStatus.Abandoned)
      }),
    ))

  test('freezes a partial chart expense and later adds Jev cost without duplicating the chart', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const evaluations = yield* JevEvaluationStore
        yield* (yield* EntryInferenceJournal).recordHandoff(completion.handoff)
        yield* evaluations.abandon(request, request.expiresAt)
        const expenses = makeInferenceExpenseStore(sql, fixture.portfolio.brokerState.account.accountId, '1970-01-01')
        const tariff = {
          ...inferenceExpenseRateCard,
          rates: inferenceExpenseRateCard.rates.map((rate) => ({ ...rate, effectiveFrom: '1970-01-01T00:00:00.000Z' })),
        }
        const first = (yield* expenses.newSources).find((value) => value.requestId === request.requestId)
        if (first === undefined) throw new Error('Missing partial inference expense source')
        const partial = Result.getOrThrow(makeInferenceExpenseQuotes(first, tariff))
        expect(Result.getOrThrow(buildInferenceExpensePlan(partial)).transfers).toHaveLength(1)
        yield* expenses.freeze(partial)
        expect(yield* expenses.newSources).toEqual([])
        expect(yield* expenses.pending).toHaveLength(2)
        yield* evaluations.record(request, receipt)
        const next = (yield* expenses.newSources).find((value) => value.requestId === request.requestId)
        if (next === undefined) throw new Error('Missing late Jev expense source')
        const complete = Result.getOrThrow(makeInferenceExpenseQuotes(next, tariff))
        const chart = (quotes: typeof partial) =>
          quotes.find((quote) => 'stage' in quote.line && quote.line.stage === InferenceStage.Chart)
        expect(chart(complete)?.quoteHash).toBe(chart(partial)?.quoteHash)
        yield* expenses.freeze(complete)
        const pending = yield* expenses.pending
        expect(pending).toHaveLength(3)
        expect(Result.getOrThrow(buildInferenceExpensePlan(pending)).transfers).toHaveLength(2)
        expect(yield* expenses.newSources).toEqual([])
      }),
    ))

  test('stores separate zero-cost quotes for both stages when the original claim expired before dispatch', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const undispatched = Result.getOrThrow(
          makeJevEvaluationReceipt(request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v2',
            requestId: request.requestId,
            startedAt: request.observedAt,
            completedAt: request.expiresAt,
            outcome: { status: JevOutcome.Failed, failure: JevFailure.NotDispatched },
          }),
        )
        yield* (yield* JevEvaluationStore).record(request, undispatched)
        const sql = yield* PgClient.PgClient
        const expenses = makeInferenceExpenseStore(sql, fixture.portfolio.brokerState.account.accountId, '1970-01-01')
        const current = (yield* expenses.newSources).find((value) => value.requestId === request.requestId)
        if (current === undefined) throw new Error('Missing undispatched source')
        const quotes = Result.getOrThrow(makeInferenceExpenseQuotes(current, inferenceExpenseRateCard))
        yield* expenses.freeze(quotes)
        expect(yield* expenses.pending).toHaveLength(2)
        expect(Result.getOrThrow(buildInferenceExpensePlan(quotes)).transfers).toHaveLength(0)
        expect(yield* expenses.newSources).toEqual([])
      }),
    ))

  const nativeLedgerTest = baynTestTigerBeetleAddress === undefined ? test.skip : test
  nativeLedgerTest('posts chart cost and late Jev cost to the real ledger exactly once across recovery', async () =>
    runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const address = baynTestTigerBeetleAddress
          if (address === undefined || !/^127\.0\.0\.1:\d+$/.test(address))
            throw new Error('Staged expense acceptance requires an isolated loopback TigerBeetle cluster')
          const sql = yield* PgClient.PgClient
          const evaluations = yield* JevEvaluationStore
          yield* (yield* EntryInferenceJournal).recordHandoff(completion.handoff)
          yield* evaluations.abandon(request, request.expiresAt)
          const accountId = fixture.portfolio.brokerState.account.accountId
          const expenses = makeInferenceExpenseStore(sql, accountId, '1970-01-01')
          const tariff = {
            ...inferenceExpenseRateCard,
            rates: inferenceExpenseRateCard.rates.map((rate) => ({
              ...rate,
              effectiveFrom: '1970-01-01T00:00:00.000Z',
            })),
          }
          const client = yield* makeTigerBeetleRequestClient({
            operationTimeoutMs: 5_000,
            tigerBeetle: { clusterId: 20912n, replicaAddresses: [address], ledger: 7_001 },
          })
          const partial = yield* runInferenceExpensePass(expenses, client, tariff)
          expect(partial.transferCount).toBe(1)
          expect(partial.gapCount).toBe(1)
          expect((yield* runInferenceExpensePass(expenses, client, tariff)).transferCount).toBe(0)
          yield* evaluations.record(request, receipt)
          const late = yield* runInferenceExpensePass(expenses, client, tariff)
          expect(late.transferCount).toBe(1)
          expect(late.gapCount).toBe(0)
          expect((yield* runInferenceExpensePass(expenses, client, tariff)).transferCount).toBe(0)
          const snapshot = yield* readInferenceExpenseSnapshot(
            sql,
            accountId,
            fixture.draft.identity.executionSessionDate,
          )
          const ledger = yield* readInferenceExpenseLedger(
            client,
            snapshot,
            expenses.currentSession(snapshot.evidence.sessionDate),
          )
          expect(ledger.transferCount).toBe(2)
          expect(BigInt(ledger.knownEstimatedCostPicoUsd)).toBe(
            BigInt(partial.estimatedCostPicoUsd) + BigInt(late.estimatedCostPicoUsd),
          )
          expect((yield* expenses.session(snapshot.evidence.sessionDate)).every((row) => row.verifiedAt !== null)).toBe(
            true,
          )
        }),
      ),
    ),
  )

  test('rejects changed handoff bytes and mutation of committed evidence', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const journal = yield* EntryInferenceJournal
        yield* journal.recordHandoff(completion.handoff)
        expect(
          Result.isFailure(
            yield* journal.recordHandoff({ ...completion.handoff, inputHash: 'f'.repeat(64) }).pipe(Effect.result),
          ),
        ).toBe(true)
        const sql = yield* PgClient.PgClient
        expect(
          Result.isFailure(
            yield* sql`DELETE FROM jev_inference_handoffs WHERE request_id=${request.requestId}`.pipe(Effect.result),
          ),
        ).toBe(true)
        expect(Result.isFailure(yield* sql`TRUNCATE jev_inference_handoffs`.pipe(Effect.result))).toBe(true)
      }),
    ))

  const retainedRequest = (expiresAt: string) =>
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      yield* sql`DROP SCHEMA public CASCADE`
      yield* sql`CREATE SCHEMA public`
      yield* PgMigrator.run({
        loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < 147))),
        table: 'schema_migrations',
      })
      yield* (yield* CycleStore).acquire(fixture.draft, request.observedAt)
      yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
      VALUES (${request.authorityGenerationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${request.observedAt})`
      const { requestId: _, ...original } = request
      const material = {
        ...original,
        schemaVersion: 'bayn.jev-evaluation-request.v1',
        expiresAt,
        request: {
          model: 'jev-1.13.0',
          state: {},
          questions: { relevant: { type: 'noul', instructions: 'Retained historical question' } },
        },
      }
      const payload = { ...material, requestId: Result.getOrThrow(canonicalHashV1Result(material)) }
      yield* sql`INSERT INTO jev_evaluation_requests (request_id,cycle_id,authority_generation_hash,payload)
      VALUES (${payload.requestId},${payload.cycleId},${payload.authorityGenerationHash},${sql.json(payload)})`
      return payload
    })

  test('preserves historical request bytes while rejecting retired executable writes', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const historical = yield* retainedRequest('2000-01-01T00:00:00.000Z')
        const sql = yield* PgClient.PgClient
        const before =
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id=${historical.requestId}`
        yield* sql.withTransaction(sequentialEntryInference)
        expect(
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id=${historical.requestId}`,
        ).toEqual(before)
        const attempted = { ...historical, requestId: 'd'.repeat(64), symbol: 'AMZN' }
        expect(
          Result.isFailure(
            yield* sql`INSERT INTO jev_evaluation_requests (request_id,cycle_id,authority_generation_hash,payload)
      VALUES (${attempted.requestId},${attempted.cycleId},${attempted.authorityGenerationHash},${sql.json(attempted)})`.pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
        expect(
          Result.isFailure(
            yield* sql`INSERT INTO jev_inference_handoffs (request_id,handoff_hash,payload)
      VALUES (${historical.requestId},${completion.handoff.handoffHash},${sql.json({ ...completion.handoff, requestId: historical.requestId })})`.pipe(
              Effect.result,
            ),
          ),
        ).toBe(true)
      }),
    ))

  test('refuses cutover while an original provider claim remains unexpired', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const historical = yield* retainedRequest('9999-12-31T23:59:59.999Z')
        const sql = yield* PgClient.PgClient
        expect(Result.isFailure(yield* sql.withTransaction(sequentialEntryInference).pipe(Effect.result))).toBe(true)
        expect(yield* sql`SELECT to_regclass('public.jev_inference_handoffs')::text AS handoff_table`).toEqual([
          { handoff_table: null },
        ])
        expect(
          yield* sql`SELECT payload FROM jev_evaluation_requests WHERE request_id=${historical.requestId}`,
        ).toEqual([{ payload: historical }])
      }),
    ))

  test('retains original chart requests and rejects new writes with the retired image contract', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* PgMigrator.run({
          loader: migrationLoader.pipe(Effect.map((rows) => rows.filter(([id]) => id < 148))),
          table: 'schema_migrations',
        })
        yield* (yield* CycleStore).acquire(fixture.draft, request.observedAt)
        yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
          VALUES (${request.authorityGenerationHash}, 'bayn.authority-generation-history.v1', 'OBSERVE', 1, ${request.observedAt})`
        const { requestId: _, ...original } = request
        const oldInput = { ...request.request, schemaVersion: 'bayn.entry-inference-input.v1' }
        const oldMaterial = {
          ...original,
          request: oldInput,
          requestHash: Result.getOrThrow(canonicalHashV1Result(oldInput)),
        }
        const historical = { ...oldMaterial, requestId: Result.getOrThrow(canonicalHashV1Result(oldMaterial)) }
        yield* sql`INSERT INTO jev_evaluation_requests (request_id, cycle_id, authority_generation_hash, payload)
          VALUES (${historical.requestId}, ${historical.cycleId}, ${historical.authorityGenerationHash}, ${sql.json(historical)})`
        yield* sql`WITH terminal AS MATERIALIZED (SELECT clock_timestamp() AS at)
          UPDATE autonomous_cycles SET state = 'BLOCKED', terminal_reason = 'BLOCKED_AUTHORITY',
          state_version = state_version + 1, updated_at = terminal.at, terminal_at = terminal.at
          FROM terminal WHERE cycle_id = ${historical.cycleId}`
        const before =
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id = ${historical.requestId}`
        yield* sql.withTransaction(relativeChartVolume)
        expect(
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id = ${historical.requestId}`,
        ).toEqual(before)
        const attempted = { ...historical, requestId: 'd'.repeat(64), symbol: 'AMZN' }
        const rejected =
          yield* sql`INSERT INTO jev_evaluation_requests (request_id, cycle_id, authority_generation_hash, payload)
          VALUES (${attempted.requestId}, ${attempted.cycleId}, ${attempted.authorityGenerationHash}, ${sql.json(attempted)})`.pipe(
            Effect.result,
          )
        if (Result.isSuccess(rejected)) throw new Error('Retired chart input was accepted')
        expect(rejected.failure.reason._tag).toBe('ConstraintError')
        yield* Schema.decodeUnknownEffect(
          Schema.Struct({ code: Schema.Literal('23514'), constraint: Schema.Literal('jev_evaluation_requests_check') }),
        )(rejected.failure.reason.cause)
      }),
    ))

  test('refuses the image contract cutover while a native cycle is active', async () =>
    runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const before =
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id = ${request.requestId}`
        const rejected = yield* sql.withTransaction(relativeChartVolume).pipe(Effect.result)
        if (Result.isSuccess(rejected)) throw new Error('Image contract changed while a native cycle was active')
        const native = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ code: Schema.Literal('55000'), message: Schema.String }),
        )(rejected.failure.reason.cause)
        expect(native.message).toContain('relative-chart-volume cutover requires terminal cycles')
        expect(
          yield* sql`SELECT payload::text FROM jev_evaluation_requests WHERE request_id = ${request.requestId}`,
        ).toEqual(before)
      }),
    ))
})
