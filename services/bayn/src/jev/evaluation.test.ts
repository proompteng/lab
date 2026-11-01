import { admitAndEvaluateFixture } from './evaluation.test-support'
import { expect, test } from 'bun:test'
import { Effect, Fiber, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { operationalError } from '../errors'
import { canonicalHashV1Result } from '../hash'
import { JevClient, JevError } from './client'
import { JevFailure } from './contract'
import { JevOutcome, type JevEvaluationReceipt } from './evidence'
import { JevEvaluationStore, makeJevDispatch, recoverExpiredJevEvaluation } from './evaluation'
import { JevResolutionStatus, makeJevResolution } from './resolution'
import { evaluationRequestFixture } from './test-support'
import { entryCompletionFixture, entryInferenceFixtureLayer } from './entry-inference.test-support'

const request = evaluationRequestFixture()
const completion = entryCompletionFixture(request)
if (completion.jev.status !== 'RECEIVED') throw Error('Fixture requires Jev receipt')
const inference = completion.jev.inference
const dispatch = { request, claimedAt: request.observedAt }
const memoryStore = () => {
  const receipts: JevEvaluationReceipt[] = []
  const store: JevEvaluationStore['Service'] = {
    read: () => Effect.die('Dispatch must use its committed admission'),
    recordAll: (entries) =>
      Effect.forEach(entries, ({ request: source, receipt }) =>
        Effect.sync(() => {
          receipts.push(receipt)
          return [
            source.requestId,
            Result.getOrThrow(
              makeJevResolution(request, receipt, {
                schemaVersion: 'bayn.jev-evaluation-resolution.v1',
                requestId: request.requestId,
                status: JevResolutionStatus.Recorded,
                receiptHash: receipt.receiptHash,
              }),
            ),
          ] as const
        }),
      ).pipe(Effect.map((records) => new Map(records))),
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

test('copies of one admitted dispatch share its single-use provider right', async () => {
  const dispatch = makeJevDispatch({ request, claimedAt: request.observedAt, visualClaim: null })
  const copy = { ...dispatch }
  const results = await Effect.runPromise(
    Effect.all([dispatch.consume.pipe(Effect.result), copy.consume.pipe(Effect.result)], { concurrency: 2 }),
  )
  expect(results.filter(Result.isSuccess)).toHaveLength(1)
  expect(results.filter(Result.isFailure)).toHaveLength(1)
})

test('dispatch retains the provider answer before exposing a usable inference', async () => {
  const memory = memoryStore()
  const result = await Effect.runPromise(
    admitAndEvaluateFixture(dispatch).pipe(
      Effect.provideService(JevEvaluationStore, memory.store),
      Effect.provideService(JevClient, { evaluate: () => Effect.succeed(inference) }),
      Effect.provide(entryInferenceFixtureLayer),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(memory.receipts).toEqual([result.receipt])
  expect(result.inference).toEqual(completion)
})

test('a claim whose commit crosses expiry remains unavailable without provider I/O', async () => {
  const memory = memoryStore()
  const result = await Effect.runPromise(
    TestClock.setTime(Date.parse(request.expiresAt)).pipe(
      Effect.andThen(admitAndEvaluateFixture(dispatch)),
      Effect.result,
      Effect.provideService(JevEvaluationStore, memory.store),
      Effect.provideService(JevClient, { evaluate: () => Effect.die('Expired dispatch must not call the provider') }),
      Effect.provide(entryInferenceFixtureLayer),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(Result.isFailure(result)).toBe(true)
  expect(memory.receipts).toEqual([])
})

test.each(['invalid', request.expiresAt, '1969-12-31T23:59:59.999Z'])(
  'invalid claim time %s prevents provider I/O',
  async (claimedAt) => {
    const memory = memoryStore()
    const result = await Effect.runPromise(
      admitAndEvaluateFixture({ request, claimedAt }).pipe(
        Effect.result,
        Effect.provideService(JevEvaluationStore, memory.store),
        Effect.provideService(JevClient, { evaluate: () => Effect.die('Invalid claim must not dispatch') }),
        Effect.provide(entryInferenceFixtureLayer),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    expect(memory.receipts).toEqual([])
  },
)

test('failed response bytes remain exact evidence', async () => {
  const memory = memoryStore()
  const rejected = { ...inference.response, answers: { invalid: { type: 'noul', noul: 2 } } }
  const responseHash = Result.getOrThrow(canonicalHashV1Result(rejected))
  const result = await Effect.runPromise(
    admitAndEvaluateFixture(dispatch).pipe(
      Effect.result,
      Effect.provideService(JevEvaluationStore, memory.store),
      Effect.provideService(JevClient, {
        evaluate: () =>
          Effect.fail(
            new JevError({
              failure: JevFailure.Response,
              message: 'invalid answer',
              requestHash: inference.requestHash,
              responseHash,
              rejectedResponse: Redacted.make(rejected),
            }),
          ),
      }),
      Effect.provide(entryInferenceFixtureLayer),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(Result.isFailure(result)).toBe(true)
  expect(memory.receipts[0]?.outcome).toMatchObject({
    status: JevOutcome.Completed,
    completion: {
      jev: { status: 'FAILED', failure: JevFailure.Response, httpStatus: null, responseHash, usage: rejected.usage },
    },
  })
})

test('receipt persistence failure withholds the inference', async () => {
  const memory = memoryStore()
  const failure = operationalError({ component: 'database', operation: 'test', message: 'write failed' })
  const result = await Effect.runPromise(
    admitAndEvaluateFixture(dispatch).pipe(
      Effect.result,
      Effect.provideService(JevEvaluationStore, { ...memory.store, recordAll: () => Effect.fail(failure) }),
      Effect.provideService(JevClient, { evaluate: () => Effect.succeed(inference) }),
      Effect.provide(entryInferenceFixtureLayer),
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
        const fiber = yield* admitAndEvaluateFixture(dispatch).pipe(
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
      Effect.provide(entryInferenceFixtureLayer),
      Effect.provide(TestClock.layer()),
    ),
  )
  expect(canceled).toBe(1)
  expect(memory.receipts[0]?.outcome).toMatchObject({
    status: JevOutcome.Completed,
    completion: { jev: { status: 'FAILED', failure: JevFailure.Timeout } },
  })
})

test('interruption cancels the provider and leaves recovery to the committed claim', async () => {
  const memory = memoryStore()
  let canceled = 0
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* admitAndEvaluateFixture(dispatch).pipe(Effect.forkScoped({ startImmediately: true }))
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
      Effect.provide(entryInferenceFixtureLayer),
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
    admitAndEvaluateFixture(dispatch).pipe(
      Effect.result,
      Effect.provideService(JevEvaluationStore, {
        ...memory.store,
        recordAll: () => Effect.succeed(new Map([[request.requestId, resolution]])),
      }),
      Effect.provideService(JevClient, { evaluate: () => Effect.succeed(inference) }),
      Effect.provide(entryInferenceFixtureLayer),
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
    }).pipe(
      Effect.provideService(JevEvaluationStore, memory.store),
      Effect.provide(entryInferenceFixtureLayer),
      Effect.provide(TestClock.layer()),
    ),
  )
})
