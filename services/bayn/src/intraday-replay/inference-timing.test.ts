import { chartProviderFixture } from '../jev/entry-inference.test-support'
import { entryEvaluationRequestFixture, nativeChartInference } from '../jev/entry-inference.test-support'
import { nativeJevInference } from '../jev/native.test-support'
import { DecisionsClient } from '../jev/decisions'
import { JevClient } from '../jev/client'
import { EntryInferenceJournal, evaluateClaimedEntryInference } from '../jev/entry-inference'
import { expect, test } from 'bun:test'
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result } from '../hash'
import { JevError } from '../jev/client'
import { JevFailure, jevModel, prepareJevRequest, type JevResponse } from '../jev/contract'
import { utcInstantFromEpochMillis } from '../time'
import { ReplayBrokerFailure } from './broker'
import { makeReplayInferenceBudget, makeReplayInferenceTiming, type ReplayInferenceCall } from './inference-timing'

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

test('a frozen shared replay budget bounds concurrent provider dispatches and never refunds claims', async () => {
  const budget = makeReplayInferenceBudget(2)
  const outcomes = await Effect.runPromise(
    Effect.all(
      Array.from({ length: 10 }, () => budget.claim.pipe(Effect.result)),
      { concurrency: 'unbounded' },
    ),
  )
  expect(outcomes.filter(Result.isSuccess)).toHaveLength(2)
  expect(outcomes.filter(Result.isFailure)).toHaveLength(8)
  expect(budget.dispatchCount()).toBe(2)
})

test('interrupting a provider retains its consumed replay budget', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const budget = makeReplayInferenceBudget(1)
      let stopped = false
      const first = yield* budget.claim.pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            stopped = true
          }),
        ),
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(first)
      expect(stopped).toBe(true)
      expect(budget.dispatchCount()).toBe(1)
      expect(yield* budget.claim.pipe(Effect.result)).toMatchObject({ _tag: 'Failure' })
    }),
  )
})

const fixture = Effect.gen(function* () {
  const providerClock = yield* TestClock.make()
  const marketClock = yield* TestClock.make()
  yield* providerClock.setTime(providerAt)
  yield* marketClock.setTime(marketAt)
  const calls: ReplayInferenceCall[] = []
  const marketArrivals: number[] = []
  const advanceTo = (atMs: number) =>
    Effect.gen(function* () {
      marketArrivals.push(atMs)
      yield* marketClock.setTime(atMs)
    })
  const retain = (call: ReplayInferenceCall) =>
    Effect.sync(() => {
      calls.push(call)
    })
  const measureDatabaseTime = <A, E, R>(operation: Effect.Effect<A, E, R>) => operation
  return {
    providerClock,
    marketClock,
    calls,
    marketArrivals,
    advanceTo,
    advanceDeadlineTo: advanceTo,
    excludedSourceMillis: Effect.succeed(0),
    retain,
    measureDatabaseTime,
  }
})

test('provider receipts start after measured clock synchronization', async () => {
  const calls = await Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture
      const timing = yield* makeReplayInferenceTiming({
        budget: makeReplayInferenceBudget(1000),
        ...f,
        advanceDeadlineTo: (atMs) => f.advanceDeadlineTo(atMs).pipe(Effect.andThen(f.providerClock.adjust(30))),
        providers: {
          jev: {
            evaluate: (raw) =>
              Effect.gen(function* () {
                const prepared = Result.getOrThrow(prepareJevRequest(raw))
                const startedAt = yield* Clock.currentTimeMillis
                yield* f.providerClock.adjust(50)
                return {
                  requestHash: prepared.requestHash,
                  responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
                  startedAt: utcInstantFromEpochMillis(startedAt),
                  completedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
                  response,
                }
              }),
          },
          chart: chartProviderFixture,
        },
      }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
      const inference = yield* timing.run(timing.clients.jev.evaluate(request('AAPL').request, 10_000))
      expect(inference.startedAt).toBe(utcInstantFromEpochMillis(marketAt + 30))
      return f.calls
    }).pipe(Effect.scoped),
  )
  expect(calls[0]?.providerStartedAt).toBe(utcInstantFromEpochMillis(providerAt + 30))
  expect(calls[0]?.providerCompletedAt).toBe(utcInstantFromEpochMillis(providerAt + 80))
  expect(calls[0]?.simulatedStartedAt).toBe(utcInstantFromEpochMillis(marketAt + 30))
})

test.each([-1, 1.5, 101])('invalid source exclusion %sms fails the replay', async (excludedMs) => {
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture
      let excluded = 0
      const timing = yield* makeReplayInferenceTiming({
        budget: makeReplayInferenceBudget(1000),
        ...f,
        excludedSourceMillis: Effect.sync(() => excluded),
        providers: {
          jev: { evaluate: () => Effect.die('This clock regression does not infer') },
          chart: chartProviderFixture,
        },
      }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
      return yield* timing
        .run(
          Effect.gen(function* () {
            yield* f.providerClock.adjust(100)
            excluded = excludedMs
            return yield* timing.currentUtcInstant
          }),
        )
        .pipe(Effect.exit)
    }).pipe(Effect.scoped),
  )
  expect(Exit.isFailure(exit)).toBe(true)
})

test('source parsing cannot consume native decision time while persistence work still does', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture
      let excludedSourceMillis = 0
      const timing = yield* makeReplayInferenceTiming({
        budget: makeReplayInferenceBudget(1000),
        ...f,
        providers: {
          jev: { evaluate: () => Effect.die('This clock regression does not infer') },
          chart: chartProviderFixture,
        },
        excludedSourceMillis: Effect.sync(() => excludedSourceMillis),
        advanceTo: (atMs) =>
          f.advanceTo(atMs).pipe(
            Effect.andThen(f.providerClock.adjust(5000)),
            Effect.tap(() =>
              Effect.sync(() => {
                excludedSourceMillis += 5000
              }),
            ),
          ),
      }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
      return yield* timing.run(
        Effect.gen(function* () {
          yield* f.providerClock.adjust(20)
          const before = yield* timing.currentUtcInstant
          yield* f.providerClock.adjust(30)
          const after = yield* timing.currentUtcInstant
          return { before, after, sourceCut: f.marketArrivals.at(-1) }
        }),
      )
    }).pipe(Effect.scoped),
  )
  expect(result.before).toBe(utcInstantFromEpochMillis(marketAt + 20))
  expect(result.after).toBe(utcInstantFromEpochMillis(marketAt + 50))
  expect(result.sourceCut).toBe(marketAt + 50)
})

test('reconciliation timestamps stay on the published source clock when advancing arrivals consumes time', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture
      const timing = yield* makeReplayInferenceTiming({
        budget: makeReplayInferenceBudget(1000),
        ...f,
        providers: {
          jev: { evaluate: () => Effect.die('This clock regression does not infer') },
          chart: chartProviderFixture,
        },
        advanceTo: (atMs) => f.advanceTo(atMs).pipe(Effect.andThen(f.providerClock.adjust(5))),
      }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
      const observations = yield* timing.run(
        Effect.gen(function* () {
          yield* f.providerClock.adjust(20)
          const reconciledAt = yield* timing.currentUtcInstant
          const observationAt = utcInstantFromEpochMillis(yield* f.marketClock.currentTimeMillis)
          const nextReconciliationAt = yield* timing.currentUtcInstant
          const nextObservationAt = utcInstantFromEpochMillis(yield* f.marketClock.currentTimeMillis)
          return { reconciledAt, observationAt, nextReconciliationAt, nextObservationAt }
        }),
      )
      return { ...observations, now: yield* f.marketClock.currentTimeMillis }
    }).pipe(Effect.scoped),
  )
  expect(result.reconciledAt).toBe(result.observationAt)
  expect(result.nextReconciliationAt).toBe(result.nextObservationAt)
  expect(Date.parse(result.nextReconciliationAt) - Date.parse(result.reconciledAt)).toBe(10)
  expect(result.now).toBe(marketAt + 40)
})

test('failed operations still publish the final source cut after measurement cleanup', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture
      const failure = new ReplayBrokerFailure({ message: 'Runtime failed' })
      const timing = yield* makeReplayInferenceTiming({
        budget: makeReplayInferenceBudget(1000),
        ...f,
        providers: {
          jev: { evaluate: () => Effect.die('This cleanup regression does not infer') },
          chart: chartProviderFixture,
        },
        measureDatabaseTime: (operation) => operation.pipe(Effect.ensuring(f.marketClock.adjust(25))),
      }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
      const exit = yield* timing.run(Effect.fail(failure)).pipe(Effect.result)
      return { exit, sourceCut: f.marketArrivals.at(-1), now: yield* f.marketClock.currentTimeMillis }
    }).pipe(Effect.scoped),
  )
  expect(result.exit).toMatchObject({ _tag: 'Failure', failure: { message: 'Runtime failed' } })
  expect(result.sourceCut).toBe(marketAt + 25)
  expect(result.sourceCut).toBe(result.now)
})

test('failure to publish the cleanup source cut fails an otherwise successful replay operation', async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture
      const timing = yield* makeReplayInferenceTiming({
        budget: makeReplayInferenceBudget(1000),
        ...f,
        providers: {
          jev: { evaluate: () => Effect.die('This cleanup regression does not infer') },
          chart: chartProviderFixture,
        },
        measureDatabaseTime: (operation) => operation.pipe(Effect.ensuring(f.marketClock.adjust(25))),
        advanceTo: (atMs) =>
          atMs > marketAt
            ? Effect.fail(new ReplayBrokerFailure({ message: 'Closing source unavailable' }))
            : f.advanceTo(atMs),
      }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
      return yield* timing.run(Effect.void).pipe(Effect.result)
    }).pipe(Effect.scoped),
  )
  expect(result).toMatchObject({ _tag: 'Failure', failure: { message: 'Closing source unavailable' } })
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
        let activeCalls = 0
        let sourceAdvancedDuringInference = false
        const provider: JevClient['Service'] = {
          evaluate: (raw) =>
            Effect.gen(function* () {
              const prepared = yield* Effect.fromResult(prepareJevRequest(raw)).pipe(Effect.orDie)
              const startedAt = yield* Clock.currentTimeMillis
              activeCalls++
              if (++startedCount === 2) yield* Deferred.succeed(bothStarted, undefined)
              yield* Deferred.await(prepared.requestHash === requests[0]?.requestHash ? slow : fast)
              activeCalls--
              return {
                requestHash: prepared.requestHash,
                responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
                startedAt: utcInstantFromEpochMillis(startedAt),
                completedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
                response,
              }
            }),
        }
        const timing = yield* makeReplayInferenceTiming({
          budget: makeReplayInferenceBudget(1000),
          ...f,
          providers: { jev: provider, chart: chartProviderFixture },
          advanceTo: (atMs) =>
            Effect.sync(() => {
              if (activeCalls > 0) sourceAdvancedDuringInference = true
            }).pipe(Effect.andThen(f.advanceTo(atMs))),
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        const fiber = yield* timing
          .run(
            Effect.gen(function* () {
              const values = yield* Effect.forEach(
                requests,
                (item, index) =>
                  timing.clients.jev
                    .evaluate(item.request, 10_000)
                    .pipe(Effect.tap(() => (index === 1 ? Deferred.succeed(fastFinished, undefined) : Effect.void))),
                { concurrency: 2 },
              )
              yield* f.providerClock.setTime(providerAt + 1150)
              return values
            }),
          )
          .pipe(Effect.forkChild)
        yield* Deferred.await(bothStarted)
        expect(yield* timing.currentUtcInstant.pipe(Effect.result)).toMatchObject({
          _tag: 'Failure',
          failure: { message: 'Cannot publish replay source while inference is active' },
        })
        yield* f.providerClock.setTime(providerAt + 700)
        yield* Deferred.succeed(fast, undefined)
        yield* Deferred.await(fastFinished)
        expect(yield* f.marketClock.currentTimeMillis).toBe(marketAt + 700)
        yield* f.providerClock.setTime(providerAt + 1000)
        yield* Deferred.succeed(slow, undefined)
        const values = yield* Fiber.join(fiber)
        return {
          values,
          calls: f.calls,
          marketArrivals: f.marketArrivals,
          now: yield* f.marketClock.currentTimeMillis,
          sourceAdvancedDuringInference,
        }
      }),
    ),
  )
  expect(result.values.map((value) => value.startedAt)).toEqual([marketAt, marketAt].map(utcInstantFromEpochMillis))
  expect(result.values.map((value) => value.completedAt)).toEqual(
    [marketAt + 1000, marketAt + 700].map(utcInstantFromEpochMillis),
  )
  expect(result.now).toBe(marketAt + 1150)
  expect(result.sourceAdvancedDuringInference).toBeFalse()
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
        const timing = yield* makeReplayInferenceTiming({
          budget: makeReplayInferenceBudget(1000),
          ...f,
          providers: { jev: provider, chart: chartProviderFixture },
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        const outcome = yield* timing.run(
          timing.clients.jev.evaluate(request('AAPL').request, 10_000).pipe(Effect.result),
        )
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

test('payment-required receipts stop the replay even when native evaluation handles the provider error', async () => {
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture
        let providerCalls = 0
        const provider: JevClient['Service'] = {
          evaluate: () =>
            Effect.suspend(() => {
              providerCalls++
              return Effect.fail(new JevError({ failure: JevFailure.Status, message: 'Payment required', status: 402 }))
            }),
        }
        const timing = yield* makeReplayInferenceTiming({
          budget: makeReplayInferenceBudget(1000),
          ...f,
          providers: { jev: provider, chart: chartProviderFixture },
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        const outcome = yield* timing
          .run(
            Effect.forEach(['AAPL', 'AMD'], (symbol) =>
              timing.clients.jev.evaluate(request(symbol).request, 10_000).pipe(Effect.result),
            ),
          )
          .pipe(Effect.result)
        return { outcome, calls: f.calls, providerCalls }
      }),
    ),
  )
  expect(result.providerCalls).toBe(1)
  expect(result.calls).toHaveLength(1)
  expect(result.calls[0]?.outcome).toEqual({
    status: 'FAILED',
    failure: JevFailure.Status,
    httpStatus: 402,
    responseHash: null,
    rejectedResponse: null,
  })
  expect(result.outcome).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'ReplayBrokerFailure', message: 'Inference replay stopped after HTTP 402 payment required' },
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
        const timing = yield* makeReplayInferenceTiming({
          budget: makeReplayInferenceBudget(1000),
          ...f,
          providers: { jev: provider, chart: chartProviderFixture },
          retain: () => Effect.fail(new ReplayBrokerFailure({ message: 'Receipt disk unavailable' })),
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        return yield* timing
          .run(timing.clients.jev.evaluate(request('AAPL').request, 10_000).pipe(Effect.result))
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
        const timing = yield* makeReplayInferenceTiming({
          budget: makeReplayInferenceBudget(1000),
          ...f,
          providers: { jev: provider, chart: chartProviderFixture },
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        const fiber = yield* timing
          .run(timing.clients.jev.evaluate(request('AAPL').request, 10_000))
          .pipe(Effect.forkChild)
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
        return yield* makeReplayInferenceTiming({
          budget: makeReplayInferenceBudget(1000),
          ...f,
          providerClock: f.marketClock,
          providers: { jev: { evaluate: () => Effect.die('must not infer') }, chart: chartProviderFixture },
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
        const timing = yield* makeReplayInferenceTiming({
          budget: makeReplayInferenceBudget(1000),
          ...f,
          providers: { jev: { evaluate: () => Effect.die('provider defect') }, chart: chartProviderFixture },
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        const exit = yield* timing.run(timing.clients.jev.evaluate(request('AAPL').request, 10_000)).pipe(Effect.exit)
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
        const timing = yield* makeReplayInferenceTiming({
          budget: makeReplayInferenceBudget(1000),
          ...f,
          providers: {
            jev: {
              evaluate: () =>
                Effect.succeed({
                  requestHash: request('AMZN').requestHash,
                  responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
                  startedAt: utcInstantFromEpochMillis(providerAt),
                  completedAt: utcInstantFromEpochMillis(providerAt),
                  response,
                }),
            },
            chart: chartProviderFixture,
          },
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        const outcome = yield* timing
          .run(timing.clients.jev.evaluate(request('AAPL').request, 10_000).pipe(Effect.result))
          .pipe(Effect.result)
        return { outcome, calls: f.calls }
      }),
    ),
  )
  expect(result.outcome).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ReplayBrokerFailure' } })
  expect(result.calls).toHaveLength(1)
  expect(result.calls[0]?.outcome.status).toBe('RECEIVED')
})

test.each([1000, null])(
  'chart, selected base, durable handoff and Jev share the original deadline (Jev latency %s)',
  async (latencyMs) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture
        const request = entryEvaluationRequestFixture(utcInstantFromEpochMillis(marketAt))
        const budgets: number[] = []
        const jevStarted = yield* Deferred.make<void>()
        const chartReceived = yield* Deferred.make<void>()
        let committed = false
        let cancelled = false
        const budget = makeReplayInferenceBudget(3)
        const timing = yield* makeReplayInferenceTiming({
          ...f,
          budget,
          providers: {
            chart: {
              evaluate: (raw, remainingMs) =>
                Effect.gen(function* () {
                  budgets.push(remainingMs)
                  yield* f.providerClock.adjust(3000)
                  yield* Deferred.succeed(chartReceived, undefined)
                  return nativeChartInference(raw, utcInstantFromEpochMillis(yield* Clock.currentTimeMillis))
                }),
            },
            jev: {
              evaluate: (raw, remainingMs) =>
                Effect.gen(function* () {
                  expect(committed).toBe(true)
                  budgets.push(remainingMs)
                  yield* Deferred.succeed(jevStarted, undefined)
                  if (latencyMs === null)
                    return yield* Effect.never.pipe(
                      Effect.onInterrupt(() =>
                        Effect.sync(() => {
                          cancelled = true
                        }),
                      ),
                    )
                  yield* f.providerClock.adjust(latencyMs)
                  return nativeJevInference(raw, utcInstantFromEpochMillis(yield* Clock.currentTimeMillis))
                }),
            },
          },
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        const operation = timing.run(
          evaluateClaimedEntryInference({
            requestId: request.requestId,
            input: request.request,
            observedAt: request.observedAt,
            expiresAt: request.expiresAt,
            claimedAt: request.observedAt,
          }).pipe(
            Effect.provideService(JevClient, timing.clients.jev),
            Effect.provideService(DecisionsClient, timing.clients.chart),
            Effect.provideService(EntryInferenceJournal, {
              recordVisualClaim: () => Effect.succeed({ dispatchAllowed: true }),
              recordVisualTerminal: () => Effect.void,
              recordBaseStartSkip: () => Effect.void,
              recordHandoff: () =>
                f.providerClock.adjust(1000).pipe(
                  Effect.as({ dispatchAllowed: true }),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      committed = true
                    }),
                  ),
                ),
            }),
            Effect.provideService(Clock.Clock, f.marketClock),
          ),
        )
        const fiber = yield* operation.pipe(Effect.forkChild)
        yield* Deferred.await(chartReceived)
        yield* Deferred.await(jevStarted)
        expect(budgets).toEqual([10_000, 7000, 3000])
        if (latencyMs === null) yield* f.providerClock.adjust(3000)
        const result = yield* Fiber.join(fiber)
        expect(f.calls.map((call) => [call.stage, call.budgetMs])).toEqual([
          ['CHART', 10_000],
          ['BASE_START', 7000],
          ['JEV', 3000],
        ])
        expect(budget.dispatchCount()).toBe(3)
        if (latencyMs === null) {
          expect(cancelled).toBe(true)
          expect(result.jev).toMatchObject({ status: 'FAILED', failure: JevFailure.Timeout })
        } else expect(result.jev.status).toBe('RECEIVED')
      }).pipe(Effect.scoped),
    )
  },
)

test('exhausting the shared budget after the chart retains its paid call and prevents Jev dispatch', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture
      const request = entryEvaluationRequestFixture(utcInstantFromEpochMillis(marketAt))
      const budget = makeReplayInferenceBudget(1)
      let jevCalls = 0
      const timing = yield* makeReplayInferenceTiming({
        ...f,
        budget,
        providers: {
          chart: chartProviderFixture,
          jev: {
            evaluate: () =>
              Effect.sync(() => {
                jevCalls++
              }).pipe(Effect.andThen(Effect.die('Budget must prevent this dispatch'))),
          },
        },
      }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
      const result = yield* timing
        .run(
          evaluateClaimedEntryInference({
            requestId: request.requestId,
            input: request.request,
            observedAt: request.observedAt,
            expiresAt: request.expiresAt,
            claimedAt: request.observedAt,
          }).pipe(
            Effect.provideService(JevClient, timing.clients.jev),
            Effect.provideService(DecisionsClient, timing.clients.chart),
            Effect.provideService(EntryInferenceJournal, {
              recordVisualClaim: () => Effect.succeed({ dispatchAllowed: true }),
              recordVisualTerminal: () => Effect.void,
              recordBaseStartSkip: () => Effect.void,
              recordHandoff: () => Effect.succeed({ dispatchAllowed: true }),
            }),
            Effect.provideService(Clock.Clock, f.marketClock),
          ),
        )
        .pipe(Effect.result)
      expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'ReplayBrokerFailure' } })
      expect(jevCalls).toBe(0)
      expect(f.calls.map((call) => call.stage)).toEqual(['CHART'])
      expect(budget.dispatchCount()).toBe(1)
    }).pipe(Effect.scoped),
  )
})
