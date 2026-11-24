import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { Effect, Logger, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { utcInstantFromEpochMillis } from '../time'
import { JevBatchPlanVersion, type JevBatchPlan } from './batch'
import { JevBatchStore } from './batch-evaluation'
import { JevClient } from './client'
import { entryInferenceFixtureLayer, entryProviderFixture } from './entry-inference.test-support'
import { JevEvaluationStore } from './evaluation'
import { nativeJevFixture } from './native.test-support'
import { JevPurpose } from './portfolio'
import { evaluateJevObservationFromSnapshot } from './runtime'

const observedAt = '2026-09-04T14:31:02.752Z'
const observedMs = Date.parse(observedAt)

const scenario = (sourceDelayMs = 0) => {
  const source = nativeJevFixture(JevPurpose.Entry, utcInstantFromEpochMillis(observedMs + sourceDelayMs))
  const admitted: JevBatchPlan[] = []
  let consumedWindow: string | undefined
  let sourceReads = 0
  const run = (cycleId: string, admissionDeadlineAt: number, now = observedMs) =>
    Effect.runPromise(
      TestClock.setTime(now).pipe(
        Effect.andThen(
          evaluateJevObservationFromSnapshot(
            { ...source.input, cycleId },
            source.snapshot.manifest.rangeEndAt,
            Effect.gen(function* () {
              sourceReads++
              if (sourceDelayMs > 0) yield* TestClock.adjust(sourceDelayMs)
              return source.snapshot
            }),
            JevBatchPlanVersion.V8,
            { admissionDeadlineAt },
          ),
        ),
        Effect.result,
        Effect.provideService(JevBatchStore, {
          read: () => Effect.die('A new source has no completed batch'),
          pending: () => Effect.succeed([]),
          begin: ({ plan }) =>
            Effect.sync(() => {
              admitted.push(plan)
              consumedWindow = source.snapshot.manifest.rangeEndAt
              return { plan, result: null, dispatches: null }
            }),
          finish: () => Effect.die('A new source has no batch to finish'),
          complete: () => Effect.die('Deferred provider work cannot complete in the financial owner'),
        }),
        Effect.provideService(CandidateObservationStore, {
          record: () => Effect.die('Only batch admission can consume the source'),
          latestJevWindowEnd: () => Effect.sync(() => Option.fromNullishOr(consumedWindow)),
        }),
        Effect.provideService(JevClient, entryProviderFixture({ evaluate: () => Effect.die('No provider call') })),
        Effect.provideService(JevEvaluationStore, {
          read: () => Effect.die('No evaluation read'),
          recordAll: () => Effect.die('No provider receipt'),
          abandon: () => Effect.die('No provider claim'),
        }),
        Effect.provide(entryInferenceFixtureLayer),
        Effect.provide(TestClock.layer()),
        Effect.provide(Logger.layer([])),
        Effect.provide(NodeServices.layer),
      ),
    )
  return { source, admitted, run, sourceReads: () => sourceReads, consumedWindow: () => consumedWindow }
}

test('an expiring cycle leaves the next source window for its successor without refreshing source evidence', async () => {
  const check = scenario()
  const originalDeadline = observedMs + 752
  expect(await check.run('a'.repeat(64), originalDeadline)).toMatchObject({
    failure: {
      _tag: 'JevAwaitingEvidence',
      readiness: 'DECISION_PENDING',
      availableAt: utcInstantFromEpochMillis(originalDeadline),
    },
  })
  expect(check.sourceReads()).toBe(0)
  expect(check.admitted).toHaveLength(0)
  expect(check.consumedWindow()).toBeUndefined()

  const successorAt = originalDeadline + 1
  expect(await check.run('b'.repeat(64), successorAt + 60_000, successorAt)).toMatchObject({
    failure: {
      _tag: 'JevAwaitingEvidence',
      readiness: 'DECISION_PENDING',
      availableAt: utcInstantFromEpochMillis(observedMs + check.source.protocol.inferenceValidityMs),
    },
  })
  expect(check.sourceReads()).toBe(1)
  expect(check.admitted).toHaveLength(1)
  expect(check.admitted[0]).toMatchObject({
    cycleId: 'b'.repeat(64),
    observedAt,
    expiresAt: utcInstantFromEpochMillis(observedMs + check.source.protocol.inferenceValidityMs),
  })
  expect(check.consumedWindow()).toBe(check.source.snapshot.manifest.rangeEndAt)
})

test.each([-1, 0, 1])(
  'new inference retains the original full interval at admission headroom %d ms',
  async (offset) => {
    const check = scenario()
    const deadline = observedMs + check.source.protocol.inferenceValidityMs + offset
    const result = await check.run('a'.repeat(64), deadline)
    expect(Result.isFailure(result)).toBe(true)
    expect(check.admitted).toHaveLength(offset < 0 ? 0 : 1)
    expect(check.sourceReads()).toBe(offset < 0 ? 0 : 1)
    if (offset < 0)
      expect(result).toMatchObject({
        failure: { readiness: 'DECISION_PENDING', availableAt: utcInstantFromEpochMillis(deadline) },
      })
    else
      expect(check.admitted[0]?.expiresAt).toBe(
        utcInstantFromEpochMillis(observedMs + check.source.protocol.inferenceValidityMs),
      )
  },
)

test('source acquisition cannot consume the next window after exhausting admission headroom', async () => {
  const check = scenario(500)
  const deadline = observedMs + check.source.protocol.inferenceValidityMs
  expect(await check.run('a'.repeat(64), deadline)).toMatchObject({
    failure: { readiness: 'DECISION_PENDING', availableAt: utcInstantFromEpochMillis(deadline) },
  })
  expect(check.sourceReads()).toBe(1)
  expect(check.admitted).toHaveLength(0)
  expect(check.consumedWindow()).toBeUndefined()
})
