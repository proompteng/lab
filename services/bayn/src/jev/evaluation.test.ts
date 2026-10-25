import { expect, test } from 'bun:test'
import { Effect, Fiber, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { JevClient, JevError } from './client'
import { JevFailure } from './contract'
import { JevOutcome, type JevEvaluationReceipt } from './evidence'
import { evaluateClaimedJevOnce, JevEvaluationStore, recoverExpiredJevEvaluation } from './evaluation'
import { JevResolutionStatus, makeJevResolution } from './resolution'
import { evaluationRequestFixture, inferenceFixture, responseFixture } from './test-support'

const request = evaluationRequestFixture()
const dispatch = { request, claimedAt: request.observedAt }
const memoryStore = () => {
  const receipts: JevEvaluationReceipt[] = []
  const store: JevEvaluationStore['Service'] = {
    read: () => Effect.die('Dispatch must use its committed admission'),
    record: (_, receipt) =>
      Effect.sync(() => {
        receipts.push(receipt)
        return Result.getOrThrow(
          makeJevResolution(request, receipt, {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: request.requestId,
            status: JevResolutionStatus.Recorded,
            receiptHash: receipt.receiptHash,
          }),
        )
      }),
    abandon: (_, abandonedAt) =>
      Effect.succeed(
        Result.getOrThrow(
          makeJevResolution(request, null, {
            schemaVersion: 'bayn.jev-evaluation-resolution.v1',
            requestId: request.requestId,
            status: JevResolutionStatus.Abandoned,
            abandonedAt,
          }),
        ),
      ),
  }
  return { store, receipts }
}

test('dispatch retains the provider answer before exposing a usable inference', async () => {
  const memory = memoryStore()
  const result = await Effect.runPromise(
    evaluateClaimedJevOnce(dispatch).pipe(
      Effect.provideService(JevEvaluationStore, memory.store),
      Effect.provideService(JevClient, { evaluate: () => Effect.succeed(inferenceFixture()) }),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(memory.receipts).toEqual([result.receipt])
  expect(result.inference).toEqual(inferenceFixture())
})

test('a claim whose commit crosses expiry retains a zero-cost undispatched receipt', async () => {
  const memory = memoryStore()
  const result = await Effect.runPromise(
    TestClock.setTime(Date.parse(request.expiresAt)).pipe(
      Effect.andThen(evaluateClaimedJevOnce(dispatch)),
      Effect.result,
      Effect.provideService(JevEvaluationStore, memory.store),
      Effect.provideService(JevClient, { evaluate: () => Effect.die('Expired dispatch must not call the provider') }),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(Result.isFailure(result)).toBe(true)
  expect(memory.receipts).toHaveLength(1)
  expect(memory.receipts[0]?.outcome).toMatchObject({ status: JevOutcome.Failed, failure: JevFailure.NotDispatched })
})

test.each(['invalid', request.expiresAt, '1969-12-31T23:59:59.999Z'])(
  'invalid claim time %s prevents provider I/O',
  async (claimedAt) => {
    const memory = memoryStore()
    const result = await Effect.runPromise(
      evaluateClaimedJevOnce({ request, claimedAt }).pipe(
        Effect.result,
        Effect.provideService(JevEvaluationStore, memory.store),
        Effect.provideService(JevClient, { evaluate: () => Effect.die('Invalid claim must not dispatch') }),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(memory.receipts).toEqual([])
  },
)

test('failed response bytes remain exact evidence', async () => {
  const memory = memoryStore()
  const rejected = responseFixture()
  rejected.answers.direction.probabilities = { favorable: 0.9, unfavorable: 0.02, unclear: 0.07 }
  const responseHash = Result.getOrThrow(canonicalHashV1Result(rejected))
  const result = await Effect.runPromise(
    evaluateClaimedJevOnce(dispatch).pipe(
      Effect.result,
      Effect.provideService(JevEvaluationStore, memory.store),
      Effect.provideService(JevClient, {
        evaluate: () =>
          Effect.fail(
            new JevError({
              failure: JevFailure.Response,
              message: 'invalid total',
              responseHash,
              rejectedResponse: Redacted.make(rejected),
            }),
          ),
      }),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(Result.isFailure(result)).toBe(true)
  expect(memory.receipts[0]?.outcome).toEqual({
    status: JevOutcome.Failed,
    failure: JevFailure.Response,
    httpStatus: null,
    responseHash,
    rejectedResponse: rejected,
  })
})

test('receipt persistence failure withholds the inference', async () => {
  const memory = memoryStore()
  const failure = operationalError({ component: 'database', operation: 'test', message: 'write failed' })
  const result = await Effect.runPromise(
    evaluateClaimedJevOnce(dispatch).pipe(
      Effect.result,
      Effect.provideService(JevEvaluationStore, { ...memory.store, record: () => Effect.fail(failure) }),
      Effect.provideService(JevClient, { evaluate: () => Effect.succeed(inferenceFixture()) }),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(Result.isFailure(result) && result.failure).toBe(failure)
})

test('timeout cancels inference and retains its failed receipt', async () => {
  const memory = memoryStore()
  let canceled = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* evaluateClaimedJevOnce(dispatch).pipe(
          Effect.result,
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* TestClock.adjust(Date.parse(request.expiresAt))
        expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true)
      }),
    ).pipe(
      Effect.provideService(JevEvaluationStore, memory.store),
      Effect.provideService(JevClient, {
        evaluate: () =>
          Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                canceled += 1
              }),
            ),
          ),
      }),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(canceled).toBe(1)
  expect(memory.receipts[0]?.outcome).toMatchObject({ status: JevOutcome.Failed, failure: JevFailure.Timeout })
})

test('interruption cancels the provider and leaves recovery to the committed claim', async () => {
  const memory = memoryStore()
  let canceled = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* evaluateClaimedJevOnce(dispatch).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
      }),
    ).pipe(
      Effect.provideService(JevEvaluationStore, memory.store),
      Effect.provideService(JevClient, {
        evaluate: () =>
          Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                canceled += 1
              }),
            ),
          ),
      }),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(canceled).toBe(1)
  expect(memory.receipts).toEqual([])
})

test('late evidence cannot replace abandonment or supply an entry', async () => {
  const memory = memoryStore()
  const resolution = Result.getOrThrow(
    makeJevResolution(request, null, {
      schemaVersion: 'bayn.jev-evaluation-resolution.v1',
      requestId: request.requestId,
      status: JevResolutionStatus.Abandoned,
      abandonedAt: request.expiresAt,
    }),
  )
  const result = await Effect.runPromise(
    evaluateClaimedJevOnce(dispatch).pipe(
      Effect.result,
      Effect.provideService(JevEvaluationStore, { ...memory.store, record: () => Effect.succeed(resolution) }),
      Effect.provideService(JevClient, { evaluate: () => Effect.succeed(inferenceFixture()) }),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(Result.isFailure(result)).toBe(true)
})

test('only expired requests may be abandoned', async () => {
  const memory = memoryStore()
  await Effect.runPromise(
    Effect.gen(function* () {
      expect(Result.isFailure(yield* recoverExpiredJevEvaluation(request).pipe(Effect.result))).toBe(true)
      yield* TestClock.setTime(Date.parse(request.expiresAt))
      expect((yield* recoverExpiredJevEvaluation(request)).resolution.status).toBe(JevResolutionStatus.Abandoned)
    }).pipe(Effect.provideService(JevEvaluationStore, memory.store), Effect.provide(TestClock.layer())),
  )
})
