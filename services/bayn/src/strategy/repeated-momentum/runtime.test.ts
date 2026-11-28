import { expect, test } from 'bun:test'
import { Effect, Option, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { NodeServices } from '@effect/platform-node'

import { operationalError } from '../../errors'
import { canonicalHashV1Result } from '../../hash'
import { nativeJevFixture } from '../../jev/native.test-support'
import { CandidateObservationStore, type CandidateObservation } from '../../observe-composition/candidate-observation'
import { makeRepeatedMomentumPolicy } from './policy'
import { evaluateRepeatedMomentumFromSnapshot } from './runtime'

const run = (mode: 'normal' | 'repeat' | 'write-failure' | 'late-commit') => {
  const source = nativeJevFixture()
  const policy = makeRepeatedMomentumPolicy(source.protocol)
  let loaded = 0
  const recorded: CandidateObservation[] = []
  const program = evaluateRepeatedMomentumFromSnapshot(
    source.input,
    source.snapshot.manifest.rangeEndAt,
    Effect.sync(() => {
      loaded++
      return source.snapshot
    }),
    policy,
    Date.parse(source.snapshot.manifest.observedAt) + source.protocol.inferenceValidityMs,
  ).pipe(
    Effect.provideService(CandidateObservationStore, {
      latestJevWindowEnd: () =>
        Effect.succeed(mode === 'repeat' ? Option.some(source.snapshot.manifest.rangeEndAt) : Option.none()),
      record: (observation, supplied) =>
        Effect.gen(function* () {
          expect(supplied).toEqual(policy)
          if (mode === 'write-failure')
            return yield* operationalError({
              component: 'database',
              operation: 'candidate-observation',
              message: 'Storage unavailable',
            })
          recorded.push(observation)
          if (mode === 'late-commit') yield* TestClock.adjust(source.protocol.inferenceValidityMs)
        }),
    }),
    Effect.result,
  )
  return Effect.runPromise(
    TestClock.setTime(Date.parse(source.snapshot.manifest.observedAt)).pipe(
      Effect.andThen(program),
      Effect.map((result) => ({ result, loaded, recorded })),
      Effect.provide(TestClock.layer()),
      Effect.provide(NodeServices.layer),
    ),
  )
}

test('native momentum records its source and derives an entry with no provider services installed', async () => {
  const { result, loaded, recorded } = await run('normal')
  expect(result._tag).toBe('Success')
  if (result._tag !== 'Success') throw result.failure
  expect(result.success.decision.selectedSymbols).toEqual(['AAPL'])
  expect(loaded).toBe(1)
  expect(recorded).toHaveLength(1)
  expect(Result.getOrThrow(canonicalHashV1Result(result.success.decision.evidence.observation))).toBe(
    recorded[0]?.contentHash,
  )
})

test('a committed window prevents fresh work after restart before source loading', async () => {
  const { result, loaded, recorded } = await run('repeat')
  expect(result._tag).toBe('Failure')
  if (result._tag !== 'Failure') throw new Error('Expected prior-window rejection')
  expect(result.failure._tag).toBe('JevAwaitingFreshWindow')
  expect(loaded).toBe(0)
  expect(recorded).toEqual([])
})

test('failed persistence and a late commit cannot authorize a momentum target or restart its deadline', async () => {
  const failed = await run('write-failure')
  expect(failed.result._tag).toBe('Failure')
  expect(failed.recorded).toEqual([])
  const late = await run('late-commit')
  expect(late.result._tag).toBe('Failure')
  expect(late.recorded).toHaveLength(1)
})
