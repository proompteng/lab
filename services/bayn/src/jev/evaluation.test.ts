import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Fiber, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { operationalError } from '../errors'
import { canonicalHashV1 } from '../hash'
import { JevClient, JevError } from './client'
import { JevFailure } from './contract'
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  JevOutcome,
  makeJevEvaluationReceipt,
  type JevEvaluationReceipt,
} from './evidence'
import { evaluateJevOnce, JevClaim, JevEvaluationStore } from './evaluation'
import { evaluationRequestFixture, inferenceFixture, responseFixture } from './test-support'

const request = evaluationRequestFixture()
const fixtureReceipt = () =>
  Result.getOrThrow(
    makeJevEvaluationReceipt(request, {
      schemaVersion: 'bayn.jev-evaluation-receipt.v1',
      requestId: request.requestId,
      startedAt: request.observedAt,
      completedAt: request.observedAt,
      outcome: { status: JevOutcome.Received, inference: inferenceFixture() },
    }),
  )

const memoryStore = () => {
  let claimed = false
  let receipt: JevEvaluationReceipt | undefined
  let recordings = 0
  const store: typeof JevEvaluationStore.Service = {
    begin: () =>
      Effect.sync(() => {
        if (receipt !== undefined) return { status: JevClaim.Recorded, receipt }
        if (claimed) return { status: JevClaim.Pending }
        claimed = true
        return { status: JevClaim.Acquired }
      }),
    record: (_, value) =>
      Effect.sync(() => {
        receipt = value
        recordings += 1
      }),
  }
  return { store, receipt: () => receipt, recordings: () => recordings }
}

describe('durable Jev evaluation', () => {
  test('rejects changed request content, oversized validity and forged identity', () => {
    for (const invalid of [
      { ...request, requestId: 'd'.repeat(64) },
      { ...request, request: { ...request.request, state: { changed: true } } },
      { ...request, expiresAt: '1970-01-01T00:00:20.000Z' },
    ])
      expect(Result.isFailure(decodeJevEvaluationRequest(invalid))).toBe(true)
  })

  test('replays the durable answer and never invokes the provider a second time', async () => {
    const memory = memoryStore()
    let calls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* evaluateJevOnce(request)
        expect(memory.recordings()).toBe(1)
        const second = yield* evaluateJevOnce(request)
        expect(second).toEqual(first)
        expect(calls).toBe(1)
        expect(memory.recordings()).toBe(1)
      }).pipe(
        Effect.provideService(JevEvaluationStore, memory.store),
        Effect.provideService(JevClient, {
          evaluate: () =>
            Effect.sync(() => {
              calls += 1
              return inferenceFixture()
            }),
        }),
        Effect.provide(TestClock.layer()),
      ),
    )
  })

  test('concurrent and interrupted evaluation cannot issue another inference', async () => {
    const memory = memoryStore()
    let calls = 0
    let stopped = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* evaluateJevOnce(request).pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Effect.yieldNow
          expect(calls).toBe(1)
          expect(Result.isFailure(yield* evaluateJevOnce(request).pipe(Effect.result))).toBe(true)
          yield* Fiber.interrupt(first)
          expect(Result.isFailure(yield* evaluateJevOnce(request).pipe(Effect.result))).toBe(true)
          expect(calls).toBe(1)
          expect(stopped).toBe(1)
          expect(memory.receipt()).toBeUndefined()
        }),
      ).pipe(
        Effect.provideService(JevEvaluationStore, memory.store),
        Effect.provideService(JevClient, {
          evaluate: () =>
            Effect.sync(() => {
              calls += 1
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  stopped += 1
                }),
              ),
            ),
        }),
        Effect.provide(TestClock.layer()),
      ),
    )
  })

  test('retains failed response evidence without normalizing it or retrying', async () => {
    const memory = memoryStore()
    const rejected = responseFixture()
    rejected.answers.direction.probabilities = { favorable: 0.9, unfavorable: 0.02, unclear: 0.07 }
    let calls = 0
    await Effect.runPromise(
      Effect.gen(function* () {
        expect(Result.isFailure(yield* evaluateJevOnce(request).pipe(Effect.result))).toBe(true)
        expect(memory.receipt()?.outcome).toEqual({
          status: JevOutcome.Failed,
          failure: JevFailure.Response,
          httpStatus: null,
          responseHash: canonicalHashV1(rejected),
          rejectedResponse: rejected,
        })
        expect(Result.isFailure(yield* evaluateJevOnce(request).pipe(Effect.result))).toBe(true)
        expect(calls).toBe(1)
      }).pipe(
        Effect.provideService(JevEvaluationStore, memory.store),
        Effect.provideService(JevClient, {
          evaluate: () =>
            Effect.sync(() => {
              calls += 1
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new JevError({
                    failure: JevFailure.Response,
                    message: 'invalid probability total',
                    responseHash: canonicalHashV1(rejected),
                    rejectedResponse: Redacted.make(rejected),
                  }),
                ),
              ),
            ),
        }),
        Effect.provide(TestClock.layer()),
      ),
    )
  })

  test('persistence failure withholds the model decision and leaves the claim unresolved', async () => {
    const memory = memoryStore()
    let calls = 0
    const failure = operationalError({ component: 'database', operation: 'test', message: 'write failed' })
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* evaluateJevOnce(request).pipe(Effect.result)
        expect(Result.isFailure(result) && result.failure).toBe(failure)
        expect(Result.isFailure(yield* evaluateJevOnce(request).pipe(Effect.result))).toBe(true)
        expect(calls).toBe(1)
      }).pipe(
        Effect.provideService(JevEvaluationStore, { ...memory.store, record: () => Effect.fail(failure) }),
        Effect.provideService(JevClient, {
          evaluate: () =>
            Effect.sync(() => {
              calls += 1
              return inferenceFixture()
            }),
        }),
        Effect.provide(TestClock.layer()),
      ),
    )
  })

  test('blocks provider calls if the request expires during request persistence', async () => {
    let calls = 0
    const result = await Effect.runPromise(
      evaluateJevOnce(request).pipe(
        Effect.result,
        Effect.provideService(JevEvaluationStore, {
          ...memoryStore().store,
          begin: () => TestClock.adjust(5000).pipe(Effect.as({ status: JevClaim.Acquired as const })),
        }),
        Effect.provideService(JevClient, {
          evaluate: () =>
            Effect.sync(() => {
              calls += 1
              return inferenceFixture()
            }),
        }),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(calls).toBe(0)
  })

  test('cancels inference at the remaining request deadline and durably records the timeout', async () => {
    const memory = memoryStore()
    let calls = 0
    let stopped = 0
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.adjust(4900)
          yield* evaluateJevOnce(request).pipe(Effect.result, Effect.forkScoped({ startImmediately: true }))
          yield* Effect.yieldNow
          expect(calls).toBe(1)
          yield* TestClock.adjust(99)
          expect(stopped).toBe(0)
          expect(memory.receipt()).toBeUndefined()
          yield* TestClock.adjust(1)
          yield* Effect.yieldNow
          expect(stopped).toBe(1)
          expect(memory.recordings()).toBe(1)
          expect(memory.receipt()?.completedAt).toBe(request.expiresAt)
          expect(memory.receipt()?.outcome).toEqual({
            status: JevOutcome.Failed,
            failure: JevFailure.Timeout,
            httpStatus: null,
            responseHash: null,
            rejectedResponse: null,
          })
          expect(Result.isFailure(yield* evaluateJevOnce(request).pipe(Effect.result))).toBe(true)
          expect(calls).toBe(1)
        }),
      ).pipe(
        Effect.provideService(JevEvaluationStore, memory.store),
        Effect.provideService(JevClient, {
          evaluate: () =>
            Effect.sync(() => {
              calls += 1
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  stopped += 1
                }),
              ),
            ),
        }),
        Effect.provide(TestClock.layer()),
      ),
    )
  })

  test('retains a response but withholds entry if receipt persistence crosses expiry', async () => {
    const memory = memoryStore()
    const result = await Effect.runPromise(
      evaluateJevOnce(request).pipe(
        Effect.result,
        Effect.provideService(JevEvaluationStore, {
          ...memory.store,
          record: (request, receipt) =>
            memory.store.record(request, receipt).pipe(Effect.andThen(TestClock.adjust(5000))),
        }),
        Effect.provideService(JevClient, { evaluate: () => Effect.succeed(inferenceFixture()) }),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(memory.receipt()?.outcome.status).toBe(JevOutcome.Received)
  })

  test('verifies response, request and receipt hashes on replay', () => {
    const receipt = fixtureReceipt()
    expect(Result.isSuccess(decodeJevEvaluationReceipt(request, receipt))).toBe(true)
    for (const invalid of [
      { ...receipt, receiptHash: 'd'.repeat(64) },
      { ...receipt, requestId: 'd'.repeat(64) },
      { ...receipt, completedAt: '1969-12-31T23:59:59.000Z' },
      {
        ...receipt,
        outcome: { status: JevOutcome.Received, inference: { ...inferenceFixture(), responseHash: 'd'.repeat(64) } },
      },
    ])
      expect(Result.isFailure(decodeJevEvaluationReceipt(request, invalid))).toBe(true)
  })

  test('propagates provider defects without recording a fabricated failure', async () => {
    const memory = memoryStore()
    const defect = new Error('test defect')
    const exit = await Effect.runPromiseExit(
      evaluateJevOnce(request).pipe(
        Effect.provideService(JevEvaluationStore, memory.store),
        Effect.provideService(JevClient, { evaluate: () => Effect.die(defect) }),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(defect)
    expect(memory.receipt()).toBeUndefined()
  })
})
