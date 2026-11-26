import { expect, test } from 'bun:test'
import { Effect, Layer, Logger, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { BrokerRead } from '../broker/alpaca/model'
import { DecisionReadinessReason } from '../cycle/runner/readiness'
import { operationalError } from '../errors'
import { makeIntradayAlphaRuntime } from '../intraday-replay/strategy'
import { JevClient } from '../jev/client'
import { JevBatchStore } from '../jev/batch-evaluation'
import { EntryInferenceJournal } from '../jev/entry-inference'
import { JevEvaluationStore } from '../jev/evaluation'
import { TrailingBaselinePendingCoverage } from '../market-data/intraday/trailing-baseline'
import { constructStreamingSnapshot } from '../market-data/streaming/snapshot'
import { makeAlphaStreamingSnapshot, makeFlatAlphaPortfolio } from '../strategy/intraday-alpha/test-support'
import { intradayAlphaStrategyIdentity } from '../strategy/intraday-alpha/policy'
import { shortEntryBrokerReads } from '../testing/entry-broker-reads.test-support'
import { fixtureRuntime } from '../testing/runtime-fixtures'
import {
  NativeAlphaBaselinePreparation,
  reproduceAlphaBaselinePreparation,
  type RecordedAlphaBaselinePreparation,
} from './alpha-baseline-preparation'
import { preparedAlphaBaselineFixture } from './alpha-baseline-preparation.test-support'
import { CandidateObservationStore } from './candidate-observation'
import { observeNativeEntry } from './entry-observation'

const run = async (observedAt: string, prepare: NativeAlphaBaselinePreparation['Service']['prepare']) => {
  const source = preparedAlphaBaselineFixture()
  const policy = source.payload.policy
  if (source.payload.calendar.schemaVersion !== 'bayn.alpaca-market-calendar-observation.v2')
    throw new Error('Native preparation test requires the equity provider calendar')
  const snapshot = makeAlphaStreamingSnapshot({
    minutesFromOpen: Math.max(
      1,
      Math.floor((Date.parse(observedAt) - Date.parse('2026-09-04T13:30:00.000Z')) / 60_000),
    ),
    profiles: {},
    snapshotCalendar: source.payload.calendar,
  })
  const portfolio = makeFlatAlphaPortfolio(observedAt, undefined, undefined, source.payload.accountId)
  const identity = Result.getOrThrow(intradayAlphaStrategyIdentity(policy))
  const unused = Effect.die('Preparation must not invoke an unrelated capability')
  const snapshots: string[] = []
  const observations: unknown[] = []
  const result = await Effect.runPromise(
    TestClock.setTime(Date.parse(observedAt)).pipe(
      Effect.andThen(
        observeNativeEntry({
          strategy: makeIntradayAlphaRuntime(policy, { ...fixtureRuntime.provenance, strategy: identity.strategy }),
          query: snapshot.query,
          observation: {
            cycleId: source.payload.cycleId,
            authorityGenerationHash: source.payload.authorityGenerationHash,
            protocol: policy.sharedProtocol,
            portfolio,
          },
          calendar: source.payload.calendar,
          sessionDate: source.payload.sessionDate,
          observedAt,
          admissionExpiresAt: Date.parse('2026-09-04T14:00:00.000Z'),
          loadSnapshot: (query) =>
            Effect.sync(() => {
              snapshots.push(query.observedAt)
              return Result.getOrThrow(constructStreamingSnapshot(snapshot.cut, query))
            }),
        }),
      ),
      Effect.result,
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          Logger.layer([]),
          Layer.succeed(NativeAlphaBaselinePreparation, { prepare }),
          Layer.succeed(CandidateObservationStore, {
            latestJevWindowEnd: () => Effect.succeed(Option.none()),
            readIntradayAlphaSessionState: () =>
              Effect.succeed({
                morningOrbTakenSymbols: [],
                middayReversionCompleted: false,
                noiseAreaTakenSymbols: [],
              }),
            record: (observation) =>
              Effect.sync(() => {
                observations.push(observation)
              }),
          }),
          Layer.succeed(BrokerRead, {
            ...shortEntryBrokerReads(portfolio.brokerState.account, observedAt),
            positions: unused,
            orders: () => unused,
            orderById: () => unused,
            orderByClientId: () => unused,
            feeActivities: () => unused,
            fillActivities: () => unused,
            marketCalendar: () => unused,
          }),
          Layer.succeed(JevClient, { evaluate: () => unused }),
          Layer.succeed(EntryInferenceJournal, { recordVisualClaims: () => unused, recordTransitions: () => unused }),
          Layer.succeed(JevBatchStore, {
            read: () => unused,
            pending: () => unused,
            begin: () => unused,
            complete: () => unused,
            finish: () => unused,
          }),
          Layer.succeed(JevEvaluationStore, { read: () => unused, recordAll: () => unused, abandon: () => unused }),
        ),
      ),
    ),
  )
  return { result, snapshots, observations }
}

test('the existing preopen wake retains preparation before the regular-minute warmup returns', async () => {
  const source = preparedAlphaBaselineFixture()
  let retained: RecordedAlphaBaselinePreparation | undefined
  const observed = await run('2026-09-04T12:01:02.000Z', (request) =>
    Effect.sync(() => {
      expect(request.accountId).toBe(source.payload.accountId)
      expect(request.authorityGenerationHash).toBe(source.payload.authorityGenerationHash)
      expect(request.calendar).toEqual(source.payload.calendar)
      retained = source
      return source
    }),
  )
  expect(retained).toEqual(source)
  expect(Result.isFailure(observed.result) && observed.result.failure).toMatchObject({
    _tag: 'JevAwaitingEvidence',
    readiness: DecisionReadinessReason.LookbackWarmup,
    availableAt: '2026-09-04T13:31:02.000Z',
  })

  expect(observed.snapshots).toEqual([])
  expect(observed.observations).toEqual([])
})

test('incomplete preopen preparation waits for the existing first provider regular-minute wake', async () => {
  const observed = await run('2026-09-04T12:01:02.000Z', () =>
    Effect.fail(
      new TrailingBaselinePendingCoverage({
        message: 'Synthetic preopen source is missing a required checkpoint',
        regularOpenAt: '2026-09-04T13:30:00.000Z',
      }),
    ),
  )
  expect(Result.isFailure(observed.result) && observed.result.failure).toMatchObject({
    _tag: 'JevAwaitingEvidence',
    readiness: DecisionReadinessReason.LookbackWarmup,
    availableAt: '2026-09-04T13:31:02.000Z',
  })
  expect(observed.snapshots).toEqual([])
  expect(observed.observations).toEqual([])
})

test('a later first regular observation and restarted owner reuse the same earlier prepared source', async () => {
  const source = preparedAlphaBaselineFixture()
  let reads = 0
  const prepare: NativeAlphaBaselinePreparation['Service']['prepare'] = () =>
    Effect.sync(() => {
      reads += 1
      return source
    })
  const first = await run('2026-09-04T13:31:02.000Z', prepare)
  const restarted = await run('2026-09-04T13:31:02.000Z', prepare)
  expect(Result.isSuccess(first.result)).toBe(true)
  expect(Result.isSuccess(restarted.result)).toBe(true)
  expect(first.observations).toHaveLength(1)
  expect(restarted.observations).toEqual(first.observations)
  expect(first.snapshots).toEqual(['2026-09-04T13:31:02.000Z'])
  expect(reads).toBe(2)
})

test('a first preparation committed after the original admission cut cannot enter or refresh that cut', async () => {
  const source = preparedAlphaBaselineFixture()
  const observedAt = '2026-09-04T13:31:02.000Z'
  const acquired = Result.getOrThrow(
    reproduceAlphaBaselinePreparation({
      ...source.payload,
      acquisition: { ...source.payload.acquisition, startedAt: observedAt, completedAt: observedAt },
    }),
  )
  const late = { contentHash: acquired.contentHash, payload: acquired.payload, recordedAt: '2026-09-04T13:31:02.001Z' }
  const observed = await run(observedAt, () => Effect.succeed(late))
  expect(Result.isFailure(observed.result) && observed.result.failure).toMatchObject({
    _tag: 'JevAwaitingEvidence',
    readiness: DecisionReadinessReason.SnapshotUnavailable,
    availableAt: '2026-09-04T13:32:02.000Z',
  })
  expect(observed.snapshots).toEqual([])
  expect(observed.observations).toEqual([])
  const nextWake = await run('2026-09-04T13:32:02.000Z', () => Effect.succeed(late))
  expect(Result.isSuccess(nextWake.result)).toBe(true)
  expect(nextWake.observations).toHaveLength(1)
})

test('a failed durable preparation cannot silently fall back to a provider load or admit an observation', async () => {
  const observed = await run('2026-09-04T13:31:02.000Z', () =>
    Effect.fail(
      operationalError({
        component: 'database',
        operation: 'alpha-baseline-preparation',
        message: 'synthetic preparation commit failed',
      }),
    ),
  )
  expect(Result.isFailure(observed.result) && observed.result.failure).toMatchObject({
    operation: 'alpha-baseline-preparation',
  })
  expect(observed.snapshots).toEqual([])
  expect(observed.observations).toEqual([])
})
