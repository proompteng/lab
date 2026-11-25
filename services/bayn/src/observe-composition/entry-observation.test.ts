import { expect, test } from 'bun:test'
import { Effect, Layer, Logger, Option, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerRead, MarketCalendarObservationSchema, type BrokerReadShape } from '../broker/alpaca/model'
import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { canonicalHashV1Result } from '../hash'
import { JevBatchPlanVersion, type JevBatchPlan } from '../jev/batch'
import { JevBatchStore, retainJevBatchPreparation } from '../jev/batch-evaluation'
import { JevClient } from '../jev/client'
import { entryInferenceFixtureLayer } from '../jev/entry-inference.test-support'
import { JevEvaluationStore } from '../jev/evaluation'
import { JevInferenceWorkStore } from '../jev/inference-work'
import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import { ownJevObservation, restoreJevObservation, type JevObservation } from '../jev/observation'
import { JevPurpose } from '../jev/portfolio'
import { fixtureRuntime } from '../testing/runtime-fixtures'
import { shortEntryBrokerReads } from '../testing/entry-broker-reads.test-support'
import { prepareJevTradingSignalBatch } from '../jev/trading-signals'
import { CandidateObservationStore } from './candidate-observation'
import { observeNativeEntry, type EntryObservationContext } from './entry-observation'

const fixture = nativeJevFixture(JevPurpose.Entry, '2026-09-04T14:30:32.000Z')
const evidence = nativeJevDecisionEvidence(fixture)
const saved = { plan: evidence.batchPlan, result: evidence.batchResult }
const restored = Result.getOrThrow(restoreJevObservation(fixture.observation.payload))
const unused = Effect.die('Completed inference must not refresh eligibility or reload source')
const context: EntryObservationContext = {
  strategy: fixtureRuntime,
  query: fixture.query,
  observation: fixture.input,
  calendar: Schema.decodeUnknownSync(MarketCalendarObservationSchema)(fixture.snapshot.manifest.calendar),
  sessionDate: fixture.draft.identity.executionSessionDate,
  observedAt: fixture.snapshot.manifest.observedAt,
  admissionExpiresAt: Date.parse(fixture.snapshot.manifest.observedAt) + 60_000,
  loadSnapshot: () => unused,
}
const brokerReads: BrokerReadShape = {
  account: unused,
  accountConfiguration: unused,
  assetBySymbol: () => unused,
  positions: unused,
  orders: () => unused,
  orderById: () => unused,
  orderByClientId: () => unused,
  feeActivities: () => unused,
  fillActivities: () => unused,
  marketCalendar: () => unused,
}
const batches: JevBatchStore['Service'] = {
  read: () => Effect.succeed(saved),
  pending: () => Effect.die('Resume must not discover another batch'),
  begin: () => Effect.die('Resume must not admit another batch'),
  finish: () => Effect.die('Resume must not seal another batch'),
  complete: () => Effect.die('Resume must not rewrite completed evidence'),
}
const inferenceWork: JevInferenceWorkStore['Service'] = {
  pending: () => unused,
  settleExpired: () => unused,
  read: () => unused,
  claim: () => unused,
  resume: (cycleId, generation) => {
    expect(cycleId).toBe(saved.plan.cycleId)
    expect(generation).toBe(saved.plan.authorityGenerationHash)
    return Effect.succeed({ batchId: saved.plan.batchId, loadSource: Effect.succeed(restored) })
  },
}
const layer = Layer.mergeAll(
  entryInferenceFixtureLayer,
  Layer.succeed(BrokerRead, brokerReads),
  Layer.succeed(JevBatchStore, batches),
  Layer.succeed(JevClient, { evaluate: () => Effect.die('Resume must not repeat inference') }),
  Layer.succeed(JevEvaluationStore, {
    read: () => unused,
    abandon: () => unused,
    recordAll: () => unused,
  }),
  Layer.succeed(CandidateObservationStore, {
    record: () => unused,
    latestJevWindowEnd: () => unused,
  }),
  Layer.succeed(JevInferenceWorkStore, inferenceWork),
)

const runObservation = (effect: ReturnType<typeof observeNativeEntry>, now = Date.parse(evidence.decidedAt) + 1) =>
  Effect.runPromise(
    TestClock.setTime(now).pipe(
      Effect.andThen(effect),
      Effect.result,
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([])),
    ),
  )

const newObservationServices = Layer.mergeAll(
  Layer.succeed(JevInferenceWorkStore, { ...inferenceWork, resume: () => Effect.succeed(null) }),
  Layer.succeed(JevBatchStore, { ...batches, pending: () => Effect.succeed([]) }),
  Layer.succeed(CandidateObservationStore, {
    record: () => unused,
    latestJevWindowEnd: () => Effect.succeed(Option.none()),
  }),
)

test('native completion preserves admitted evidence without discarded broker eligibility reads', async () => {
  const resumed = Result.getOrThrow(await runObservation(observeNativeEntry(context)))
  expect(resumed.snapshot).toBe(restored.snapshot)
  expect<unknown>(resumed.decision.evidence.observation).toEqual(restored.observation)
  if (resumed.decision.schemaVersion !== 'bayn.jev-entry-target.v7') throw new Error('Expected Jev entry target')
  expect(resumed.decision.evidence.batchPlan).toEqual(saved.plan)
  expect(resumed.decision.evidence.batchResult).toEqual(saved.result)
})

test('native completion reuses the admitted source and preserves the exact decision', async () => {
  const source = Result.getOrThrow(ownJevObservation(fixture.observation.payload))
  const prepared = Result.getOrThrow(prepareJevTradingSignalBatch(source, saved.plan.expiresAt, JevBatchPlanVersion.V8))
  const cold = Result.getOrThrow(await runObservation(observeNativeEntry(context)))
  const warm = Result.getOrThrow(
    await runObservation(
      observeNativeEntry(context).pipe(
        Effect.provideService(JevBatchStore, {
          ...batches,
          read: () => Effect.succeed(retainJevBatchPreparation({ ...saved }, prepared)),
        }),
        Effect.provideService(JevInferenceWorkStore, {
          ...inferenceWork,
          resume: () => Effect.succeed({ batchId: saved.plan.batchId, loadSource: unused }),
        }),
      ),
    ),
  )
  expect(warm.decision).toEqual(cold.decision)
  expect(warm.snapshot).toBe(source.verified.snapshot)
  expect(warm.decision.evidence.observation.rows).toBe(source.verified.rows)
})

test('new native source obtains fresh eligibility before sampling its observation clock and admitting the batch', async () => {
  const now = Date.parse(context.observedAt)
  const eligibilityAt = new Date(now + 500).toISOString()
  const fresh = nativeJevFixture(JevPurpose.Entry, eligibilityAt)
  const reads = shortEntryBrokerReads(fresh.portfolio.brokerState.account, eligibilityAt)
  const calls: string[] = []
  const admitted: { readonly plan: JevBatchPlan; readonly observation: JevObservation }[] = []
  const outcome = await runObservation(
    observeNativeEntry({
      ...context,
      loadSnapshot: (query) =>
        Effect.sync(() => {
          expect(query.observedAt).toBe(eligibilityAt)
          expect(calls).toHaveLength(2 + (context.query.candidateSymbols?.length ?? 0))
          calls.push('snapshot')
          return fresh.snapshot
        }),
    }).pipe(
      Effect.provideService(BrokerRead, {
        ...brokerReads,
        account: TestClock.setTime(now + 500).pipe(
          Effect.andThen(Effect.sync(() => calls.push('account'))),
          Effect.andThen(reads.account),
        ),
        accountConfiguration: Effect.sync(() => calls.push('configuration')).pipe(
          Effect.andThen(reads.accountConfiguration),
        ),
        assetBySymbol: (symbol) =>
          Effect.sync(() => calls.push(symbol)).pipe(Effect.andThen(reads.assetBySymbol(symbol))),
      }),
      Effect.provideService(JevBatchStore, {
        ...batches,
        pending: () => Effect.succeed([]),
        begin: ({ plan, source: { payload: observation } }) =>
          Effect.sync(() => {
            admitted.push({ plan, observation })
            return { plan, result: null, dispatches: null }
          }),
      }),
      Effect.provide(newObservationServices),
    ),
    now,
  )
  expect(Result.isFailure(outcome)).toBe(true)
  if (Result.isFailure(outcome) && outcome.failure._tag === 'JevAwaitingEvidence')
    expect(outcome.failure).toMatchObject({
      readiness: DecisionReadinessReason.DecisionPending,
      availableAt: new Date(Date.parse(eligibilityAt) + fresh.protocol.inferenceValidityMs).toISOString(),
    })
  else throw new Error('Expected a durably admitted batch awaiting inference')
  expect(admitted).toHaveLength(1)
  const admission = admitted[0]!
  expect(calls.filter((call) => call === 'account')).toHaveLength(1)
  expect(calls.filter((call) => call === 'configuration')).toHaveLength(1)
  expect(calls.filter((call) => context.query.candidateSymbols?.includes(call)).sort()).toEqual(
    [...(context.query.candidateSymbols ?? [])].sort(),
  )
  expect(calls.at(-1)).toBe('snapshot')
  expect(admission.observation.observedAt).toBe(eligibilityAt)
  expect(admission.observation.manifest).toEqual(fresh.snapshot.manifest)
  expect(admission.observation.portfolio).toEqual(context.observation.portfolio)
  expect(Object.keys(admission.observation.equityShortEligibility ?? {}).sort()).toEqual(
    [...(context.query.candidateSymbols ?? [])].sort(),
  )
  for (const eligibility of Object.values(admission.observation.equityShortEligibility ?? {})) {
    expect(eligibility.accountObservedAt).toBe(eligibilityAt)
    expect(eligibility.configurationObservedAt).toBe(eligibilityAt)
    expect(eligibility.assetObservedAt).toBe(eligibilityAt)
    expect(eligibility.shortingEnabled).toBe(true)
    expect(eligibility.shortable).toBe(true)
  }
  expect(admission.plan.observationHash).toBe(Result.getOrThrow(canonicalHashV1Result(admission.observation)))
  expect(Date.parse(admission.plan.expiresAt)).toBe(now + 500 + context.observation.protocol.inferenceValidityMs)
})

test.each([
  'original inference expiry',
  'current admission expiry',
  'foreign protocol',
  'foreign cycle',
  'foreign generation',
])('native completion fails closed after %s without acquiring replacement evidence', async (scenario) => {
  const now =
    scenario === 'original inference expiry' ? Date.parse(saved.plan.expiresAt) : Date.parse(evidence.decidedAt) + 1
  const changed = {
    ...context,
    ...(scenario === 'current admission expiry' ? { admissionExpiresAt: now } : {}),
    observation: {
      ...context.observation,
      ...(scenario === 'foreign protocol'
        ? {
            protocol: {
              ...context.observation.protocol,
              inferenceValidityMs: context.observation.protocol.inferenceValidityMs + 1,
            },
          }
        : {}),
      ...(scenario === 'foreign cycle' ? { cycleId: 'b'.repeat(64) } : {}),
      ...(scenario === 'foreign generation' ? { authorityGenerationHash: 'c'.repeat(64) } : {}),
    },
  }
  const outcome = await runObservation(
    observeNativeEntry(changed).pipe(
      Effect.provideService(JevInferenceWorkStore, {
        ...inferenceWork,
        resume: () => Effect.succeed({ batchId: saved.plan.batchId, loadSource: Effect.succeed(restored) }),
      }),
    ),
    now,
  )
  expect(Result.isFailure(outcome)).toBe(true)
  if (Result.isFailure(outcome) && outcome.failure._tag === 'JevAwaitingEvidence')
    expect(outcome.failure.readiness).toBe(DecisionReadinessReason.InferenceExpired)
  else throw new Error('Expected rejected original inference evidence')
})

test('pending native inference keeps its original deadline without refreshing broker eligibility', async () => {
  const outcome = await runObservation(
    observeNativeEntry(context).pipe(
      Effect.provideService(JevBatchStore, {
        ...batches,
        pending: () => Effect.succeed([saved.plan.batchId]),
        finish: () => Effect.succeed({ plan: saved.plan, result: null }),
      }),
      Effect.provide(newObservationServices),
    ),
  )
  expect(Result.isFailure(outcome)).toBe(true)
  if (Result.isFailure(outcome) && outcome.failure._tag === 'JevAwaitingEvidence') {
    expect(outcome.failure.readiness).toBe(DecisionReadinessReason.DecisionPending)
    expect(outcome.failure.availableAt).toBe(saved.plan.expiresAt)
  } else throw new Error('Expected the original pending inference deadline')
})

test('new native eligibility failure remains typed and does not load or admit a source', async () => {
  const failure = new BrokerReadError({
    operation: 'account',
    kind: BrokerReadErrorKind.Transport,
    message: 'Eligibility unavailable',
    retryable: true,
  })
  const reads = shortEntryBrokerReads(fixture.portfolio.brokerState.account, context.observedAt)
  const outcome = await runObservation(
    observeNativeEntry(context).pipe(
      Effect.provideService(BrokerRead, {
        ...brokerReads,
        ...reads,
        account: Effect.fail(failure),
      }),
      Effect.provide(newObservationServices),
    ),
  )
  expect(Result.isFailure(outcome)).toBe(true)
  if (Result.isFailure(outcome) && outcome.failure._tag === 'OperationalError') {
    expect(outcome.failure.operation).toBe('current-decision')
    expect(outcome.failure.cause).toBe(failure)
  } else throw new Error('Expected the original typed eligibility failure')
})
