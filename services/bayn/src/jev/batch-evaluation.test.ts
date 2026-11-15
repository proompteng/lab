import { expect, test } from 'bun:test'
import { Effect, Layer, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../effect-test-support'
import { operationalError, type OperationalError } from '../errors'
import { evaluateJevBatch, JevBatchExpired, JevBatchStore, type JevBatchAdmission } from './batch-evaluation'
import { JevClient } from './client'
import { entryInferenceFixtureLayer } from './entry-inference.test-support'
import { JevEvaluationStore } from './evaluation'
import { nativeJevDecisionEvidence, nativeJevFixture } from './native.test-support'

const source = nativeJevFixture()
const evidence = nativeJevDecisionEvidence(source)
const plan = evidence.batchPlan
const completed = { plan, result: evidence.batchResult }

const fixture = (admission: Effect.Effect<JevBatchAdmission, OperationalError | JevBatchExpired>) => {
  const calls = { begin: 0, finish: 0, provider: 0 }
  const forbidden = () => Effect.die('Admission cannot execute provider or expense completion work')
  const layer = Layer.mergeAll(
    entryInferenceFixtureLayer,
    Layer.succeed(JevBatchStore, {
      read: forbidden,
      pending: forbidden,
      begin: () =>
        Effect.sync(() => {
          calls.begin += 1
        }).pipe(Effect.andThen(admission)),
      finish: () =>
        Effect.sync(() => {
          calls.finish += 1
          return completed
        }),
      complete: forbidden,
    }),
    Layer.succeed(JevClient, {
      evaluate: () =>
        Effect.sync(() => {
          calls.provider += 1
        }).pipe(Effect.andThen(forbidden())),
    }),
    Layer.succeed(JevEvaluationStore, { read: forbidden, abandon: forbidden, recordAll: forbidden }),
    TestClock.layer(),
  )
  return {
    calls,
    evaluate: (at = Date.parse(plan.observedAt)) =>
      provideTestLayer(
        TestClock.setTime(at).pipe(Effect.andThen(evaluateJevBatch(plan, source.observation.payload))),
        layer,
      ),
  }
}

test('fresh deferred admission returns pending work without finalization or provider calls', async () => {
  const f = fixture(Effect.succeed({ plan, result: null, dispatches: null }))
  const pending = await Effect.runPromise(f.evaluate())
  expect(pending).toEqual({ plan, result: null })
  expect(f.calls).toEqual({ begin: 1, finish: 0, provider: 0 })
})

test('existing empty dispatch rights still recover their committed evidence exactly once', async () => {
  const f = fixture(Effect.succeed({ plan, result: null, dispatches: [] }))
  const recovered = await Effect.runPromise(f.evaluate())
  expect(recovered).toEqual(completed)
  expect(recovered.result?.resultHash).toBe(evidence.batchResult.resultHash)
  expect(f.calls).toEqual({ begin: 1, finish: 1, provider: 0 })
})

test.each([{ dispatches: [] }, { dispatches: null }])(
  'completed admission returns retained evidence without finalization ($dispatches)',
  async ({ dispatches }) => {
    const f = fixture(Effect.succeed({ ...completed, dispatches }))
    expect(await Effect.runPromise(f.evaluate())).toEqual(completed)
    expect(f.calls).toEqual({ begin: 1, finish: 0, provider: 0 })
  },
)

test.each([
  operationalError({ component: 'database', operation: 'jev-batch', message: 'Admission did not commit' }),
  new JevBatchExpired({
    batchId: plan.batchId,
    cycleId: plan.cycleId,
    observedAt: plan.observedAt,
    expiresAt: plan.expiresAt,
    checkedAt: plan.expiresAt,
  }),
])('failed admission cannot finalize or dispatch: $_tag', async (failure) => {
  const f = fixture(Effect.fail(failure))
  const result = await Effect.runPromise(f.evaluate().pipe(Effect.result))
  expect(result).toEqual(Result.fail(failure))
  expect(f.calls).toEqual({ begin: 1, finish: 0, provider: 0 })
})

test('expiry after durable deferral preserves the original deadline for its expense owner', async () => {
  const f = fixture(Effect.succeed({ plan, result: null, dispatches: null }))
  const pending = await Effect.runPromise(f.evaluate(Date.parse(plan.expiresAt) + 1))
  expect(pending.plan.expiresAt).toBe(plan.expiresAt)
  expect(pending.result).toBeNull()
  expect(f.calls).toEqual({ begin: 1, finish: 0, provider: 0 })
})
