import { JevBatchPlanVersion } from '../jev/batch'
import { expect, test } from 'bun:test'
import { Clock, Deferred, Effect, Exit, Fiber, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { nativeJevDecisionEvidence, nativeJevFixture } from '../jev/native.test-support'
import type { JevBatchStore } from '../jev/batch-evaluation'
import { CandidateObservationStore, type CandidateObservation } from '../observe-composition/candidate-observation'
import { makeRepeatedMomentumPolicy } from '../strategy/repeated-momentum/policy'
import { evaluateRepeatedMomentumFromSnapshot } from '../strategy/repeated-momentum/runtime'
import { ReplayBrokerFailure } from './broker'
import { operationalError } from '../errors'
import { currentUtcInstant } from '../time'
import { makeReplayDecisionLatency, replayDecisionReleaseAt } from './decision-latency'
import { usableEntryBatchInferences } from '../jev/batch'

test('release arithmetic preserves slower completion and rejects unusable clocks without rounding', () => {
  expect(replayDecisionReleaseAt(100, 120, 50)).toBe(150)
  expect(replayDecisionReleaseAt(100, 200, 50)).toBe(200)
  expect(replayDecisionReleaseAt(-10, -5, 0)).toBe(-5)
  const dateLimit = 8_640_000_000_000_000
  expect(replayDecisionReleaseAt(dateLimit - 1, dateLimit, 1)).toBe(dateLimit)
  for (const [issuedAt, completedAt, p95] of [
    [0, -1, 0],
    [0, 1, -1],
    [0, 1, 0.5],
    [0, 1.5, 0],
    [0.5, 1, 0],
    [0, 1, Number.NaN],
    [0, Number.POSITIVE_INFINITY, 0],
    [Number.NEGATIVE_INFINITY, 0, 0],
    [dateLimit, dateLimit, 1],
    [-dateLimit - 1, 0, 0],
    [0, dateLimit + 1, 0],
    [-dateLimit, 0, Number.MAX_SAFE_INTEGER + 1],
  ] as const)
    expect(replayDecisionReleaseAt(issuedAt, completedAt, p95)).toBeUndefined()
})

const fixture = () => {
  const evidence = nativeJevDecisionEvidence(nativeJevFixture())
  const stored = { plan: evidence.batchPlan, result: evidence.batchResult }
  const store: JevBatchStore['Service'] = {
    read: () => Effect.succeed(stored),
    pending: () => Effect.succeed([]),
    begin: () => Effect.succeed({ ...stored, dispatches: [] }),
    finish: () => Effect.succeed(stored),
  }
  return { evidence, stored, store, start: Date.parse(evidence.batchPlan.observedAt) }
}

test.each(['already-complete', 'completed-after-inference'] as const)(
  'latency floor covers %s admission without changing the original batch or expiry',
  async (path) => {
    const { evidence, stored, store, start } = fixture()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const times: number[] = []
        const latency = makeReplayDecisionLatency(currentUtcInstant, {
          p95FullBatchMs: 15_000,
          advanceTo: (time) =>
            Effect.sync(() => {
              times.push(time)
            }).pipe(Effect.andThen(TestClock.setTime(time))),
        })
        const wrapped = latency.wrapStore({
          ...store,
          begin: () =>
            TestClock.setTime(Date.parse(stored.result.completedAt)).pipe(
              Effect.as({ ...stored, result: path === 'already-complete' ? stored.result : null, dispatches: [] }),
            ),
        })
        const result = yield* latency.runPass(
          Effect.gen(function* () {
            const saved = yield* wrapped.begin(evidence.batchPlan, evidence.observation)
            return saved.result === null ? yield* wrapped.finish(stored.plan.batchId) : saved
          }),
        )
        expect(result.result).toEqual(stored.result)
        expect(result.plan.expiresAt).toBe(stored.plan.expiresAt)
        expect(yield* Clock.currentTimeMillis).toBe(start + 15_000)
        expect(times).toEqual([start + 15_000])
        expect(
          Result.isFailure(
            usableEntryBatchInferences(
              stored.plan,
              stored.result,
              yield* Clock.currentTimeMillis,
              JevBatchPlanVersion.V7,
            ),
          ),
        ).toBe(true)
        const first = yield* latency.evidence
        expect(first.unreleasedBatchIds).toEqual([])
        expect(first.receipts).toHaveLength(1)
        yield* TestClock.setTime(start + 20_000)
        yield* latency.runPass(wrapped.finish(stored.plan.batchId))
        expect(yield* latency.evidence).toEqual(first)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  },
)

test('slower work keeps its actual duration and pending work cannot acquire a release receipt', async () => {
  const { evidence, stored, store, start } = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const latency = makeReplayDecisionLatency(currentUtcInstant, {
        p95FullBatchMs: 100,
        advanceTo: () => Effect.die('a slower batch cannot move backward to the floor'),
      })
      const wrapped = latency.wrapStore({
        ...store,
        begin: () => Effect.succeed({ plan: stored.plan, result: null, dispatches: [] }),
      })
      yield* latency.runPass(wrapped.begin(evidence.batchPlan, evidence.observation))
      expect((yield* latency.evidence).unreleasedBatchIds).toEqual([stored.plan.batchId])
      yield* TestClock.setTime(start + 20_000)
      yield* latency.runPass(wrapped.finish(stored.plan.batchId))
      expect((yield* latency.evidence).receipts[0]?.releasedAt).toBe(new Date(start + 20_000).toISOString())
      expect((yield* latency.evidence).receipts[0]?.commandIssuedAt).toBe(new Date(start).toISOString())
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test('a restored batch without its original command cannot restart its latency clock', async () => {
  const { store, stored, start } = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(start + 20_000)
      const latency = makeReplayDecisionLatency(currentUtcInstant, {
        p95FullBatchMs: 100,
        advanceTo: TestClock.setTime,
      })
      expect(
        Exit.isFailure(yield* Effect.exit(latency.runPass(latency.wrapStore(store).finish(stored.plan.batchId)))),
      ).toBe(true)
      expect((yield* latency.evidence).receipts).toEqual([])
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test('interruption before release retains the original anchor and frees the command scope', async () => {
  const { store, stored, evidence, start } = fixture()
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const delaying = yield* Deferred.make<void>()
      const latency = makeReplayDecisionLatency(currentUtcInstant, {
        p95FullBatchMs: 15_000,
        advanceTo: () => Deferred.succeed(delaying, undefined).pipe(Effect.andThen(Effect.never)),
      })
      const wrapped = latency.wrapStore({
        ...store,
        begin: () =>
          TestClock.setTime(Date.parse(stored.result.completedAt)).pipe(Effect.as({ ...stored, dispatches: [] })),
      })
      const fiber = yield* latency
        .runPass(wrapped.begin(evidence.batchPlan, evidence.observation))
        .pipe(Effect.forkChild)
      yield* Deferred.await(delaying)
      yield* Fiber.interrupt(fiber)
      expect((yield* latency.evidence).unreleasedBatchIds).toEqual([stored.plan.batchId])
      yield* TestClock.setTime(start + 20_000)
      yield* latency.runPass(wrapped.finish(stored.plan.batchId))
      expect((yield* latency.evidence).receipts[0]?.commandIssuedAt).toBe(new Date(start).toISOString())
    }).pipe(Effect.provide(TestClock.layer())),
  )
})

test.each(['valid', 'expired', 'failed-write', 'failed-release', 'slow-commit'] as const)(
  'momentum latency uses durable source completion with the original expiry: %s',
  async (mode) => {
    const native = nativeJevFixture()
    const policy = makeRepeatedMomentumPolicy(native.protocol)
    const start = Date.parse(native.snapshot.manifest.observedAt)
    const p95 = mode === 'expired' ? native.protocol.inferenceValidityMs : 1000
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        let commits = 0
        const persisted: CandidateObservation[] = []
        const latency = makeReplayDecisionLatency(currentUtcInstant, {
          p95FullBatchMs: p95,
          advanceTo: (at) =>
            mode === 'failed-release'
              ? Effect.fail(new ReplayBrokerFailure({ message: 'Unavailable source clock' }))
              : TestClock.setTime(at),
        })
        const wrapped = latency.wrapObservations({
          latestJevWindowEnd: () => Effect.succeed(Option.none()),
          record: (observation) =>
            Effect.gen(function* () {
              if (mode === 'failed-write')
                return yield* operationalError({
                  component: 'database',
                  operation: 'candidate-observation',
                  message: 'Unavailable durable source',
                })
              commits++
              persisted.push(observation)
              if (mode === 'slow-commit') yield* TestClock.setTime(start + 2000)
            }),
        })
        const result = yield* Effect.result(
          latency.runPass(
            evaluateRepeatedMomentumFromSnapshot(
              native.input,
              native.snapshot.manifest.rangeEndAt,
              Effect.succeed(native.snapshot),
              policy,
              start + native.protocol.inferenceValidityMs,
            ).pipe(Effect.provideService(CandidateObservationStore, wrapped)),
          ),
        )
        const evidence = yield* latency.evidence
        expect(evidence.admittedBatchCount).toBe(0)
        expect(evidence.receipts).toEqual([])
        expect(evidence.admittedObservationCount).toBe(commits)
        if (mode === 'failed-write') {
          expect(commits).toBe(0)
          expect(Result.isFailure(result)).toBe(true)
          expect(evidence.observationReceipts).toEqual([])
        } else if (mode === 'failed-release') {
          expect(Result.isFailure(result)).toBe(true)
          expect(evidence.unreleasedObservationHashes).toHaveLength(1)
          expect(evidence.observationReceipts).toEqual([])
        } else {
          expect(Result.isSuccess(result)).toBe(mode !== 'expired')
          expect(evidence.unreleasedObservationHashes).toEqual([])
          const receipt = evidence.observationReceipts[0]
          if (receipt === undefined) throw new Error('Missing momentum release')
          expect(receipt.commandIssuedAt).toBe(new Date(start).toISOString())
          expect(receipt.observedAt).toBe(new Date(start).toISOString())
          expect(Date.parse(receipt.releasedAt)).toBe(start + (mode === 'slow-commit' ? 2000 : p95))
          expect(Date.parse(receipt.completedAt)).toBe(start + (mode === 'slow-commit' ? 2000 : 0))
          const stored = persisted[0]
          if (stored === undefined) throw new Error('Missing stored observation')
          yield* TestClock.setTime(start + p95 + 5000)
          yield* latency.runPass(wrapped.record(stored, policy))
          expect(yield* latency.evidence).toEqual(evidence)
        }
      }).pipe(Effect.provide(TestClock.layer())),
    )
  },
)
