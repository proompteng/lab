import { beginRecordedJevBatch, evaluateRecordedJevBatch } from '../jev/batch-admission.test-support'
import { entryProviderFixture } from '../jev/entry-inference.test-support'
import {
  persistVisualClaimFixture,
  persistVisualTransitionFixture,
  persistHandoffFixture,
} from '../jev/evaluation.test-support'
import { makeCycleExecutionPolicyFromModel } from '../cycle/construction'
import { makeIntradayCycleDraft } from '../cycle/runner/calendar-decisions'
import { entryAblationStrategyIdentity, makeEntryAblationPolicy } from '../jev/entry-ablation-policy'
import { decideEntryAblation } from '../jev/entry-ablation'
import { makeInferenceCostReport, InferenceStage } from '../inference-costs'
import { inferenceExpenseRateCard } from '../inference-expense'
import { acquireInferenceExpenseSnapshot } from '../inference-costs-postgres'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { entryCompletionFixture, stagedCheckpointFixture } from '../jev/entry-inference.test-support'
import { chartProviderFixture } from '../jev/entry-inference.test-support'
import { exchangeSessions } from '../market-hours'
import { expect, setDefaultTimeout, test } from 'bun:test'
import { PgClient } from '@effect/sql-pg'
import { Effect, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'
import * as Reactivity from 'effect/reactivity/Reactivity'
import type { Statement } from 'effect/sql/Statement'
import { CycleStore } from '../cycle/store/model'
import {
  JevCandidatePlanStatus,
  JevBatchPlanVersion,
  JevCandidateResultStatus,
  usableEntryBatchInferences,
} from '../jev/batch'
import { JevBatchStore } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { makeJevTradingSignalBatch } from '../jev/trading-signals'
import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { makeJevObservation } from '../jev/observation'
import {
  describeJevBatchPostgres,
  atObservation,
  excludedFixture,
  excludedPlan,
  fixture,
  immediateDispatches,
  observed,
  plan,
  withTestEvaluation,
} from './jev-batch-postgres.test-support'

setDefaultTimeout(30_000)

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

describeJevBatchPostgres((postgres) => {
  test('ablation commits its own policy, calls only the chart provider, preserves costs and replays without redispatch', async () => {
    let chartCalls = 0
    await postgres.runtime.runPromise(
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
          Result.isFailure(
            yield* beginRecordedJevBatch(yield* JevBatchStore, candidate, observation.payload).pipe(Effect.result),
          ),
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
        const stored = yield* evaluateRecordedJevBatch(ablation, observation.payload)
        if (stored.result === null) throw new Error('Ablation batch did not finalize')
        const inferences = yield* Effect.fromResult(
          usableEntryBatchInferences(ablation, stored.result, observed, JevBatchPlanVersion.Ablation),
        )
        expect(inferences.length).toBeGreaterThan(0)
        expect(inferences.every(({ inference }) => inference.jev.status === 'OMITTED_BY_POLICY')).toBe(true)
        expect(chartCalls).toBe(inferences.length)
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
        expect(yield* evaluateRecordedJevBatch(ablation, observation.payload)).toEqual(stored)
        expect(chartCalls).toBe(inferences.length)
        const snapshot = yield* acquireInferenceExpenseSnapshot(
          sql,
          r.accountId,
          fixture.snapshot.manifest.sessionDate,
        ).pipe(Effect.flatMap(({ verify }) => verify))
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
        Effect.provideService(
          JevClient,
          entryProviderFixture(
            { evaluate: () => Effect.die('Ablation cannot call entry judgments') },
            {
              evaluate: (...args) =>
                Effect.sync(() => {
                  chartCalls++
                }).pipe(Effect.andThen(chartProviderFixture.evaluate(...args))),
            },
          ),
        ),
      ),
    )
  })

  test('database receipt admission rejects a candidate that claims the ablation provider omission', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient
        const admitted = yield* beginRecordedJevBatch(yield* JevBatchStore, plan, fixture.observation.payload)
        const dispatch = immediateDispatches(admitted)[0]
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

  test('all-excluded admission commits a complete batch before returning and replays without finalization', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        expect(excludedPlan.candidates.length).toBeGreaterThan(0)
        expect(excludedPlan.candidates.every((candidate) => candidate.status === JevCandidatePlanStatus.Excluded)).toBe(
          true,
        )
        const saved = yield* beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload).pipe(
          Effect.map(({ plan, result }) => ({ plan, result })),
        )
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
        expect(yield* beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload)).toMatchObject({
          plan: saved.plan,
          result: saved.result,
          dispatches: [],
        })
        expect(
          yield* evaluateRecordedJevBatch(excludedPlan, excludedFixture.observation.payload).pipe(
            Effect.provideService(JevBatchStore, {
              ...batches,
              finish: () => Effect.die('A complete admission must not open another finalization'),
            }),
          ),
        ).toEqual(saved)
      }).pipe(
        Effect.provideService(
          JevClient,
          entryProviderFixture({ evaluate: () => Effect.die('Excluded candidates must not call inference') }),
        ),
        atObservation,
      ),
    )
  })

  test('all-excluded result failure rolls back its new plan and permits an atomic retry', async () => {
    await postgres.runtime.runPromise(
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
        const failed = yield* beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload).pipe(
          Effect.result,
        )
        expect(Result.isFailure(failed)).toBe(true)
        expect(yield* sql`SELECT batch_id FROM jev_batch_plans`).toEqual([])
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([])
        expect(yield* sql`SELECT request_id FROM jev_evaluation_requests`).toEqual([])
        expect(
          yield* sql`SELECT content_hash FROM intraday_candidate_observations
            WHERE content_hash = ${excludedPlan.observationHash}`,
        ).toEqual([{ content_hash: excludedPlan.observationHash }])
        yield* sql`DROP TRIGGER fail_excluded_batch_result ON jev_batch_results`
        const saved = yield* beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload).pipe(
          Effect.map(({ plan, result }) => ({ plan, result })),
        )
        expect(saved.result).not.toBeNull()
        expect(yield* batches.read(excludedPlan.batchId)).toEqual(saved)
        expect(yield* batches.pending(excludedPlan.cycleId)).toEqual([])
      }).pipe(atObservation),
    )
  })

  test('all-excluded concurrent admission preserves one immutable result', async () => {
    await postgres.runtime.runPromise(
      Effect.gen(function* () {
        const batches = yield* JevBatchStore
        const sql = yield* PgClient.PgClient
        yield* (yield* CandidateObservationStore).record(excludedFixture.observation)
        const saved = yield* Effect.all(
          Array.from({ length: 8 }, () =>
            beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload),
          ),
          { concurrency: 8 },
        )
        const firstSaved = saved[0]
        if (firstSaved === undefined) throw new Error('Concurrent admission did not return a batch')
        expect(firstSaved.result).not.toBeNull()
        for (const admitted of saved) expect(admitted).toEqual(firstSaved)
        yield* TestClock.adjust('1 minute')
        expect(yield* beginRecordedJevBatch(batches, excludedPlan, excludedFixture.observation.payload)).toEqual(
          firstSaved,
        )
        expect(yield* Effect.flatMap(JevBatchStore, (store) => store.finish(excludedPlan.batchId))).toEqual({
          plan: firstSaved.plan,
          result: firstSaved.result,
        })
        expect(yield* sql`SELECT batch_id FROM jev_batch_results`).toEqual([{ batch_id: excludedPlan.batchId }])
      }).pipe(atObservation),
    )
  })
})
