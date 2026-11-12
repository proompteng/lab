import { expect, test } from 'bun:test'
import { Effect, Layer, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { CandidateObservationStore } from '../observe-composition/candidate-observation'
import { JevBatchPlanVersion } from './batch'
import { JevBatchStore } from './batch-evaluation'
import { JevClient } from './client'
import { entryInferenceFixtureLayer } from './entry-inference.test-support'
import { JevEvaluationStore } from './evaluation'
import { JevInferenceWorkStore } from './inference-work'
import { nativeJevDecisionEvidence, nativeJevFixture } from './native.test-support'
import { evaluateJevObservationFromSnapshot } from './runtime'

const fixture = nativeJevFixture()
const evidence = nativeJevDecisionEvidence(fixture)
const saved = { plan: evidence.batchPlan, result: evidence.batchResult }
const baseLayer = Layer.mergeAll(
  entryInferenceFixtureLayer,
  Layer.succeed(JevBatchStore, {
    read: () => Effect.succeed(saved),
    pending: () => Effect.die('Completed streaming inference must not discover pending work'),
    begin: () => Effect.die('Completed streaming inference must not admit another batch'),
    finish: () => Effect.die('Completed streaming inference must not seal another batch'),
    complete: () => Effect.die('Completed streaming inference is already committed'),
  }),
  Layer.succeed(JevClient, { evaluate: () => Effect.die('Completed streaming inference cannot call the provider') }),
  Layer.succeed(JevEvaluationStore, {
    read: () => Effect.die('Resume uses committed batch evidence'),
    abandon: () => Effect.die('Resume cannot abandon inference'),
    recordAll: () => Effect.die('Resume cannot rewrite paid evidence'),
  }),
  Layer.succeed(CandidateObservationStore, {
    record: () => Effect.die('Resume cannot replace the original source'),
    latestJevWindowEnd: () => Effect.die('Resume must use the admitted window before discovering another'),
  }),
  Layer.succeed(JevInferenceWorkStore, {
    pending: () => Effect.die('Resume does not dispatch work'),
    settleExpired: () => Effect.die('Resume does not settle different expense work'),
    read: () => Effect.die('Resume starts with the cycle binding'),
    claim: () => Effect.die('Resume cannot reclaim provider work'),
    resume: (cycleId, generation) => {
      expect(cycleId).toBe(saved.plan.cycleId)
      expect(generation).toBe(saved.plan.authorityGenerationHash)
      return Effect.succeed({ batchId: saved.plan.batchId, observation: fixture.observation.payload })
    },
  }),
)

test('streaming completion resumes the original admitted source without rereading or rebasing its deadlines', async () => {
  const resumed = await Effect.runPromise(
    TestClock.setTime(Date.parse(evidence.decidedAt) + 1).pipe(
      Effect.andThen(
        evaluateJevObservationFromSnapshot(
          fixture.input,
          fixture.snapshot.manifest.rangeEndAt,
          Effect.die('Completed inference must not reload the current market snapshot'),
          JevBatchPlanVersion.V8,
        ),
      ),
      Effect.provide(baseLayer),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(resumed.evidence.observation).toEqual(fixture.observation.payload)
  expect(resumed.evidence.batchPlan).toEqual(saved.plan)
  expect(resumed.evidence.batchResult).toEqual(saved.result)
  expect(resumed.snapshot.manifest.contentHash).toBe(fixture.snapshot.manifest.contentHash)
  expect(resumed.evidence.batchPlan.observedAt).toBe(fixture.observation.payload.observedAt)
  expect(resumed.evidence.batchPlan.expiresAt).toBe(saved.plan.expiresAt)
})

test.each(['original inference expiry', 'current admission expiry', 'foreign protocol'])(
  'streaming completion fails closed after %s',
  async (scenario) => {
    const now =
      scenario === 'original inference expiry' ? Date.parse(saved.plan.expiresAt) : Date.parse(evidence.decidedAt) + 1
    const outcome = await Effect.runPromise(
      TestClock.setTime(now).pipe(
        Effect.andThen(
          evaluateJevObservationFromSnapshot(
            scenario === 'foreign protocol'
              ? {
                  ...fixture.input,
                  protocol: {
                    ...fixture.input.protocol,
                    inferenceValidityMs: fixture.input.protocol.inferenceValidityMs + 1,
                  },
                }
              : fixture.input,
            fixture.snapshot.manifest.rangeEndAt,
            Effect.die('Stale completion must not rebase its source'),
            JevBatchPlanVersion.V8,
            scenario === 'current admission expiry' ? { admissionDeadlineAt: now } : {},
          ),
        ),
        Effect.result,
        Effect.provide(baseLayer),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(Result.isFailure(outcome)).toBe(true)
    if (Result.isFailure(outcome)) expect(outcome.failure._tag).toBe('JevAwaitingEvidence')
  },
)
