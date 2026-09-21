import { expect, test } from 'bun:test'
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { canonicalHashV1OrThrow } from '../hash'
import { JevError, type JevClient } from '../jev/client'
import { JevFailure, jevModel, prepareJevRequest, type JevResponse } from '../jev/contract'
import { utcInstantFromEpochMillis } from '../time'
import { ReplayBrokerFailure } from './broker'
import { makeReplayJevTiming, type ReplayJevCall } from './jev-timing'

const request = (symbol: string) =>
  Result.getOrThrow(
    prepareJevRequest({
      model: jevModel,
      state: { symbol },
      questions: { enter: { type: 'noul', instructions: 'Assess the supplied trading state.' } },
    }),
  )
const response: JevResponse = {
  model: jevModel,
  answers: { enter: { type: 'noul', noul: 0.7 } },
  usage: { input_tokens: 100, output_tokens: 0 },
}
const providerAt = Date.parse('2026-09-21T12:00:00.000Z')
const marketAt = Date.parse('2026-09-04T14:00:02.000Z')

const fixture = Effect.gen(function* () {
  const providerClock = yield* TestClock.make()
  const marketClock = yield* TestClock.make()
  yield* providerClock.setTime(providerAt)
  yield* marketClock.setTime(marketAt)
  const calls: ReplayJevCall[] = []
  const marketArrivals: number[] = []
  const advanceTo = (atMs: number) =>
    Effect.gen(function* () {
      marketArrivals.push(atMs)
      yield* marketClock.setTime(atMs)
    })
  const retain = (call: ReplayJevCall) =>
    Effect.sync(() => {
      calls.push(call)
    })
  return { providerClock, marketClock, calls, marketArrivals, advanceTo, retain }
})

test('concurrent inference advances source time by elapsed batch time and preserves original provider receipts', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        const bothStarted = yield* Deferred.make<void>()
        const fastFinished = yield* Deferred.make<void>()
        const slow = yield* Deferred.make<void>()
        const fast = yield* Deferred.make<void>()
        const requests = [request('AAPL'), request('AMZN')]
        let startedCount = 0
        const provider: JevClient['Service'] = {
          evaluate: (raw) =>
            Effect.gen(function* () {
              const prepared = yield* Effect.fromResult(prepareJevRequest(raw)).pipe(Effect.orDie)
              const startedAt = yield* Clock.currentTimeMillis
              if (++startedCount === 2) yield* Deferred.succeed(bothStarted, undefined)
              yield* Deferred.await(prepared.requestHash === requests[0]?.requestHash ? slow : fast)
              return {
                requestHash: prepared.requestHash,
                responseHash: canonicalHashV1OrThrow(response),
                startedAt: utcInstantFromEpochMillis(startedAt),
                completedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
                response,
              }
            }),
        }
        const timing = yield* makeReplayJevTiming({ ...f, provider }).pipe(
          Effect.provideService(Clock.Clock, f.marketClock),
        )
        const fiber = yield* timing
          .run(
            Effect.gen(function* () {
              const values = yield* Effect.forEach(
                requests,
                (item, index) =>
                  timing.client
                    .evaluate(item.request)
                    .pipe(Effect.tap(() => (index === 1 ? Deferred.succeed(fastFinished, undefined) : Effect.void))),
                { concurrency: 2 },
              )
              yield* f.providerClock.setTime(providerAt + 1150)
              return values
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(bothStarted)
        yield* f.providerClock.setTime(providerAt + 700)
        yield* Deferred.succeed(fast, undefined)
        yield* Deferred.await(fastFinished)
        expect(yield* f.marketClock.currentTimeMillis).toBe(marketAt + 700)
        yield* f.providerClock.setTime(providerAt + 1000)
        yield* Deferred.succeed(slow, undefined)
        const values = yield* Fiber.join(fiber)
        return { values, calls: f.calls, marketArrivals: f.marketArrivals, now: yield* f.marketClock.currentTimeMillis }
      }),
    ),
  )
  expect(result.values.map((value) => value.startedAt)).toEqual([marketAt, marketAt].map(utcInstantFromEpochMillis))
  expect(result.values.map((value) => value.completedAt)).toEqual(
    [marketAt + 1000, marketAt + 700].map(utcInstantFromEpochMillis),
  )
  expect(result.now).toBe(marketAt + 1150)
  expect(result.calls.map((call) => call.providerCompletedAt)).toEqual(
    [providerAt + 700, providerAt + 1000].map(utcInstantFromEpochMillis),
  )
  expect(
    result.calls.every(
      (call) => call.outcome.status === 'RECEIVED' && call.outcome.inference.response.usage.input_tokens === 100,
    ),
  ).toBe(true)
  expect(result.marketArrivals).toEqual([...result.marketArrivals].sort((a, b) => a - b))
})

test('provider failures consume elapsed time and remain retained', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        const provider: JevClient['Service'] = {
          evaluate: () =>
            f.providerClock
              .setTime(providerAt + 250)
              .pipe(
                Effect.andThen(
                  Effect.fail(new JevError({ failure: JevFailure.Status, message: 'Rejected', status: 429 })),
                ),
              ),
        }
        const timing = yield* makeReplayJevTiming({ ...f, provider }).pipe(
          Effect.provideService(Clock.Clock, f.marketClock),
        )
        const outcome = yield* timing.run(timing.client.evaluate(request('AAPL').request).pipe(Effect.result))
        return { outcome, calls: f.calls, now: yield* f.marketClock.currentTimeMillis }
      }),
    ),
  )
  expect(Result.isFailure(result.outcome)).toBe(true)
  expect(result.now).toBe(marketAt + 250)
  expect(result.calls[0]?.outcome).toEqual({
    status: 'FAILED',
    failure: JevFailure.Status,
    httpStatus: 429,
    responseHash: null,
    rejectedResponse: null,
  })
})

test('failure to retain inference fails the replay even when the evaluator handles the provider error', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        const provider: JevClient['Service'] = {
          evaluate: () => Effect.fail(new JevError({ failure: JevFailure.Transport, message: 'Offline' })),
        }
        const timing = yield* makeReplayJevTiming({
          ...f,
          provider,
          retain: () => Effect.fail(new ReplayBrokerFailure({ message: 'Receipt disk unavailable' })),
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        return yield* timing
          .run(timing.client.evaluate(request('AAPL').request).pipe(Effect.result))
          .pipe(Effect.result)
      }),
    ),
  )
  expect(result).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ReplayBrokerFailure', message: 'Receipt disk unavailable' },
  })
})

test('cancellation stops the provider and preserves an unresolved paid-call receipt', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        const entered = yield* Deferred.make<void>()
        let finalized = false
        const provider: JevClient['Service'] = {
          evaluate: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.sync(() => {
                  finalized = true
                }),
              ),
            ),
        }
        const timing = yield* makeReplayJevTiming({ ...f, provider }).pipe(
          Effect.provideService(Clock.Clock, f.marketClock),
        )
        const fiber = yield* timing.run(timing.client.evaluate(request('AAPL').request)).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* f.providerClock.setTime(providerAt + 100)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        return { exit, finalized, calls: f.calls }
      }),
    ),
  )
  expect(result.finalized).toBe(true)
  expect(result.calls[0]?.outcome).toEqual({ status: 'INTERRUPTED' })
  expect(Exit.isFailure(result.exit) && Cause.hasInterrupts(result.exit.cause)).toBe(true)
})

test('a replay cannot reuse its frozen market clock for real inference', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        return yield* makeReplayJevTiming({
          ...f,
          providerClock: f.marketClock,
          provider: { evaluate: () => Effect.die('must not infer') },
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock), Effect.result)
      }),
    ),
  )
  expect(Result.isFailure(result)).toBe(true)
})

test('provider defects remain defects and retain their unresolved cost evidence', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        const timing = yield* makeReplayJevTiming({
          ...f,
          provider: { evaluate: () => Effect.die('provider defect') },
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        const exit = yield* timing.run(timing.client.evaluate(request('AAPL').request)).pipe(Effect.exit)
        return { exit, calls: f.calls }
      }),
    ),
  )
  expect(Exit.isFailure(result.exit) && Cause.hasDies(result.exit.cause)).toBe(true)
  expect(result.calls[0]?.outcome).toEqual({ status: 'DEFECT' })
})

test('a substituted response identity fails the replay after preserving the actual paid response', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        const timing = yield* makeReplayJevTiming({
          ...f,
          provider: {
            evaluate: () =>
              Effect.succeed({
                requestHash: request('AMZN').requestHash,
                responseHash: canonicalHashV1OrThrow(response),
                startedAt: utcInstantFromEpochMillis(providerAt),
                completedAt: utcInstantFromEpochMillis(providerAt),
                response,
              }),
          },
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        const outcome = yield* timing
          .run(timing.client.evaluate(request('AAPL').request).pipe(Effect.result))
          .pipe(Effect.result)
        return { outcome, calls: f.calls }
      }),
    ),
  )
  expect(result.outcome).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ReplayBrokerFailure' } })
  expect(result.calls).toHaveLength(1)
  expect(result.calls[0]?.outcome.status).toBe('RECEIVED')
})
