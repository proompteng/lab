import { evaluateAdmittedFixture } from '../jev/evaluation.test-support'
import {
  persistVisualClaimFixture,
  persistVisualTransitionFixture,
  persistHandoffFixture,
  persistEvaluationFixture,
} from '../jev/evaluation.test-support'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { makeIntradayCycleDraft } from '../cycle/runner/calendar-decisions'
import { entryAblationStrategyIdentity, makeEntryAblationPolicy } from '../jev/entry-ablation-policy'
import { decideEntryAblation } from '../jev/entry-ablation'
import { makeInferenceCostReport, InferenceStage } from '../inference-costs'
import { inferenceExpenseRateCard } from '../inference-expense'
import { readInferenceExpenseSnapshot } from '../inference-costs-postgres'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { entryCompletionFixture, stagedCheckpointFixture } from '../jev/entry-inference.test-support'
import { EntryInferenceJournalLive, makeEntryInferenceJournal } from './entry-inference-postgres'
import { DecisionsClient } from '../jev/decisions'
import { chartProviderFixture } from '../jev/entry-inference.test-support'
import { jevBatchQuestionSetHash } from '../jev/batch'
import { streamingFixtureFromRaw } from '../testing/streaming-market-fixture'
import { makeJevMarketTestSnapshot } from '../testing/jev-market-fixture'
import { equityMarketProfile } from '../jev/markets'
import { defaultJevProtocolDocument } from '../jev/protocol'
import { JevPurpose } from '../jev/portfolio'
import { exchangeSessions } from '../market-hours'
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { PgClient } from '@effect/sql-pg'
import {
  Clock,
  Deferred,
  Effect,
  Effectable,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  ManagedRuntime,
  Redacted,
  Result,
  Schema,
} from 'effect'
import { TestClock } from 'effect/testing'
import * as Reactivity from 'effect/reactivity/Reactivity'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import type { Statement } from 'effect/sql/Statement'
import type { SqlError } from 'effect/sql/SqlError'

import { CycleStore } from '../cycle/store/model'
import { CycleStoreLive } from '../cycle/store/postgres'
import { operationalError } from '../errors'
import { Authority } from '../execution/contracts'
import {
  JevCandidatePlanStatus,
  JevBatchPlanVersion,
  JevCandidateResultStatus,
  makeJevBatchPlan,
  makeJevBatchResult,
  usableEntryBatchInferences,
} from '../jev/batch'
import { evaluateJevBatch, JevBatchExpired, JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { prepareJevRequest } from '../jev/contract'
import { JevOutcome, makeJevEvaluationReceipt } from '../jev/evidence'
import { JevEvaluationStore } from '../jev/evaluation'
import { JevResolutionStatus, makeJevResolution } from '../jev/resolution'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { tradingSignalInferenceFixture } from '../jev/trading-signal.test-support'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { makeJevObservation } from '../jev/observation'
import { baynTestPostgresUrl } from '../test-environment.test-support'
import { nativeJevFixture } from '../jev/native.test-support'
import { utcInstantFromEpochMillis } from '../time'
import { CandidateObservationStoreLive } from './candidate-observation-postgres'
import { JevBatchStoreLive, makeJevBatchStore } from './jev-batch-postgres'
import { JevEvaluationStoreLive, makeJevEvaluationStore } from './jev-evaluation-postgres'
import { readJevEvaluationEvidence } from './jev-evaluation-read'
import { PostgresClientLive } from './postgres-client'
import { postgresMigrations } from './postgres-migrations'

setDefaultTimeout(30_000)

const testUrl = baynTestPostgresUrl ?? 'postgresql://bayn@127.0.0.1:55436/bayn_jev_test'
const describePostgres = baynTestPostgresUrl === undefined ? describe.skip : describe
const withTestEvaluation = <A extends object>(
  statement: Statement<A>,
  evaluate: () => Effect.Effect<ReadonlyArray<A>, SqlError>,
): Statement<A> => {
  const observed = Effectable.Prototype({ label: 'Observed test statement', evaluate })
  return new Proxy(statement, {
    get(target, property, receiver) {
      return Object.hasOwn(observed, property)
        ? Reflect.get(observed, property, receiver)
        : Reflect.get(target, property, receiver)
    },
  })
}

test('finalizer diagnostics preserve composable SQL fragments and observe only execution', async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* PgClient.make({
          url: Redacted.make('postgres://unused@127.0.0.1:1/unused_test'),
          minConnections: 0,
          stream: () => {
            throw new Error('SQL compilation test must not connect')
          },
        })
        let executions = 0
        const wrapped = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            return withTestEvaluation(statement, () =>
              Effect.sync(() => {
                executions += 1
                return [{ value: 1 }]
              }),
            )
          },
        })
        const scope = wrapped.or([
          wrapped`observation.cycle_id = ${'cycle'} AND observation.observed_at = ${'2026-10-28'}::timestamptz`,
        ])
        const observation = wrapped`SELECT observation.content_hash
          FROM requested JOIN intraday_candidate_observations AS observation ON true WHERE ${scope}`
        const nested = wrapped`SELECT * FROM (${observation}) AS source`
        const baselineScope = sql.or([
          sql`observation.cycle_id = ${'cycle'} AND observation.observed_at = ${'2026-10-28'}::timestamptz`,
        ])
        const baseline = sql`SELECT observation.content_hash
          FROM requested JOIN intraday_candidate_observations AS observation ON true WHERE ${baselineScope}`
        expect(observation.compile()).toEqual(baseline.compile())
        expect(nested.compile()).toEqual(sql`SELECT * FROM (${baseline}) AS source`.compile())
        expect(executions).toBe(0)
        expect(yield* observation).toEqual([{ value: 1 }])
        expect(executions).toBe(1)
      }),
    ).pipe(Effect.provide(Reactivity.layer)),
  )
})
const premiums = Object.fromEntries(equityMarketProfile.candidateSymbols.map((symbol) => [symbol, 0.02]))
const replaySourceHash = 'd'.repeat(64)
const replayAccountId = `replay-${replaySourceHash}`
const fixture = nativeJevFixture(
  JevPurpose.Entry,
  undefined,
  replayAccountId,
  defaultJevProtocolDocument,
  'a'.repeat(64),
  premiums,
)
const foreignFixture = nativeJevFixture(
  JevPurpose.Entry,
  undefined,
  `replay-${'f'.repeat(64)}`,
  defaultJevProtocolDocument,
  'a'.repeat(64),
  premiums,
)
const foreignReconciliation = {
  ...foreignFixture.portfolio.brokerState.reconciliation,
  reconciliationId: 'f'.repeat(64),
}
const foreignSource = Result.getOrThrow(
  makeJevObservation({
    ...foreignFixture.input,
    portfolio: {
      ...foreignFixture.portfolio,
      brokerState: { ...foreignFixture.portfolio.brokerState, reconciliation: foreignReconciliation },
    },
  }),
)
const retainForeignReconciliation = (sql: PgClient.PgClient) => {
  const r = foreignReconciliation
  return Effect.gen(function* () {
    yield* sql`INSERT INTO simulated_execution_clocks (account_id,source_manifest_hash,observed_at)
      VALUES (${r.accountId},${'f'.repeat(64)},${foreignSource.payload.observedAt})`
    yield* sql`INSERT INTO reconciliations (reconciliation_id, schema_version, account_id, expected_hash, observed_hash, content_hash, status, discrepancies, reconciled_at) VALUES (${r.reconciliationId}, ${r.schemaVersion}, ${r.accountId}, ${r.expectedHash}, ${r.observedHash}, ${r.contentHash}, ${r.status}, '[]'::jsonb, ${r.reconciledAt})`
  })
}
const observed = Date.parse(fixture.observation.payload.observedAt)
const databaseClock = Effect.runSync(Clock.clockWith(Effect.succeed))
const plan = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: fixture.observation.payload,
    expiresAt: utcInstantFromEpochMillis(observed + fixture.protocol.inferenceValidityMs),
    planVersion: JevBatchPlanVersion.V8,
  }),
)
const requested = plan.candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested)
const excludedBase = nativeJevFixture(
  JevPurpose.Entry,
  undefined,
  replayAccountId,
  defaultJevProtocolDocument,
  'a'.repeat(64),
  Object.fromEntries(equityMarketProfile.candidateSymbols.map((symbol) => [symbol, -0.02])),
)
const excludedFixture = (() => {
  const raw = makeJevMarketTestSnapshot(excludedBase.protocol, { ...excludedBase.query, archiveWatermarks: [] })
  const { snapshot } = streamingFixtureFromRaw(
    { ...raw, quotes: raw.quotes.map((quote) => ({ ...quote, askPrice: quote.bidPrice * 1.01 })) },
    excludedBase.query,
  )
  return {
    ...excludedBase,
    snapshot,
    observation: Result.getOrThrow(makeJevObservation({ ...excludedBase.input, snapshot })),
  }
})()
const excludedPlan = Result.getOrThrow(
  makeJevTradingSignalBatch({
    observation: excludedFixture.observation.payload,
    expiresAt: plan.expiresAt,
    planVersion: JevBatchPlanVersion.V8,
  }),
)
const first = requested[0]
if (first === undefined) throw new Error('Jev batch fixture requires a candidate')
const successful: typeof JevClient.Service = {
  evaluate: (request) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => tradingSignalInferenceFixture(request, utcInstantFromEpochMillis(now))),
    ),
}
const atObservation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  TestClock.setTime(observed).pipe(Effect.andThen(effect), Effect.provide(TestClock.layer()))
const seedObservationHistory = (sql: PgClient.PgClient) => sql`
  INSERT INTO intraday_candidate_observations (content_hash, cycle_id, observed_at, payload)
  SELECT md5(n::text) || md5('history-' || n::text), ${plan.cycleId}, history.observed_at,
    jsonb_build_object(
      'schemaVersion', 'bayn.jev-observation.v1',
      'cycleId', ${plan.cycleId}::text,
      'authorityGenerationHash', ${plan.authorityGenerationHash}::text,
      'observedAt', to_char(history.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'manifest', jsonb_build_object(
        'observedAt', to_char(history.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'snapshotId', ${plan.snapshotId}::text,
        'candidateSymbols', jsonb_build_array(${first.symbol}::text),
        'candidateExclusions', '[]'::jsonb
      )
    )
  FROM generate_series(1, 4096) AS n
  CROSS JOIN LATERAL (SELECT ${plan.observedAt}::timestamptz - n * INTERVAL '1 minute' AS observed_at) AS history
`
const expectIndexedObservationLookup = (
  sql: PgClient.PgClient,
  statement: Statement<Record<string, unknown>>,
  expectedRows: number,
) =>
  Effect.gen(function* () {
    const [query, parameters] = statement.compile()
    const explanation = yield* sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, parameters)
    const plans = yield* Schema.decodeUnknownEffect(
      Schema.Array(
        Schema.Struct({
          'QUERY PLAN': Schema.Array(Schema.Struct({ Plan: Schema.Record(Schema.String, Schema.Unknown) })),
        }),
      ),
    )(explanation)
    const root = plans[0]?.['QUERY PLAN'][0]?.Plan
    if (root === undefined) throw new Error('PostgreSQL did not return the observation query plan')
    expect(JSON.stringify(root)).toMatch(/"Index Cond":"[^"]*observed_at/)
    expect(root['Actual Rows']).toBe(expectedRows)
    expect(Number(root['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(2)
    const Scan = Schema.Struct({
      'Relation Name': Schema.optionalKey(Schema.String),
      'Actual Loops': Schema.Number,
      Plans: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    })
    const checkSourceScans = (value: unknown): void => {
      const node = Schema.decodeUnknownSync(Scan)(value)
      if (node['Relation Name'] === 'intraday_candidate_observations')
        expect(node['Actual Loops']).toBeLessThanOrEqual(expectedRows)
      for (const child of node.Plans ?? []) checkSourceScans(child)
    }
    checkSourceScans(root)
  })
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

describePostgres('PostgreSQL complete Jev batches', () => {
  let runtime: ReturnType<typeof makeRuntime>
  beforeAll(() => {
    const parsed = new URL(testUrl)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !parsed.pathname.endsWith('_test'))
      throw new Error('Jev batch tests require a local _test database')
    runtime = makeRuntime()
  })
  beforeEach(async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`DROP SCHEMA public CASCADE`
        yield* sql`CREATE SCHEMA public`
        yield* postgresMigrations
        yield* sql`INSERT INTO simulated_execution_clocks (account_id,source_manifest_hash,observed_at)
          VALUES (${replayAccountId},${replaySourceHash},${fixture.snapshot.manifest.observedAt})`
        yield* (yield* CycleStore).acquire(fixture.draft, fixture.snapshot.manifest.observedAt)
        yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
        VALUES (${plan.authorityGenerationHash}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 1, ${plan.observedAt})`
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

  test('ablation commits its own policy, calls only the chart provider, preserves costs and replays without redispatch', async () => {
    let chartCalls = 0
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const parameters = makeEntryAblationPolicy(fixture.protocol)
        const identity = yield* Effect.fromResult(entryAblationStrategyIdentity(parameters))
        const executionPolicy = yield* Effect.fromResult(
          makeCycleExecutionPolicyFromModel(fixture.protocol.executionModel),
        )
        const session = exchangeSessions(fixture.snapshot.manifest.calendar)[0]
        if (session === undefined || executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
          throw new Error('Ablation fixture requires an intraday session')
        const draft = yield* Effect.fromResult(
          makeIntradayCycleDraft(
            {
              cycleBindingId: 'c'.repeat(64),
              strategyName: 'jev',
              strategyProtocolHash: identity.protocolHash,
              accountId: fixture.portfolio.brokerState.account.accountId,
              executionPolicy,
            },
            fixture.snapshot.manifest.calendar,
            session,
          ),
        )
        yield* (yield* CycleStore).acquire(draft, fixture.snapshot.manifest.observedAt)
        const generation = 'd'.repeat(64)
        const r = fixture.portfolio.brokerState.reconciliation
        yield* sql`INSERT INTO authority_generations (
        generation_hash, schema_version, activation_schema_version, previous_generation_hash,
        maximum, authority_version, activation_source_revision, activation_image_repository,
        activation_image_digest, strategy_name, strategy_behavior_hash, strategy_parameter_hash,
        strategy_parameter_schema_version, strategy_protocol_hash, account_id,
        broker_identity_schema_version, broker_identity_hash, broker_provider, broker_environment,
        risk_policy_hash, proof_plan_hash, reconciliation_id, reconciliation_content_hash,
        research_plan_hash, activated_at
      ) VALUES (
        ${generation}, 'bayn.authority-generation-history.v1', 'bayn.paper-authority-generation.v3',
        ${plan.authorityGenerationHash}, 'PAPER', 2, ${'3'.repeat(40)}, 'registry.example.test/lab/bayn',
        ${`sha256:${'4'.repeat(64)}`}, 'jev', ${identity.strategy.behaviorHash}, ${identity.strategy.parameterHash},
        ${identity.strategy.parameterSchemaVersion}, ${identity.protocolHash}, ${r.accountId},
        'bayn.broker-identity.v2', ${'8'.repeat(64)}, 'alpaca', 'sandbox', ${'9'.repeat(64)},
        ${'9'.repeat(64)}, ${r.reconciliationId}, ${r.contentHash}, ${'b'.repeat(64)}, ${plan.observedAt}
      )`
        const observation = yield* Effect.fromResult(
          makeJevObservation({
            ...fixture.input,
            cycleId: draft.identity.cycleId,
            authorityGenerationHash: generation,
          }),
        )
        const input = { observation: observation.payload, expiresAt: plan.expiresAt }
        const candidate = yield* Effect.fromResult(
          makeJevTradingSignalBatch({ ...input, planVersion: JevBatchPlanVersion.V8 }),
        )
        const ablation = yield* Effect.fromResult(
          makeJevTradingSignalBatch({ ...input, planVersion: JevBatchPlanVersion.Ablation }),
        )
        expect(
          Result.isFailure(yield* (yield* JevBatchStore).begin(candidate, observation.payload).pipe(Effect.result)),
        ).toBe(true)
        expect(chartCalls).toBe(0)
        const wrongBatch = yield* sql`INSERT INTO jev_batch_plans
        (batch_id, cycle_id, authority_generation_hash, observation_hash, payload)
        VALUES (${candidate.batchId}, ${candidate.cycleId}, ${candidate.authorityGenerationHash}, ${candidate.observationHash}, ${sql.json(candidate)})`.pipe(
          Effect.result,
        )
        expect(wrongBatch).toMatchObject({
          _tag: 'Failure',
          failure: {
            reason: { cause: { code: '23514', where: expect.stringContaining('enforce_entry_policy_identity()') } },
          },
        })
        const unbatched = ablation.candidates.find((row) => row.status === JevCandidatePlanStatus.Requested)
        if (unbatched?.status !== JevCandidatePlanStatus.Requested) throw new Error('Ablation fixture needs a request')
        const wrongRequest = yield* sql`INSERT INTO jev_evaluation_requests
        (request_id, cycle_id, authority_generation_hash, payload)
        VALUES (${unbatched.request.requestId}, ${ablation.cycleId}, ${ablation.authorityGenerationHash}, ${sql.json(unbatched.request)})`.pipe(
          Effect.result,
        )
        expect(wrongRequest).toMatchObject({
          _tag: 'Failure',
          failure: {
            reason: { cause: { code: '23514', where: expect.stringContaining('enforce_entry_policy_identity()') } },
          },
        })
        const stored = yield* evaluateJevBatch(ablation, observation.payload)
        if (stored.result === null) throw new Error('Ablation batch did not finalize')
        const inferences = yield* Effect.fromResult(
          usableEntryBatchInferences(ablation, stored.result, observed, JevBatchPlanVersion.Ablation),
        )
        expect(inferences.length).toBeGreaterThan(0)
        expect(inferences.every(({ inference }) => inference.jev.status === 'OMITTED_BY_POLICY')).toBe(true)
        expect(chartCalls).toBe(inferences.length * 2)
        const target = yield* Effect.fromResult(
          decideEntryAblation({
            observation: observation.payload,
            batchPlan: stored.plan,
            batchResult: stored.result,
            decidedAt: plan.observedAt,
          }),
        )
        expect(target.selectedSymbols).toHaveLength(1)
        expect(target.policy).toEqual(parameters)
        expect(yield* evaluateJevBatch(ablation, observation.payload)).toEqual(stored)
        expect(chartCalls).toBe(inferences.length * 2)
        const snapshot = yield* readInferenceExpenseSnapshot(sql, r.accountId, fixture.snapshot.manifest.sessionDate)
        const costs = yield* Effect.fromResult(
          makeInferenceCostReport(snapshot.evidence, {
            ...inferenceExpenseRateCard,
            rates: inferenceExpenseRateCard.rates.map((rate) => ({
              ...rate,
              effectiveFrom: '1970-01-01T00:00:00.000Z',
              effectiveUntil: '2100-01-01T00:00:00.000Z',
            })),
          }),
        )
        expect(costs.requestCount).toBe(inferences.length)
        expect(costs.meteredRequestCount).toBe(chartCalls)
        expect(
          costs.requests
            .filter((line) => 'stage' in line && [InferenceStage.Chart, InferenceStage.BaseStart].includes(line.stage))
            .every((line) => BigInt(line.estimatedCostPicoUsd ?? '0') > 0n),
        ).toBe(true)
        expect(
          costs.requests
            .filter((line) => 'stage' in line && line.stage === InferenceStage.Jev)
            .every((line) => line.estimatedCostPicoUsd === '0'),
        ).toBe(true)
      }).pipe(
        atObservation,
        Effect.provideService(JevClient, { evaluate: () => Effect.die('Ablation cannot call Jev') }),
        Effect.provideService(DecisionsClient, {
          evaluate: (...args) =>
            Effect.sync(() => {
              chartCalls++
            }).pipe(Effect.andThen(chartProviderFixture.evaluate(...args))),
        }),
      ),
    )
  })

  test('database receipt admission rejects a candidate that claims the ablation provider omission', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const admitted = yield* (yield* JevBatchStore).begin(plan, fixture.observation.payload)
        const dispatch = admitted.dispatches[0]
        if (dispatch === undefined) throw new Error('Fixture requires a committed request')
        const completion = entryCompletionFixture(dispatch.request)
        const journal = yield* EntryInferenceJournal
        const checkpoint = stagedCheckpointFixture(dispatch.request)
        for (const claim of checkpoint.claims) {
          yield* persistVisualClaimFixture(journal, claim)
          const terminal = checkpoint.terminals.find((row) => row.stage === claim.stage)
          if (terminal !== undefined)
            yield* persistVisualTransitionFixture(journal, { terminal: terminal, successor: { kind: 'NONE' } })
        }

        yield* persistHandoffFixture(journal, completion.handoff)
        const receipt = {
          schemaVersion: 'bayn.jev-evaluation-receipt.v3',
          requestId: dispatch.request.requestId,
          receiptHash: 'f'.repeat(64),
          startedAt: dispatch.request.observedAt,
          completedAt: completion.completedAt,
          outcome: { status: 'COMPLETED', completion: { ...completion, jev: { status: 'OMITTED_BY_POLICY' } } },
        }
        const inserted = yield* sql`INSERT INTO jev_evaluation_receipts (request_id, receipt_hash, payload)
        VALUES (${receipt.requestId}, ${receipt.receiptHash}, ${sql.json(receipt)})`.pipe(Effect.result)
        expect(inserted).toMatchObject({
          _tag: 'Failure',
          failure: {
            reason: { cause: { code: '23514', where: expect.stringContaining('enforce_entry_completion_policy()') } },
          },
        })
        expect(
          yield* sql`SELECT request_id FROM jev_evaluation_receipts WHERE request_id=${receipt.requestId}`,
        ).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('admits the observation and plan together without a prior observation commit', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER USER`
        yield* sql`DELETE FROM intraday_candidate_observations WHERE content_hash=${plan.observationHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER USER`
        const admitted = yield* (yield* JevBatchStore).begin(plan, fixture.observation.payload)
        expect(admitted).toMatchObject({ plan, result: null })
        expect(admitted.dispatches.map(({ request }) => request.requestId)).toEqual(
          requested.map(({ request }) => request.requestId),
        )
        const rows = yield* sql`SELECT observation.content_hash, batch.batch_id
          FROM intraday_candidate_observations observation JOIN jev_batch_plans batch
            ON batch.observation_hash=observation.content_hash WHERE batch.batch_id=${plan.batchId}`
        expect(rows).toEqual([{ content_hash: plan.observationHash, batch_id: plan.batchId }])
      }).pipe(atObservation),
    )
  })

  test('rolls back a new observation when its batch cannot be admitted', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER USER`
        yield* sql`DELETE FROM intraday_candidate_observations WHERE content_hash=${plan.observationHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER USER`
        yield* sql`CREATE FUNCTION reject_batch_admission() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected batch admission failure'; END $$`
        yield* sql`CREATE TRIGGER reject_batch_admission BEFORE INSERT ON jev_batch_plans
          FOR EACH ROW EXECUTE FUNCTION reject_batch_admission()`
        const result = yield* (yield* JevBatchStore).begin(plan, fixture.observation.payload).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        expect(yield* sql`SELECT content_hash FROM intraday_candidate_observations`).toEqual([])
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('expiry during transactional observation work rolls back admission before inference', async () => {
    let providerCalls = 0
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER USER`
        yield* sql`DELETE FROM intraday_candidate_observations WHERE content_hash=${plan.observationHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER USER`
        const expiring = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            return statement.compile()[0].includes('INSERT INTO intraday_candidate_observations')
              ? statement.pipe(Effect.tap(() => TestClock.setTime(Date.parse(plan.expiresAt))))
              : statement
          },
        })
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, expiring))
        yield* TestClock.setTime(Date.parse(plan.expiresAt) - 1)
        const rejected = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, batches),
          Effect.result,
        )
        expect(Result.isFailure(rejected)).toBe(true)
        if (Result.isFailure(rejected))
          expect(rejected.failure).toMatchObject({ _tag: 'JevBatchExpired', checkedAt: plan.expiresAt })
        expect(yield* sql`SELECT content_hash FROM intraday_candidate_observations`).toEqual([])
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
      }).pipe(
        atObservation,
        Effect.provideService(JevClient, {
          evaluate: () =>
            Effect.sync(() => {
              providerCalls += 1
            }).pipe(Effect.andThen(Effect.die('Expired admission must not call the provider'))),
        }),
      ),
    )
    expect(providerCalls).toBe(0)
  })

  test('candidate claim failure rolls back its new observation and plan together', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER USER`
        yield* sql`DELETE FROM intraday_candidate_observations WHERE content_hash=${plan.observationHash}`
        yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER USER`
        yield* sql`ALTER TABLE jev_evaluation_requests ADD CONSTRAINT reject_candidate_claim CHECK (false)`
        expect(
          Result.isFailure(yield* (yield* JevBatchStore).begin(plan, fixture.observation.payload).pipe(Effect.result)),
        ).toBe(true)
        expect(yield* sql`SELECT content_hash FROM intraday_candidate_observations`).toEqual([])
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
      }).pipe(
        atObservation,
        Effect.provideService(JevClient, { evaluate: () => Effect.die('Uncommitted claims cannot dispatch') }),
      ),
    )
  })

  test('admission commit crossing expiry abandons every claim without provider I/O or a fabricated receipt', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const delayed = new Proxy(sql, {
          get(target, property, receiver) {
            if (property === 'withTransaction')
              return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                target.withTransaction(effect).pipe(Effect.tap(() => TestClock.setTime(Date.parse(plan.expiresAt))))
            return Reflect.get(target, property, receiver)
          },
        })
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, delayed))
        const saved = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, batches),
        )
        expect(
          saved.result?.candidates.filter(
            (candidate) =>
              candidate.status === JevCandidateResultStatus.Resolved &&
              candidate.receipt === null &&
              candidate.resolution.status === JevResolutionStatus.Abandoned,
          ),
        ).toHaveLength(requested.length)
        if (saved.result === null) throw new Error('Expired claims were not finalized')
        expect(
          Result.isFailure(
            usableEntryBatchInferences(plan, saved.result, Date.parse(plan.expiresAt), JevBatchPlanVersion.V8),
          ),
        ).toBe(true)
      }).pipe(
        atObservation,
        Effect.provideService(JevClient, { evaluate: () => Effect.die('Late admission cannot dispatch') }),
      ),
    )
  })

  test('candidate batch admission commits every initial CHART claim with its request', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const admitted = yield* (yield* JevBatchStore).begin(plan, fixture.observation.payload)
        const claims = admitted.dispatches.filter((dispatch) => dispatch.visualClaim !== null)
        expect(claims.length).toBeGreaterThan(1)
        const [proof] = yield* sql`
        SELECT count(*)::integer AS claims, count(DISTINCT claim.xmin::text)::integer AS transactions,
          bool_and(claim.xmin = request.xmin AND request.xmin = batch.xmin) AS shares_admission
        FROM jev_staged_dispatch_claims claim JOIN jev_evaluation_requests request USING(request_id)
        JOIN jev_batch_plans batch ON batch.cycle_id=request.cycle_id
          AND batch.authority_generation_hash=request.authority_generation_hash
        WHERE batch.batch_id=${plan.batchId} AND claim.stage='CHART'`
        expect(proof).toEqual({ claims: claims.length, transactions: 1, shares_admission: true })
      }).pipe(atObservation),
    )
  })

  test('the full candidate universe survives two-second durable commits without extending its deadline', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        let commits = 0
        const delayed = new Proxy(sql, {
          get(target, property, receiver) {
            if (property === 'withTransaction')
              return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                target
                  .withTransaction(
                    Effect.gen(function* () {
                      const now = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
                      yield* target`UPDATE simulated_execution_clocks SET observed_at=${now} WHERE account_id=${replayAccountId}`
                      return yield* effect
                    }),
                  )
                  .pipe(
                    Effect.tap(() =>
                      Effect.gen(function* () {
                        commits++
                        yield* TestClock.setTime((yield* Clock.currentTimeMillis) + 2000)
                      }),
                    ),
                  )
            return Reflect.get(target, property, receiver)
          },
        })
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, delayed))
        const journal = yield* makeEntryInferenceJournal.pipe(Effect.provideService(PgClient.PgClient, delayed))
        const evaluations = yield* makeJevEvaluationStore.pipe(Effect.provideService(PgClient.PgClient, delayed))
        expect(requested).toHaveLength(equityMarketProfile.candidateSymbols.length)
        const saved = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, batches),
          Effect.provideService(EntryInferenceJournal, journal),
          Effect.provideService(JevEvaluationStore, evaluations),
        )
        if (saved.result === null) throw new Error('The full-universe batch did not complete')
        expect(commits).toBeLessThanOrEqual(4)
        expect(commits).toBeGreaterThanOrEqual(3)
        expect(yield* Clock.currentTimeMillis).toBe(observed + commits * 2000)
        expect(
          Result.getOrThrow(
            usableEntryBatchInferences(plan, saved.result, yield* Clock.currentTimeMillis, JevBatchPlanVersion.V8),
          ),
        ).toHaveLength(requested.length)
        expect(plan.expiresAt).toBe(utcInstantFromEpochMillis(observed + 10000))
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })

  test('persists the complete plan before any request and replays a completed batch without reinference', async () => {
    let calls = 0
    await runtime.runPromise(
      Effect.gen(function* () {
        expect(yield* (yield* JevBatchStore).read(plan.batchId)).toBeNull()
        const stored = yield* evaluateJevBatch(plan, fixture.observation.payload)
        expect(stored.plan).toEqual(plan)
        expect(stored.result).not.toBeNull()
        if (stored.result === null) throw new Error('Batch did not finalize')
        expect(stored.result.candidates).toHaveLength(plan.candidates.length)
        const sql = yield* PgClient.PgClient
        const [proof] = yield* sql`
          SELECT count(*)::integer AS receipts,
            bool_and(receipt.xmin = resolution.xmin AND resolution.xmin = result.xmin) AS shares_completion
          FROM jev_evaluation_receipts receipt JOIN jev_evaluation_resolutions resolution USING(request_id)
          JOIN jev_evaluation_requests request USING(request_id)
          JOIN jev_batch_results result ON result.batch_id=${plan.batchId}
          WHERE request.cycle_id=${plan.cycleId}`
        expect(proof).toEqual({ receipts: requested.length, shares_completion: true })
        expect(
          Result.getOrThrow(usableEntryBatchInferences(plan, stored.result, observed, JevBatchPlanVersion.V8)),
        ).toHaveLength(requested.length)
        expect(yield* evaluateJevBatch(plan, fixture.observation.payload)).toEqual(stored)
        expect(calls).toBe(requested.length)
        expect(yield* (yield* JevBatchStore).read(plan.batchId)).toEqual(stored)
      }).pipe(
        Effect.provideService(JevClient, {
          evaluate: (request, budgetMs) =>
            Effect.sync(() => {
              calls += 1
            }).pipe(Effect.andThen(successful.evaluate(request, budgetMs))),
        }),
        atObservation,
      ),
    )
  })

  test('receipt locking uses the indexed cohort before expanding retained candidate history', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        let lookup: Statement<Record<string, unknown>> | undefined
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            if (statement.compile()[0].includes('SELECT plan.batch_id FROM jev_batch_plans plan')) lookup = statement
            return statement
          },
        })
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, monitored))
        yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(Effect.provideService(JevBatchStore, batches))
        if (lookup === undefined) throw new Error('Completion did not lock the admitted cohort')
        const [query, parameters] = lookup.compile()
        yield* sql.withTransaction(
          Effect.gen(function* () {
            // Isolate query scaling from immutable source admission and its full market-data payloads.
            yield* sql`CREATE TEMP TABLE jev_batch_plans (
          batch_id text PRIMARY KEY,cycle_id text NOT NULL,authority_generation_hash text NOT NULL,
          snapshot_id text NOT NULL,payload jsonb NOT NULL
        ) ON COMMIT DROP`
            yield* sql`INSERT INTO pg_temp.jev_batch_plans
          SELECT md5(n::text)||md5('batch-'||n::text),${plan.cycleId},${plan.authorityGenerationHash},
            md5('snapshot-'||n::text)||md5(n::text),
            jsonb_build_object('candidates',jsonb_build_array(jsonb_build_object('request',
              jsonb_build_object('requestId','historical-unrelated-request'))))
          FROM generate_series(1,10000) n`
            yield* sql`INSERT INTO pg_temp.jev_batch_plans
          SELECT batch_id,cycle_id,authority_generation_hash,snapshot_id,payload
          FROM public.jev_batch_plans WHERE batch_id=${plan.batchId}`
            yield* sql`CREATE UNIQUE INDEX cohort_scope_lookup ON pg_temp.jev_batch_plans
          (cycle_id,authority_generation_hash,snapshot_id)`
            yield* sql`ANALYZE pg_temp.jev_batch_plans`
            const explained = yield* sql.unsafe(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`, parameters)
            const rows = yield* Schema.decodeUnknownEffect(
              Schema.Array(
                Schema.Struct({
                  'QUERY PLAN': Schema.Array(Schema.Struct({ Plan: Schema.Record(Schema.String, Schema.Unknown) })),
                }),
              ),
            )(explained)
            const root = rows[0]?.['QUERY PLAN'][0]?.Plan
            if (root === undefined) throw new Error('Missing receipt-lock query plan')
            expect(root['Actual Rows']).toBe(1)
            expect(JSON.stringify(root)).toMatch(/"Index Cond":"[^"]*snapshot_id/)
            const scan = Schema.Struct({
              'Node Type': Schema.String,
              'Actual Loops': Schema.Number,
              Plans: Schema.optionalKey(Schema.Array(Schema.Unknown)),
            })
            const check = (value: unknown): void => {
              const node = Schema.decodeUnknownSync(scan)(value)
              if (node['Node Type'] === 'Function Scan') expect(node['Actual Loops']).toBe(1)
              for (const child of node.Plans ?? []) check(child)
            }
            check(root)
          }),
        )
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })

  test('all-excluded admission commits a complete batch before returning and replays without finalization', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        expect(excludedPlan.candidates.length).toBeGreaterThan(0)
        expect(excludedPlan.candidates.every((candidate) => candidate.status === JevCandidatePlanStatus.Excluded)).toBe(
          true,
        )
        const saved = yield* batches
          .begin(excludedPlan, excludedFixture.observation.payload)
          .pipe(Effect.map(({ plan, result }) => ({ plan, result })))
        expect(saved.result).not.toBeNull()
        expect(saved.result?.completedAt).toBe(excludedPlan.observedAt)
        expect(saved.result?.candidates).toEqual(
          excludedPlan.candidates.map(({ symbol }) => ({ symbol, status: JevCandidateResultStatus.Excluded })),
        )
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([{ batch_id: excludedPlan.batchId }])
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([{ batch_id: excludedPlan.batchId }])
        const transactions = yield* sql`
          SELECT plan.xmin::text AS plan_transaction, result.xmin::text AS result_transaction
          FROM jev_batch_plans AS plan JOIN jev_batch_results AS result USING (batch_id)
          WHERE plan.batch_id = ${excludedPlan.batchId}
        `
        expect(transactions).toHaveLength(1)
        expect(transactions[0]?.['plan_transaction']).toBe(transactions[0]?.['result_transaction'])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
        expect(yield* batches.pending(excludedPlan.cycleId)).toEqual([])
        yield* TestClock.adjust('1 minute')
        expect(yield* batches.begin(excludedPlan, excludedFixture.observation.payload)).toMatchObject({
          plan: saved.plan,
          result: saved.result,
          dispatches: [],
        })
        expect(
          yield* evaluateJevBatch(excludedPlan, excludedFixture.observation.payload).pipe(
            Effect.provideService(JevBatchStore, {
              ...batches,
              finish: () => Effect.die('A complete admission must not open another finalization'),
            }),
          ),
        ).toEqual(saved)
      }).pipe(
        Effect.provideService(JevClient, { evaluate: () => Effect.die('Excluded candidates must not call inference') }),
        atObservation,
      ),
    )
  })

  test('all-excluded result failure rolls back its new plan and permits an atomic retry', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        // Only the disposable local _test database is modified by this fault injection.
        yield* sql`CREATE FUNCTION fail_excluded_batch_result() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'injected excluded batch result failure'; END
        $$`
        yield* sql`CREATE TRIGGER fail_excluded_batch_result BEFORE INSERT ON jev_batch_results
          FOR EACH ROW EXECUTE FUNCTION fail_excluded_batch_result()`
        const failed = yield* batches.begin(excludedPlan, excludedFixture.observation.payload).pipe(Effect.result)
        expect(Result.isFailure(failed)).toBe(true)
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
        expect(
          yield* sql`SELECT content_hash FROM intraday_candidate_observations
            WHERE content_hash = ${excludedPlan.observationHash}`,
        ).toEqual([{ content_hash: excludedPlan.observationHash }])
        yield* sql`DROP TRIGGER fail_excluded_batch_result ON jev_batch_results`
        const saved = yield* batches
          .begin(excludedPlan, excludedFixture.observation.payload)
          .pipe(Effect.map(({ plan, result }) => ({ plan, result })))
        expect(saved.result).not.toBeNull()
        expect(yield* batches.read(excludedPlan.batchId)).toEqual(saved)
        expect(yield* batches.pending(excludedPlan.cycleId)).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('all-excluded concurrent admission preserves one immutable result', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        const saved = yield* Effect.all(
          Array.from({ length: 8 }, () => batches.begin(excludedPlan, excludedFixture.observation.payload)),
          { concurrency: 8 },
        )
        const firstSaved = saved[0]
        if (firstSaved === undefined) throw new Error('Concurrent admission did not return a batch')
        expect(firstSaved.result).not.toBeNull()
        for (const admitted of saved) expect(admitted).toEqual(firstSaved)
        yield* TestClock.adjust('1 minute')
        expect(yield* batches.begin(excludedPlan, excludedFixture.observation.payload)).toEqual(firstSaved)
        expect(yield* Effect.flatMap(JevBatchStore, (store) => store.finish(excludedPlan.batchId))).toEqual({
          plan: firstSaved.plan,
          result: firstSaved.result,
        })
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([{ batch_id: excludedPlan.batchId }])
      }).pipe(atObservation),
    )
  })

  test('a changed deadline cannot replace the admitted batch or its result', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        const saved = yield* batches
          .begin(excludedPlan, excludedFixture.observation.payload)
          .pipe(Effect.map(({ plan, result }) => ({ plan, result })))
        const { batchId: _batchId, ...material } = excludedPlan
        const conflicting = Result.getOrThrow(
          makeJevBatchPlan({
            ...material,
            expiresAt: utcInstantFromEpochMillis(Date.parse(excludedPlan.expiresAt) - 1),
          }),
        )
        expect(conflicting.batchId).not.toBe(excludedPlan.batchId)
        const rejected = yield* batches.begin(conflicting, excludedFixture.observation.payload).pipe(Effect.result)
        expect(Result.isFailure(rejected)).toBe(true)
        if (Result.isFailure(rejected))
          expect(rejected.failure.message).toContain('source-controlled validity interval')
        expect(yield* batches.read(conflicting.batchId)).toBeNull()
        expect(yield* batches.read(excludedPlan.batchId)).toEqual(saved)
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([{ batch_id: excludedPlan.batchId }])
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([{ batch_id: excludedPlan.batchId }])
      }).pipe(atObservation),
    )
  })

  test('all-excluded lost admission acknowledgement recovers the complete commit after expiry', async () => {
    await runtime.runPromise(
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
            yield* batches
              .begin(excludedPlan, excludedFixture.observation.payload)
              .pipe(Effect.andThen(Effect.fail(lostAcknowledgement)), Effect.result),
          ),
        ).toBe(true)
        const saved = yield* batches.read(excludedPlan.batchId)
        if (saved === null || saved.result === null)
          throw new Error('Lost acknowledgement did not retain a complete batch')
        yield* TestClock.adjust('1 minute')
        expect(yield* batches.begin(excludedPlan, excludedFixture.observation.payload)).toMatchObject({
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
    await runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        yield* sql`INSERT INTO jev_batch_plans (batch_id, cycle_id, authority_generation_hash, observation_hash, payload)
          VALUES (${excludedPlan.batchId}, ${excludedPlan.cycleId}, ${excludedPlan.authorityGenerationHash},
            ${excludedPlan.observationHash}, ${sql.json(excludedPlan)})`
        yield* TestClock.adjust('1 minute')
        expect(yield* batches.begin(excludedPlan, excludedFixture.observation.payload)).toMatchObject({
          plan: excludedPlan,
          result: null,
        })
        expect(yield* batches.pending(excludedPlan.cycleId)).toEqual([excludedPlan.batchId])
        const saved = yield* Effect.flatMap(JevBatchStore, (store) => store.finish(excludedPlan.batchId))
        expect(saved.result).not.toBeNull()
        expect(
          saved.result?.candidates.every((candidate) => candidate.status === JevCandidateResultStatus.Excluded),
        ).toBe(true)
        expect(yield* batches.begin(excludedPlan, excludedFixture.observation.payload)).toMatchObject({
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
    await runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        for (const now of [observed - 1, Date.parse(excludedPlan.expiresAt)]) {
          yield* TestClock.setTime(now)
          const failed = yield* batches.begin(excludedPlan, excludedFixture.observation.payload).pipe(Effect.result)
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

  test('keeps queued I/O serviceable while reproducing a complete candidate cohort', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const admission = yield* batches.begin(plan, fixture.observation.payload)
        yield* Effect.forEach(admission.dispatches, evaluateAdmittedFixture, { concurrency: 'unbounded' })
        const sql = yield* PgClient.PgClient
        // Queue a real event-loop turn after SQL replies. TestClock cannot model a socket
        // response being starved by synchronous source reproduction.
        let heartbeat: ReturnType<typeof setImmediate> | undefined
        let serviced = false
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            if (!statement.compile()[0].includes('matched.matching_request_ids')) return statement
            return withTestEvaluation(statement, () =>
              statement.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    heartbeat = setImmediate(() => {
                      serviced = true
                    })
                  }),
                ),
              ),
            )
          },
        })
        const { evidence } = yield* readJevEvaluationEvidence(
          monitored,
          requested.map((candidate) => candidate.request.requestId),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (heartbeat !== undefined) clearImmediate(heartbeat)
            }),
          ),
        )
        expect(evidence.size).toBe(requested.length)
        expect(heartbeat).toBeDefined()
        expect(serviced).toBe(true)
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })

  test('reads complete candidate evidence in three queries and transfers its shared observation once', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const stored = yield* evaluateJevBatch(plan, fixture.observation.payload)
        const sql = yield* PgClient.PgClient
        yield* seedObservationHistory(sql)
        yield* sql`ANALYZE intraday_candidate_observations`
        const queries: string[] = []
        const observations: unknown[] = []
        let lookup: Statement<Record<string, unknown>> | undefined
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            const [query] = statement.compile()
            if (query.includes('AS matching_request_ids')) lookup = statement
            // Preserve composable predicate fragments; only complete reads execute.
            if (!/^(SELECT|WITH)\b/.test(query.trimStart())) return statement
            return statement.pipe(
              Effect.tap((rows) =>
                Effect.sync(() => {
                  queries.push(query)
                  if (query.includes('intraday_candidate_observations')) observations.push(...rows)
                }),
              ),
            )
          },
        })
        const evaluations = yield* makeJevEvaluationStore.pipe(Effect.provideService(PgClient.PgClient, monitored))
        const batches = yield* makeJevBatchStore.pipe(
          Effect.provideService(PgClient.PgClient, monitored),
          Effect.provideService(JevEvaluationStore, evaluations),
        )
        expect(requested.length).toBeGreaterThan(1)
        expect(yield* batches.read(plan.batchId)).toEqual(stored)
        expect(queries).toHaveLength(3)
        expect(observations).toHaveLength(1)
        if (lookup === undefined) throw new Error('Complete read did not verify its source')
        yield* expectIndexedObservationLookup(sql, lookup, 1)
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })

  for (const table of [
    'jev_evaluation_requests',
    'jev_evaluation_receipts',
    'jev_inference_handoffs',
    'jev_evaluation_resolutions',
    'intraday_candidate_observations',
  ]) {
    test(`complete reads reject tampered independently committed ${table}`, async () => {
      await runtime.runPromise(
        Effect.gen(function* () {
          const stored = yield* evaluateJevBatch(plan, fixture.observation.payload)
          const batches = yield* JevBatchStore
          const sql = yield* PgClient.PgClient
          expect(yield* batches.read(plan.batchId)).toEqual(stored)
          const isObservation = table === 'intraday_candidate_observations'
          const key = isObservation ? 'content_hash' : 'request_id'
          const identity = isObservation ? fixture.observation.contentHash : first.request.requestId
          // The fixture owns a local _test database. Bypass its immutable trigger
          // only to verify the read boundary independently rejects corrupted bytes.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`ALTER TABLE ${sql(table)} DISABLE TRIGGER ${sql(table + '_immutable')}`
              yield* sql`UPDATE ${sql(table)} SET payload = payload || '{"unexpected":true}'::jsonb
                WHERE ${sql(key)} = ${identity}`
              yield* sql`ALTER TABLE ${sql(table)} ENABLE TRIGGER ${sql(table + '_immutable')}`
            }),
          )
          expect(Result.isFailure(yield* batches.read(plan.batchId).pipe(Effect.result))).toBe(true)
        }).pipe(Effect.provideService(JevClient, successful), atObservation),
      )
    })
  }

  test('complete reads require each request source from its exact cycle even when another account shares its snapshot', async () => {
    const session = exchangeSessions(fixture.snapshot.manifest.calendar)[0]
    if (session === undefined) throw new Error('Missing fixture session')
    const executionPolicy = fixture.draft.identity.executionPolicy
    if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
      throw new Error('Fixture requires its original intraday policy')
    const foreignDraft = foreignFixture.draft
    const foreignObservation = foreignSource
    const foreignPlan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: foreignObservation.payload,
        expiresAt: plan.expiresAt,
        planVersion: JevBatchPlanVersion.V8,
      }),
    )
    const foreignFirst = foreignPlan.candidates.find(
      (candidate) => candidate.status === JevCandidatePlanStatus.Requested,
    )
    if (foreignFirst?.status !== JevCandidatePlanStatus.Requested) throw new Error('Missing foreign candidate')
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const batches = yield* JevBatchStore
        yield* (yield* CycleStore).acquire(foreignDraft, fixture.snapshot.manifest.observedAt)
        yield* retainForeignReconciliation(sql)
        yield* (yield* CandidateObservationStore).record(foreignObservation)
        const stored = yield* evaluateJevBatch(plan, fixture.observation.payload)
        const foreign = yield* evaluateJevBatch(foreignPlan, foreignObservation.payload)
        yield* seedObservationHistory(sql)
        yield* sql`ANALYZE intraday_candidate_observations`
        let lookup: Statement<Record<string, unknown>> | undefined
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            if (statement.compile()[0].includes('AS matching_request_ids')) lookup = statement
            return statement
          },
        })
        const { evidence, observationHashes } = yield* readJevEvaluationEvidence(monitored, [
          first.request.requestId,
          foreignFirst.request.requestId,
        ])
        expect(evidence.size).toBe(2)
        expect(evidence.get(first.request.requestId)?.request).toEqual(first.request)
        expect(evidence.get(foreignFirst.request.requestId)?.request).toEqual(foreignFirst.request)
        expect(observationHashes.toSorted()).toEqual(
          [fixture.observation.contentHash, foreignObservation.contentHash].toSorted(),
        )
        if (lookup === undefined) throw new Error('Combined read did not verify candidate observations')
        yield* expectIndexedObservationLookup(sql, lookup, 2)
        expect(yield* batches.read(plan.batchId)).toEqual(stored)
        expect(yield* batches.read(foreignPlan.batchId)).toEqual(foreign)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`ALTER TABLE intraday_candidate_observations DISABLE TRIGGER intraday_candidate_observations_immutable`
            yield* sql`UPDATE intraday_candidate_observations
              SET payload = jsonb_set(payload, '{authorityGenerationHash}', to_jsonb(${'c'.repeat(64)}::text))
              WHERE content_hash = ${fixture.observation.contentHash}`
            yield* sql`ALTER TABLE intraday_candidate_observations ENABLE TRIGGER intraday_candidate_observations_immutable`
          }),
        )
        expect(Result.isFailure(yield* batches.read(plan.batchId).pipe(Effect.result))).toBe(true)
        expect(yield* batches.read(foreignPlan.batchId)).toEqual(foreign)
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })

  test('complete reads reject a request claim for a sealed unattempted candidate', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* sql`INSERT INTO jev_batch_plans (batch_id, cycle_id, authority_generation_hash, observation_hash, payload)
          VALUES (${plan.batchId}, ${plan.cycleId}, ${plan.authorityGenerationHash}, ${plan.observationHash}, ${sql.json(plan)})`
        yield* TestClock.adjust('10 seconds')
        const stored = yield* batches.finish(plan.batchId)
        expect(
          stored.result?.candidates.filter((candidate) => candidate.status === JevCandidateResultStatus.Unattempted),
        ).toHaveLength(requested.length)
        expect(yield* batches.read(plan.batchId)).toEqual(stored)
        yield* sql`INSERT INTO jev_evaluation_requests (request_id, cycle_id, authority_generation_hash, payload)
          VALUES (${first.request.requestId}, ${first.request.cycleId},
            ${first.request.authorityGenerationHash}, ${sql.json(first.request)})`
        expect(Result.isFailure(yield* batches.read(plan.batchId).pipe(Effect.result))).toBe(true)
      }).pipe(atObservation),
    )
  })

  test('generation-wide pending lookup remains exact-cycle scoped and cannot seal another account', async () => {
    const generation = 'c'.repeat(64)
    const nextObservation = Result.getOrThrow(
      makeJevObservation({ ...fixture.input, authorityGenerationHash: generation }),
    )
    const session = exchangeSessions(fixture.snapshot.manifest.calendar)[0]
    if (session === undefined) throw new Error('Missing fixture session')
    const executionPolicy = fixture.draft.identity.executionPolicy
    if (executionPolicy.schemaVersion !== 'bayn.autonomous-cycle-execution-policy.v3')
      throw new Error('Fixture requires its original intraday policy')
    const foreignDraft = foreignFixture.draft
    const foreignObservation = foreignSource
    const nextPlan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: nextObservation.payload,
        expiresAt: plan.expiresAt,
        planVersion: JevBatchPlanVersion.V8,
      }),
    )
    const foreignPlan = Result.getOrThrow(
      makeJevTradingSignalBatch({
        observation: foreignObservation.payload,
        expiresAt: plan.expiresAt,
        planVersion: JevBatchPlanVersion.V8,
      }),
    )
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const batches = yield* JevBatchStore
        const observations = yield* CandidateObservationStore
        yield* sql`INSERT INTO authority_generations (generation_hash, schema_version, maximum, authority_version, activated_at)
        VALUES (${generation}, 'bayn.authority-generation-history.v1', ${Authority.Observe}, 2, ${plan.observedAt})`
        yield* (yield* CycleStore).acquire(foreignDraft, fixture.snapshot.manifest.observedAt)
        yield* retainForeignReconciliation(sql)
        yield* observations.record(nextObservation)
        yield* observations.record(foreignObservation)
        for (const [candidate, observation] of [
          [plan, fixture.observation],
          [nextPlan, nextObservation],
          [foreignPlan, foreignObservation],
        ] as const)
          yield* batches.begin(candidate, observation.payload)
        expect(yield* batches.pending(plan.cycleId, plan.authorityGenerationHash)).toEqual([plan.batchId])
        expect(yield* batches.pending(plan.cycleId)).toEqual([plan.batchId, nextPlan.batchId].sort())
        yield* TestClock.adjust('10 seconds')
        for (const id of yield* batches.pending(plan.cycleId)) {
          const sealed = yield* batches.finish(id)
          expect(
            sealed.result?.candidates.filter((candidate) => candidate.status === JevCandidateResultStatus.Unattempted),
          ).toHaveLength(0)
        }
        expect(yield* batches.pending(plan.cycleId)).toEqual([])
        expect(yield* batches.pending(foreignPlan.cycleId)).toEqual([foreignPlan.batchId])
        expect((yield* batches.read(foreignPlan.batchId))?.result).toBeNull()
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_requests`).toEqual([
          {
            count: [plan, nextPlan, foreignPlan].flatMap(({ candidates }) =>
              candidates.filter((candidate) => candidate.status === JevCandidatePlanStatus.Requested),
            ).length,
          },
        ])
      }).pipe(atObservation),
    )
  })

  for (const planVersion of [JevBatchPlanVersion.V8]) {
    test(`persists ${planVersion} under the expanded database constraint`, async () => {
      const { batchId: _, ...material } = plan
      const versioned = Result.getOrThrow(makeJevBatchPlan({ ...material, schemaVersion: planVersion }))
      await runtime.runPromise(
        Effect.gen(function* () {
          const store = yield* JevBatchStore
          const saved = yield* store
            .begin(versioned, fixture.observation.payload)
            .pipe(Effect.map(({ plan, result }) => ({ plan, result })))
          expect(saved).toMatchObject({ plan: versioned, result: null })
          expect(yield* store.read(versioned.batchId)).toEqual(saved)
        }).pipe(atObservation),
      )
    })
  }

  test('concurrent admission grants every candidate to one owner and retries grant no dispatch rights', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const admissions = yield* Effect.all(
          Array.from({ length: 8 }, () => store.begin(plan, fixture.observation.payload)),
          { concurrency: 8 },
        )
        expect(admissions.filter(({ dispatches }) => dispatches.length > 0)).toHaveLength(1)
        expect(
          admissions
            .flatMap(({ dispatches }) => dispatches)
            .map(({ request }) => request.requestId)
            .sort(),
        ).toEqual(requested.map(({ request }) => request.requestId).sort())
        expect((yield* store.begin(plan, fixture.observation.payload)).dispatches).toEqual([])
        expect(
          yield* (yield* PgClient.PgClient)`SELECT count(*)::integer AS count FROM jev_evaluation_requests`,
        ).toEqual([{ count: requested.length }])
      }).pipe(atObservation),
    )
  })

  test('finalizes recorded candidates before the deadline without serial evaluation reads', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const evaluations = yield* JevEvaluationStore
        const delayed = {
          ...evaluations,
          read: (requestId: string) =>
            evaluations.read(requestId).pipe(Effect.tap(() => TestClock.adjust('100 millis'))),
        }
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(JevEvaluationStore, delayed))
        yield* batches.begin(plan, fixture.observation.payload)
        for (const candidate of requested) {
          const journal = yield* EntryInferenceJournal
          const checkpoint = stagedCheckpointFixture(candidate.request, plan.observedAt)
          for (const claim of checkpoint.claims) {
            yield* persistVisualClaimFixture(journal, claim)
            const terminal = checkpoint.terminals.find((row) => row.stage === claim.stage)
            if (terminal !== undefined)
              yield* persistVisualTransitionFixture(journal, { terminal: terminal, successor: { kind: 'NONE' } })
          }

          yield* persistHandoffFixture(
            yield* EntryInferenceJournal,
            entryCompletionFixture(candidate.request, plan.observedAt).handoff,
          )
          yield* persistEvaluationFixture(
            evaluations,
            candidate.request,
            Result.getOrThrow(
              makeJevEvaluationReceipt(candidate.request, {
                schemaVersion: 'bayn.jev-evaluation-receipt.v3',
                requestId: candidate.request.requestId,
                startedAt: plan.observedAt,
                completedAt: plan.observedAt,
                outcome: {
                  status: JevOutcome.Completed,
                  completion: entryCompletionFixture(candidate.request, plan.observedAt, 0.9),
                },
              }),
            ),
          )
        }
        yield* TestClock.setTime(observed + 4_700)
        const result = (yield* batches.finish(plan.batchId)).result
        if (result === null) throw new Error('Recorded batch did not finalize')
        expect(result.completedAt).toBe(utcInstantFromEpochMillis(observed + 4_700))
        expect(
          Result.getOrThrow(
            usableEntryBatchInferences(plan, result, yield* Clock.currentTimeMillis, JevBatchPlanVersion.V8),
          ),
        ).toHaveLength(requested.length)
      }).pipe(atObservation),
    )
  })

  test('finalization and complete reads restrict observations to the indexed cycle and exact observation time', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        let lookup: Statement<Record<string, unknown>> | undefined
        let readLookup: Statement<Record<string, unknown>> | undefined
        const monitored = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            if (statement.compile()[0].includes('AS matching_symbols')) lookup = statement
            if (statement.compile()[0].includes('AS matching_request_ids')) readLookup = statement
            return statement
          },
        })
        const batches = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, monitored))
        const admission = yield* batches.begin(plan, fixture.observation.payload)
        yield* seedObservationHistory(sql)
        // These timestamps have the same SQL instant, but are not the exact canonical source text.
        // Forged identities must remain irrelevant rather than broadening the evidence set.
        for (const [index, timestamp] of [
          plan.observedAt.replace('Z', '+00:00'),
          plan.observedAt.replace('Z', '000Z'),
        ].entries()) {
          const payload = {
            ...fixture.observation.payload,
            observedAt: timestamp,
            manifest: { ...fixture.observation.payload.manifest, observedAt: timestamp },
          }
          yield* sql`
            INSERT INTO intraday_candidate_observations (content_hash, cycle_id, observed_at, payload)
            VALUES (${String(index + 1).repeat(64)}, ${plan.cycleId}, ${plan.observedAt}::timestamptz, ${sql.json(payload)})
          `
        }
        yield* sql`ANALYZE intraday_candidate_observations`
        expect((yield* batches.finish(plan.batchId)).result).toBeNull()
        if (lookup === undefined) throw new Error('Finalization did not read candidate observations')
        yield* Effect.forEach(admission.dispatches, evaluateAdmittedFixture, { concurrency: 'unbounded' })
        const stored = yield* batches.finish(plan.batchId)
        expect(yield* batches.read(plan.batchId)).toEqual(stored)
        if (readLookup === undefined) throw new Error('Complete read did not verify candidate observations')
        for (const statement of [lookup, readLookup]) {
          yield* expectIndexedObservationLookup(sql, statement, 1)
        }
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })

  test('rejects a forged matching candidate observation before sealing the batch', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* batches.begin(plan, fixture.observation.payload)
        yield* sql`INSERT INTO intraday_candidate_observations (content_hash, cycle_id, observed_at, payload)
          VALUES (${'f'.repeat(64)}, ${plan.cycleId}, ${plan.observedAt}::timestamptz, ${sql.json(fixture.observation.payload)})`
        expect(Result.isFailure(yield* batches.finish(plan.batchId).pipe(Effect.result))).toBe(true)
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('rejects omitted candidates, unrelated source identities and a second deadline for the same observation', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const { batchId: _, ...material } = plan
        for (const change of [
          { observationHash: 'f'.repeat(64) },
          { protocolHash: 'f'.repeat(64) },
          {
            candidates: plan.candidates.slice(1),
            questionSetHash: Result.getOrThrow(jevBatchQuestionSetHash(plan.candidates.slice(1))),
          },
        ]) {
          const altered = Result.getOrThrow(makeJevBatchPlan({ ...material, ...change }))
          expect(Result.isFailure(yield* store.begin(altered, fixture.observation.payload).pipe(Effect.result))).toBe(
            true,
          )
        }
        const saved = yield* store
          .begin(plan, fixture.observation.payload)
          .pipe(Effect.map(({ plan, result }) => ({ plan, result })))
        expect(yield* store.begin(plan, fixture.observation.payload)).toMatchObject({
          plan: saved.plan,
          result: saved.result,
          dispatches: [],
        })
        expect(
          Result.isFailure(
            makeJevTradingSignalBatch({
              observation: fixture.observation.payload,
              expiresAt: utcInstantFromEpochMillis(observed + 6000),
              planVersion: JevBatchPlanVersion.V8,
            }),
          ),
        ).toBe(true)
        expect(yield* (yield* PgClient.PgClient)`SELECT batch_id FROM jev_batch_plans`).toEqual([
          { batch_id: plan.batchId },
        ])
      }).pipe(atObservation),
    )
  })

  test('expired recovery seals pending and unattempted candidates and preserves later response evidence separately', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const requests = yield* JevEvaluationStore
        yield* store.begin(plan, fixture.observation.payload)
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

  test('does not invent a plan after its deadline or start one before observation', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        for (const now of [observed - 1, observed + fixture.protocol.inferenceValidityMs]) {
          yield* TestClock.setTime(now)
          const result = yield* store.begin(plan, fixture.observation.payload).pipe(Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result))
            expect(result.failure._tag).toBe(now < observed ? 'OperationalError' : 'JevBatchExpired')
        }
        expect(yield* store.read(plan.batchId)).toBeNull()
        expect(yield* (yield* PgClient.PgClient)`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('expired verified admission makes no claim or provider call and preserves committed recovery', async () => {
    let calls = 0
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* TestClock.setTime(observed + 16000)
        const result = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(JevBatchExpired)
          expect(result.failure).toMatchObject({
            batchId: plan.batchId,
            observedAt: plan.observedAt,
            expiresAt: plan.expiresAt,
            checkedAt: utcInstantFromEpochMillis(observed + 16000),
          })
        }
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
        expect(calls).toBe(0)
        yield* TestClock.setTime(observed)
        const saved = yield* store
          .begin(plan, fixture.observation.payload)
          .pipe(Effect.map(({ plan, result }) => ({ plan, result })))
        yield* TestClock.setTime(observed + 16000)
        expect(yield* store.begin(plan, fixture.observation.payload)).toMatchObject({
          plan: saved.plan,
          result: saved.result,
          dispatches: [],
        })
        expect((yield* Effect.flatMap(JevBatchStore, (store) => store.finish(plan.batchId))).result).not.toBeNull()
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_requests`).toEqual([
          { count: requested.length },
        ])
        expect(calls).toBe(0)
      }).pipe(
        Effect.provideService(JevClient, {
          evaluate: (request, budgetMs) =>
            Effect.sync(() => {
              calls += 1
            }).pipe(Effect.andThen(successful.evaluate(request, budgetMs))),
        }),
        atObservation,
      ),
    )
  })

  test.each(['admission', 'result'] as const)('lost %s acknowledgement cannot repeat inference', async (stage) => {
    let calls = 0
    const failure = operationalError({ component: 'database', operation: 'test', message: 'lost acknowledgement' })
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const uncertain = {
          ...store,
          begin: (value: typeof plan, observation: typeof fixture.observation.payload) =>
            stage === 'admission'
              ? store.begin(value, observation).pipe(Effect.andThen(Effect.fail(failure)))
              : store.begin(value, observation),
          finish: (id: string) =>
            stage === 'result' ? store.finish(id).pipe(Effect.andThen(Effect.fail(failure))) : store.finish(id),
          complete: (...input: Parameters<typeof store.complete>) =>
            stage === 'result'
              ? store.complete(...input).pipe(Effect.andThen(Effect.fail(failure)))
              : store.complete(...input),
        }
        expect(
          Result.isFailure(
            yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
              Effect.provideService(JevBatchStore, uncertain),
              Effect.result,
            ),
          ),
        ).toBe(true)
        expect(calls).toBe(stage === 'admission' ? 0 : requested.length)
        const retry = yield* evaluateJevBatch(plan, fixture.observation.payload)
        expect(retry.result === null).toBe(stage === 'admission')
        expect(calls).toBe(stage === 'admission' ? 0 : requested.length)
        yield* TestClock.setTime(Date.parse(plan.expiresAt))
        const recovered = yield* evaluateJevBatch(plan, fixture.observation.payload)
        expect(recovered.result).not.toBeNull()
        expect(yield* evaluateJevBatch(plan, fixture.observation.payload)).toEqual(recovered)
        expect(calls).toBe(stage === 'admission' ? 0 : requested.length)
      }).pipe(
        Effect.provideService(JevClient, {
          evaluate: (input, budgetMs) =>
            Effect.sync(() => {
              calls += 1
            }).pipe(Effect.andThen(successful.evaluate(input, budgetMs))),
        }),
        atObservation,
      ),
    )
  })

  test('starts every eligible inference concurrently before finalizing the complete batch', async () => {
    let calls = 0,
      active = 0,
      maximum = 0
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const wave = yield* Deferred.make<void>()
          const all = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const fiber = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
            Effect.provideService(JevClient, {
              evaluate: (request, budgetMs) =>
                Effect.gen(function* () {
                  expect(budgetMs).toBeGreaterThan(0)
                  expect(budgetMs).toBeLessThanOrEqual(Date.parse(plan.expiresAt) - (yield* Clock.currentTimeMillis))
                  calls += 1
                  active += 1
                  maximum = Math.max(maximum, active)
                  if (calls === 4) yield* Deferred.succeed(wave, undefined)
                  if (calls === requested.length) yield* Deferred.succeed(all, undefined)
                  yield* Deferred.await(release)
                  return yield* successful.evaluate(request, budgetMs)
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      active -= 1
                    }),
                  ),
                ),
            }),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(wave)
          expect((yield* (yield* JevBatchStore).read(plan.batchId))?.result).toBeNull()
          yield* Deferred.await(all)
          expect(active).toBe(requested.length)
          expect((yield* (yield* JevBatchStore).read(plan.batchId))?.result).toBeNull()
          yield* TestClock.adjust('200 millis')
          yield* Deferred.succeed(release, undefined)
          const result = (yield* Fiber.join(fiber)).result
          if (result === null) throw new Error('Complete batch not finalized')
          expect(Date.parse(result.completedAt)).toBeLessThan(Date.parse(plan.expiresAt))
          expect(calls).toBe(requested.length)
          expect(maximum).toBe(requested.length)
          expect(active).toBe(0)
        }),
      ).pipe(atObservation),
    )
  })

  test('concurrent finalizers seal already committed receipts into one immutable result', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const admission = yield* batches.begin(plan, fixture.observation.payload)
        yield* Effect.forEach(admission.dispatches, evaluateAdmittedFixture, { concurrency: 'unbounded' })
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT result_hash FROM jev_batch_results`).toEqual([])
        const arrivals = yield* Deferred.make<void>()
        let inserting = 0
        const startedAt = databaseClock.currentTimeMillisUnsafe()
        const queryEvents: { query: string; event: string; elapsedMs: number }[] = []
        let eventCount = 0
        const recordQueryEvent = (query: string, event: string) => {
          eventCount += 1
          if (queryEvents.length < 64)
            queryEvents.push({ query, event, elapsedMs: databaseClock.currentTimeMillisUnsafe() - startedAt })
        }
        const simultaneous = new Proxy(sql, {
          apply(target, receiver, argumentsList) {
            const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
            const query = statement.compile()[0]
            const insertingResult = query.includes('INSERT INTO jev_batch_results')
            const category = insertingResult
              ? 'result-insert'
              : query.includes('FROM jev_batch_plans')
                ? 'batch-read'
                : query.includes('FROM jev_evaluation_requests')
                  ? 'evaluation-read'
                  : query.includes('JOIN intraday_candidate_observations')
                    ? 'observation-read'
                    : 'other'
            return withTestEvaluation(statement, () =>
              Effect.gen(function* () {
                if (insertingResult) {
                  inserting += 1
                  recordQueryEvent(category, 'barrier-arrival')
                  if (inserting === 4) yield* Deferred.succeed(arrivals, undefined)
                  yield* Deferred.await(arrivals)
                }
                recordQueryEvent(category, 'start')
                return yield* statement.pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => recordQueryEvent(category, Exit.isSuccess(exit) ? 'success' : 'failure')),
                  ),
                )
              }),
            )
          },
        })
        const competing = yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, simultaneous))
        const finalized = yield* Effect.all(
          Array.from({ length: 4 }, () => competing.finish(plan.batchId)),
          { concurrency: 'unbounded' },
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Effect.logError('Concurrent finalizer query phases', {
                  inserting,
                  eventCount,
                  queryEvents,
                  elapsedMs: databaseClock.currentTimeMillisUnsafe() - startedAt,
                })
              : Effect.void,
          ),
        )
        const saved = yield* batches.read(plan.batchId)
        if (saved === null || saved.result === null) throw new Error('Committed receipts did not finalize')
        for (const result of finalized) expect(result).toEqual(saved)
        expect(
          Result.getOrThrow(usableEntryBatchInferences(plan, saved.result, observed, JevBatchPlanVersion.V8)),
        ).toHaveLength(requested.length)
        expect(yield* sql`SELECT result_hash FROM jev_batch_results`).toEqual([
          { result_hash: saved.result.resultHash },
        ])
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_receipts`).toEqual([
          { count: requested.length },
        ])
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })

  test('recorded finalization races a pending recovery without a foreign-key deadlock', async () => {
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const batches = yield* JevBatchStore
          const sql = yield* PgClient.PgClient
          const admission = yield* batches.begin(plan, fixture.observation.payload)
          const paused = yield* Deferred.make<void>()
          const resume = yield* Deferred.make<void>()
          const readyToBegin = yield* Deferred.make<void>()
          const begin = yield* Deferred.make<void>()
          const readyToInsert = yield* Deferred.make<void>()
          const insert = yield* Deferred.make<void>()
          const inserting = yield* Deferred.make<void>()
          const inserted = yield* Deferred.make<void>()
          const readyToRecord = yield* Deferred.make<void>()
          const record = yield* Deferred.make<void>()
          const evaluations = yield* JevEvaluationStore
          let prepared = 0
          // Complete authentic provider/checkpoint work before holding an idle SQL transaction.
          // Receipts remain absent until the pending finalizer selects recovery before BEGIN.
          const evaluating = yield* Effect.forEach(admission.dispatches, evaluateAdmittedFixture, {
            concurrency: 'unbounded',
          }).pipe(
            Effect.provideService(JevEvaluationStore, {
              ...evaluations,
              recordAll: (entries) =>
                Effect.gen(function* () {
                  prepared += 1
                  if (prepared === admission.dispatches.length) yield* Deferred.succeed(readyToRecord, undefined)
                  yield* Deferred.await(record)
                  return yield* evaluations.recordAll(entries)
                }),
            }),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(readyToRecord)
          expect(prepared).toBe(admission.dispatches.length)
          expect(yield* sql`SELECT request_id FROM jev_evaluation_receipts`).toEqual([])
          expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
          const held = new Proxy(sql, {
            get(target, property, receiver) {
              if (property === 'withTransaction')
                return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  Deferred.succeed(readyToBegin, undefined).pipe(
                    Effect.andThen(Deferred.await(begin)),
                    Effect.andThen(target.withTransaction(effect)),
                  )
              return Reflect.get(target, property, receiver)
            },
            apply(target, receiver, argumentsList) {
              const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
              const query = statement.compile()[0]
              return query.includes('SELECT request_id FROM jev_evaluation_requests') && query.includes('FOR UPDATE')
                ? Deferred.succeed(paused, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(statement),
                  )
                : statement
            },
          })
          const pending = yield* (yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, held)))
            .finish(plan.batchId)
            .pipe(Effect.forkScoped({ startImmediately: true }))
          // Keep the pending path selected while receipts are absent, but do not
          // open its transaction during expensive receipt/result reproduction.
          yield* Deferred.await(readyToBegin)
          yield* Deferred.succeed(record, undefined)
          yield* Fiber.join(evaluating)
          const monitored = new Proxy(sql, {
            apply(target, receiver, argumentsList) {
              const statement: Statement<Record<string, unknown>> = Reflect.apply(target, receiver, argumentsList)
              return statement.compile()[0].includes('INSERT INTO jev_batch_results')
                ? Deferred.succeed(readyToInsert, undefined).pipe(
                    Effect.andThen(Deferred.await(insert)),
                    Effect.andThen(Deferred.succeed(inserting, undefined)),
                    Effect.andThen(statement),
                  )
                : statement
            },
          })
          const recorded = yield* (yield* makeJevBatchStore.pipe(Effect.provideService(PgClient.PgClient, monitored)))
            .finish(plan.batchId)
            .pipe(Effect.ensuring(Deferred.succeed(inserted, undefined)), Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.await(readyToInsert)
          yield* Deferred.succeed(begin, undefined)
          yield* Deferred.await(paused)
          yield* Deferred.succeed(insert, undefined)
          yield* Deferred.await(inserting)
          let observed = false
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (yield* Deferred.isDone(inserted)) {
              observed = true
              break
            }
            const [state] = yield* Schema.decodeUnknownEffect(
              Schema.Tuple([Schema.Struct({ waiting: Schema.Boolean })]),
            )(
              yield* sql`SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                AND wait_event_type='Lock' AND query LIKE ${'%INSERT INTO jev_batch_results%'}
            ) AS waiting`,
            )
            yield* Effect.sleep('5 millis').pipe(Effect.provideService(Clock.Clock, databaseClock))
            if (state?.waiting) {
              observed = true
              break
            }
          }
          yield* Deferred.succeed(resume, undefined)
          expect(observed).toBe(true)
          const results = yield* Effect.all([Fiber.join(pending), Fiber.join(recorded)], { concurrency: 'unbounded' })
          const saved = yield* batches.read(plan.batchId)
          if (saved === null || saved.result === null) throw new Error('Racing finalizers did not commit a result')
          for (const result of results) expect(result).toEqual(saved)
          expect(yield* sql`SELECT count(*)::integer AS count FROM jev_batch_results`).toEqual([{ count: 1 }])
        }),
      ).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })

  test('concurrent recovery commits one immutable result and seals every unattempted request', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const requests = yield* JevEvaluationStore
        yield* store.begin(plan, fixture.observation.payload)

        yield* TestClock.adjust('10 seconds')
        const recovered = yield* Effect.all(
          Array.from({ length: 4 }, () => Effect.flatMap(JevBatchStore, (store) => store.finish(plan.batchId))),
          { concurrency: 'unbounded' },
        )
        const saved = yield* store.read(plan.batchId)
        if (saved?.result === null || saved === null) throw new Error('Concurrent recovery did not finalize')
        for (const result of recovered) expect(result).toEqual(saved)
        const sql = yield* PgClient.PgClient
        expect(yield* sql`SELECT result_hash FROM jev_batch_results`).toEqual([
          { result_hash: saved.result.resultHash },
        ])
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_resolutions`).toEqual([
          { count: requested.length },
        ])
        for (const candidate of requested.slice(1))
          expect((yield* requests.read(candidate.request.requestId))?.resolution?.status).toBe(
            JevResolutionStatus.Abandoned,
          )
      }).pipe(atObservation),
    )
  })

  test('normal completion rejects uncommitted receipt bytes, a different source and ambient transactions', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        const saved = yield* evaluateJevBatch(plan, fixture.observation.payload)
        if (saved.result === null) throw new Error('Missing committed batch result')
        const original = saved.result.candidates.find(
          (candidate) =>
            candidate.status === JevCandidateResultStatus.Resolved && candidate.requestId === first.request.requestId,
        )
        if (original?.status !== JevCandidateResultStatus.Resolved || original.receipt === null)
          throw new Error('Missing recorded receipt')
        const { receiptHash: _receiptHash, ...material } = original.receipt
        const completedAt = utcInstantFromEpochMillis(observed + 1)
        const receipt = yield* Effect.fromResult(
          makeJevEvaluationReceipt(first.request, {
            ...material,
            completedAt,
            outcome:
              material.outcome.status === JevOutcome.Completed
                ? { ...material.outcome, completion: { ...material.outcome.completion, completedAt } }
                : material.outcome,
          }),
        )
        const resolution = yield* Effect.fromResult(
          makeJevResolution(first.request, receipt, {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: first.request.requestId,
            status: JevResolutionStatus.Recorded,
            receiptHash: receipt.receiptHash,
          }),
        )
        const { resultHash: _resultHash, ...result } = saved.result
        const changed = yield* Effect.fromResult(
          makeJevBatchResult(plan, {
            ...result,
            completedAt,
            candidates: result.candidates.map((candidate) =>
              candidate === original ? { ...original, receipt, resolution } : candidate,
            ),
          }),
        )
        yield* TestClock.setTime(observed + 2)
        expect(
          Result.isFailure(yield* store.complete(plan, fixture.observation.payload, changed).pipe(Effect.result)),
        ).toBe(true)
        expect(
          Result.isFailure(
            yield* store.complete(plan, foreignFixture.observation.payload, saved.result).pipe(Effect.result),
          ),
        ).toBe(true)
        expect(
          Result.isFailure(
            yield* sql
              .withTransaction(store.complete(plan, fixture.observation.payload, saved.result))
              .pipe(Effect.result),
          ),
        ).toBe(true)
        expect(yield* store.read(plan.batchId)).toEqual(saved)
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })

  test('timely multi-candidate approvals remain usable without another recovery pass', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        expect(requested.length).toBeGreaterThan(1)
        const sql = yield* PgClient.PgClient
        const delayed = {
          ...store,
          finish: (id: string) => store.finish(id).pipe(Effect.tap(() => TestClock.adjust('1200 millis'))),
          complete: (...args: Parameters<typeof store.complete>) =>
            store.complete(...args).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  const acknowledgedAt = utcInstantFromEpochMillis(observed + 9100)
                  yield* sql`UPDATE simulated_execution_clocks SET observed_at=${acknowledgedAt}
                WHERE account_id=${replayAccountId}`
                  yield* TestClock.setTime(observed + 9100)
                }),
              ),
            ),
        }
        const saved = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, delayed),
          Effect.provideService(JevClient, successful),
        )
        if (saved.result === null) throw new Error('Committed approvals lost their batch result')
        expect(
          Result.isSuccess(
            usableEntryBatchInferences(plan, saved.result, yield* Clock.currentTimeMillis, JevBatchPlanVersion.V8),
          ),
        ).toBe(true)
        expect(yield* store.read(plan.batchId)).toEqual(saved)
      }).pipe(atObservation),
    )
  })

  test('a result that expires while its commit acknowledgement is delayed cannot supply usable inferences', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* JevBatchStore
        const delayed = {
          ...store,
          finish: (id: string) => store.finish(id).pipe(Effect.tap(() => TestClock.adjust('10 seconds'))),
          complete: (...args: Parameters<typeof store.complete>) =>
            store.complete(...args).pipe(Effect.tap(() => TestClock.adjust('10 seconds'))),
        }
        const saved = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevBatchStore, delayed),
        )
        if (saved.result === null) throw new Error('Delayed commit acknowledgement lost its result')
        expect(saved.result.completedAt).toBe(plan.observedAt)
        expect(
          Result.isFailure(
            usableEntryBatchInferences(plan, saved.result, yield* Clock.currentTimeMillis, JevBatchPlanVersion.V8),
          ),
        ).toBe(true)
        expect(yield* store.read(plan.batchId)).toEqual(saved)
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })

  test('interruption leaves recoverable claims and cancels every active provider call', async () => {
    let calls = 0,
      stopped = 0
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>()
          const fiber = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
            Effect.provideService(JevClient, {
              evaluate: () =>
                Effect.sync(() => {
                  calls += 1
                }).pipe(
                  Effect.andThen(Deferred.succeed(started, undefined)),
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Effect.sync(() => {
                      stopped += 1
                    }),
                  ),
                ),
            }),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(started)
          yield* Fiber.interrupt(fiber)
          expect(calls).toBeGreaterThan(0)
          expect(stopped).toBe(calls)
          expect((yield* (yield* JevBatchStore).read(plan.batchId))?.result).toBeNull()
          yield* TestClock.adjust('10 seconds')
          expect((yield* Effect.flatMap(JevBatchStore, (store) => store.finish(plan.batchId))).result).not.toBeNull()
          expect(stopped).toBe(calls)
        }),
      ).pipe(atObservation),
    )
  })

  test('provider defects propagate and recovery requires no provider capability', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const exit = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevClient, { evaluate: () => Effect.die('provider defect') }),
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        yield* TestClock.adjust('10 seconds')
        const saved = yield* Effect.flatMap(JevBatchStore, (store) => store.finish(plan.batchId))
        expect(saved.result).not.toBeNull()
      }).pipe(atObservation),
    )
  })

  test('a completed sibling response remains durable when the rest of the cohort is interrupted', async () => {
    let calls = 0
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const waiting = yield* Deferred.make<void>()
          const batches = yield* JevBatchStore
          const sql = yield* PgClient.PgClient
          const fiber = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
            Effect.provideService(JevClient, {
              evaluate: (request, budget) =>
                Effect.suspend(() => {
                  if (++calls === 1) return successful.evaluate(request, budget)
                  return Deferred.succeed(waiting, undefined).pipe(Effect.andThen(Effect.never))
                }),
            }),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(waiting)
          yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
          expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_receipts`).toEqual([{ count: 1 }])
          expect((yield* batches.read(plan.batchId))?.result).toBeNull()
          const dispatched = calls
          yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
            Effect.provideService(JevClient, { evaluate: () => Effect.die('An interrupted cohort cannot redispatch') }),
          )
          expect(calls).toBe(dispatched)
          yield* TestClock.setTime(Date.parse(plan.expiresAt))
          const recovered = yield* batches.finish(plan.batchId)
          expect(
            recovered.result?.candidates.filter(
              (candidate) => candidate.status === JevCandidateResultStatus.Resolved && candidate.receipt !== null,
            ),
          ).toHaveLength(1)
        }),
      ).pipe(atObservation),
    )
  })

  test('a failed batch-result commit retains every paid receipt without repeating inference', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const batches = yield* JevBatchStore
        let calls = 0
        yield* sql`ALTER TABLE jev_batch_results ADD CONSTRAINT fail_cohort_completion CHECK (false)`
        const exit = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevClient, {
            evaluate: (request, budget) =>
              Effect.sync(() => {
                calls++
              }).pipe(Effect.andThen(successful.evaluate(request, budget))),
          }),
          Effect.exit,
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(calls).toBe(requested.length)
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_receipts`).toEqual([
          { count: requested.length },
        ])
        expect(yield* sql`SELECT count(*)::integer AS count FROM jev_evaluation_resolutions`).toEqual([
          { count: requested.length },
        ])
        expect((yield* batches.read(plan.batchId))?.result).toBeNull()
        yield* sql`ALTER TABLE jev_batch_results DROP CONSTRAINT fail_cohort_completion`
        const recovered = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
          Effect.provideService(JevClient, { evaluate: () => Effect.die('Recovery cannot repeat paid inference') }),
        )
        expect(recovered.result).not.toBeNull()
      }).pipe(atObservation),
    )
  })

  test('a timed-out candidate is canceled and retained beside successful peers without authorizing an entry', async () => {
    let calls = 0,
      stopped = 0
    await runtime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const allStarted = yield* Deferred.make<void>()
          const fiber = yield* evaluateJevBatch(plan, fixture.observation.payload).pipe(
            Effect.provideService(JevClient, {
              evaluate: (request, budgetMs) =>
                Effect.gen(function* () {
                  calls += 1
                  if (calls === requested.length) yield* Deferred.succeed(allStarted, undefined)
                  const { symbol } = yield* Schema.decodeUnknownEffect(Schema.Struct({ symbol: Schema.String }))(
                    Result.getOrThrow(prepareJevRequest(request)).request.state,
                  ).pipe(Effect.orDie)
                  if (symbol === first.symbol)
                    return yield* Effect.never.pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          stopped += 1
                        }),
                      ),
                    )
                  return yield* successful.evaluate(request, budgetMs)
                }),
            }),
            Effect.forkScoped({ startImmediately: true }),
          )
          yield* Deferred.await(allStarted)
          yield* TestClock.adjust('10 seconds')
          const saved = yield* Fiber.join(fiber)
          if (saved.result === null) throw new Error('Timed-out batch did not finalize')
          const outcomes = saved.result.candidates.flatMap((candidate) =>
            candidate.status === JevCandidateResultStatus.Resolved &&
            candidate.receipt?.outcome.status === JevOutcome.Completed
              ? [candidate.receipt.outcome.completion.jev.status]
              : [],
          )
          expect(outcomes.filter((status) => status === 'FAILED')).toHaveLength(1)
          expect(outcomes.filter((status) => status === 'RECEIVED')).toHaveLength(requested.length - 1)
          expect(stopped).toBe(1)
          expect(calls).toBe(requested.length)
          expect(
            Result.isFailure(
              usableEntryBatchInferences(
                plan,
                saved.result,
                observed + fixture.protocol.inferenceValidityMs,
                JevBatchPlanVersion.V8,
              ),
            ),
          ).toBe(true)
        }),
      ).pipe(atObservation),
    )
  })

  for (const mode of ['claim', 'record'])
    test(`a killed batch owner after ${mode} recovers in another process from database evidence only`, async () => {
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* TestClock.setTime(observed).pipe(
              Effect.andThen((yield* JevBatchStore).begin(plan, fixture.observation.payload)),
              Effect.provide(TestClock.layer()),
            )
            const fs = yield* FileSystem.FileSystem
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
            const directory = yield* fs.makeTempDirectoryScoped()
            const checkpoint = `${directory}/checkpoint`,
              resultPath = `${directory}/result.json`
            const command = (mode: string) =>
              ChildProcess.make(
                process.execPath,
                [
                  `${import.meta.dir}/../jev/batch-restart-worker.test-support.ts`,
                  mode,
                  plan.batchId,
                  checkpoint,
                  resultPath,
                ],
                { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', killSignal: 'SIGKILL' },
              )
            const firstProcess = yield* spawner.spawn(command(mode))
            while (!(yield* fs.exists(checkpoint))) {
              if (!(yield* firstProcess.isRunning)) throw new Error('Batch worker died before the expected commit')
              yield* Effect.sleep('25 millis')
            }
            yield* firstProcess.kill({ killSignal: 'SIGKILL' })
            yield* Effect.exit(firstProcess.exitCode)
            yield* fs.remove(checkpoint)
            const secondProcess = yield* spawner.spawn(command('recover'))
            expect(secondProcess.pid).not.toBe(firstProcess.pid)
            expect(Number(yield* secondProcess.exitCode)).toBe(0)
            const recovered = yield* fs
              .readFileString(resultPath)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))))
            const saved = yield* (yield* JevBatchStore).read(plan.batchId)
            expect(recovered).toEqual(saved)
            const result = saved?.result?.candidates.find((candidate) => candidate.symbol === first.symbol)
            if (result?.status !== JevCandidateResultStatus.Resolved) throw new Error('Missing recovered candidate')
            expect(result.resolution.status).toBe(
              mode === 'record' ? JevResolutionStatus.Recorded : JevResolutionStatus.Abandoned,
            )
            expect(
              saved?.result?.candidates.filter(
                (candidate) => candidate.status === JevCandidateResultStatus.Unattempted,
              ),
            ).toHaveLength(0)
          }),
        ).pipe(Effect.timeout('25 seconds')),
      )
    }, 30000)

  test('batch mutation rejects ambient transactions and every evidence table rejects mutation', async () => {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const store = yield* JevBatchStore
        expect(
          Result.isFailure(
            yield* sql.withTransaction(store.begin(plan, fixture.observation.payload)).pipe(Effect.result),
          ),
        ).toBe(true)
        const stored = yield* evaluateJevBatch(plan, fixture.observation.payload)
        expect(Result.isFailure(yield* sql.withTransaction(store.finish(plan.batchId)).pipe(Effect.result))).toBe(true)
        for (const operation of [
          sql`UPDATE jev_batch_plans SET payload = payload`,
          sql`DELETE FROM jev_batch_plans`,
          sql`TRUNCATE jev_batch_plans CASCADE`,
          sql`UPDATE jev_batch_results SET payload = payload`,
          sql`DELETE FROM jev_batch_results`,
          sql`TRUNCATE jev_batch_results`,
        ])
          expect(Result.isFailure(yield* operation.pipe(Effect.result))).toBe(true)
        expect(yield* store.read(plan.batchId)).toEqual(stored)
      }).pipe(Effect.provideService(JevClient, successful), atObservation),
    )
  })
})
