import { expect, test } from 'bun:test'
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result } from '../hash'
import { makeInitialChartStageRequest, makeSelectedBaseStartStageRequest } from '../jev/staged-chart-questions'
import { makeNativeChartEvidence } from '../jev/chart-evidence'
import { JevFailure, jevModel, prepareJevRequest } from '../jev/contract'
import { entryEvaluationRequestFixture, nativeChartInference } from '../jev/entry-inference.test-support'
import { utcInstantFromEpochMillis } from '../time'
import { stageResponseIdentity } from '../jev/staged-checkpoint'
import {
  makeRecordedInferenceProviders,
  validateReplayInferenceRecording,
  validateRetainedReplayCalls,
} from './recorded-inference'
import { type ReplayInferenceCall, makeReplayInferenceBudget, makeReplayInferenceTiming } from './inference-timing'

const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
const observedAt = '2026-10-25T07:00:32.000Z'
const providerAt = '2026-10-26T00:00:00.000Z'
const later = (ms: number) => utcInstantFromEpochMillis(Date.parse(providerAt) + ms)
const request = Result.getOrThrow(
  prepareJevRequest({
    model: jevModel,
    state: { symbol: 'AAPL' },
    questions: { enter: { type: 'noul', instructions: 'Assess the supplied trading state.' } },
  }),
)
const response = {
  model: jevModel,
  answers: { enter: { type: 'noul' as const, noul: 0.7 } },
  usage: { input_tokens: 100, output_tokens: 0 },
}
const call = (): Extract<ReplayInferenceCall, { readonly stage: 'JEV' }> => ({
  schemaVersion: 'bayn.replay-inference-call.v2',
  stage: 'JEV',
  request: request.request,
  requestHash: request.requestHash,
  budgetMs: 1000,
  simulatedStartedAt: observedAt,
  providerStartedAt: providerAt,
  providerCompletedAt: later(50),
  outcome: {
    status: 'RECEIVED',
    inference: {
      requestHash: request.requestHash,
      responseHash: hash(response),
      response,
      startedAt: providerAt,
      completedAt: later(50),
    },
  },
})
const recording = (calls: readonly ReplayInferenceCall[] = [call()]) => ({
  schemaVersion: 'bayn.replay-inference-recording.v1' as const,
  sourceManifestHash: hash('source'),
  sourceRevision: 'a'.repeat(40),
  strategyBehaviorHash: hash('behavior'),
  strategyParameterHash: hash('parameters'),
  jevInstructionsHash: hash('instructions'),
  calls,
})
const fixture = (calls: readonly ReplayInferenceCall[] = [call()]) =>
  Effect.gen(function* () {
    const marketClock = yield* TestClock.make()
    const providerClock = yield* TestClock.make()
    yield* marketClock.setTime(Date.parse(observedAt))
    yield* providerClock.setTime(Date.parse(providerAt))
    const raw = recording(calls)
    const valid = Result.getOrThrow(validateReplayInferenceRecording(raw, hash(raw)))
    const retained = yield* makeRecordedInferenceProviders(valid, marketClock)
    return { marketClock, providerClock, ...retained }
  })

test('recordings reject changed digests, requests, responses, clocks and duplicate occurrences', () => {
  const valid = recording()
  expect(Result.isSuccess(validateReplayInferenceRecording(valid, hash(valid)))).toBe(true)
  expect(Result.isFailure(validateReplayInferenceRecording(valid, hash('other')))).toBe(true)
  const original = call()
  if (original.outcome.status !== 'RECEIVED') throw new Error('Missing successful fixture')
  const invalid = [
    { ...original, requestHash: hash('different') },
    { ...original, providerCompletedAt: '2026-10-25T23:59:59.999Z' },
    {
      ...original,
      outcome: { ...original.outcome, inference: { ...original.outcome.inference, responseHash: hash('changed') } },
    },
    {
      ...original,
      outcome: { ...original.outcome, inference: { ...original.outcome.inference, completedAt: later(51) } },
    },
  ]
  for (const value of invalid) {
    const changed = { ...valid, calls: [value] }
    expect(Result.isFailure(validateReplayInferenceRecording(changed, hash(changed)))).toBe(true)
  }
  const duplicate = recording([original, original])
  expect(Result.isFailure(validateReplayInferenceRecording(duplicate, hash(duplicate)))).toBe(true)
})

test('retained responses consume the recorded duration and preserve response bytes and usage', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture()
      const evaluated = yield* f.providers.jev
        .evaluate(request.request, 1000)
        .pipe(Effect.provideService(Clock.Clock, f.providerClock), Effect.forkChild)
      yield* f.providerClock.adjust(50)
      const result = yield* Fiber.join(evaluated)
      expect(result).toMatchObject({
        requestHash: request.requestHash,
        responseHash: hash(response),
        response,
        startedAt: providerAt,
        completedAt: later(50),
      })
      expect(f.consumedCount()).toBe(1)
      yield* f.assertSupported
    }).pipe(Effect.scoped),
  )
})

test('complete report calls preserve causal occurrences, paid usage and the retained duration', () => {
  const original = call()
  const valid = recording()
  expect(Result.isSuccess(validateRetainedReplayCalls(valid, []))).toBe(true)
  expect(Result.isSuccess(validateRetainedReplayCalls(valid, [original]))).toBe(true)
  if (original.stage !== 'JEV' || original.outcome.status !== 'RECEIVED') throw new Error('Missing received response')
  const changedResponse = { ...response, usage: { input_tokens: 1, output_tokens: 0 } }
  const changed = {
    ...original,
    outcome: {
      ...original.outcome,
      inference: { ...original.outcome.inference, response: changedResponse, responseHash: hash(changedResponse) },
    },
  }
  const shortened = {
    ...original,
    providerCompletedAt: later(49),
    outcome: { ...original.outcome, inference: { ...original.outcome.inference, completedAt: later(49) } },
  }
  for (const calls of [
    [original, { ...original, simulatedStartedAt: new Date(Date.parse(observedAt) + 1).toISOString() }],
    [{ ...original, simulatedStartedAt: new Date(Date.parse(observedAt) - 1).toISOString() }],
    [changed],
    [shortened],
  ])
    expect(Result.isFailure(validateRetainedReplayCalls(valid, calls))).toBe(true)
})

test('concurrent consumers cannot reuse the same retained occurrence', async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture()
      const attempts = yield* Effect.all(
        [
          f.providers.jev.evaluate(request.request, 1000).pipe(Effect.result),
          f.providers.jev.evaluate(request.request, 1000).pipe(Effect.result),
        ],
        { concurrency: 'unbounded' },
      ).pipe(Effect.provideService(Clock.Clock, f.providerClock), Effect.forkChild)
      yield* f.providerClock.adjust(50)
      const results = yield* Fiber.join(attempts)
      expect(results.filter(Result.isSuccess)).toHaveLength(1)
      expect(results.filter(Result.isFailure)).toHaveLength(1)
      expect(f.consumedCount()).toBe(1)
      expect(Result.isFailure(yield* f.assertSupported.pipe(Effect.result))).toBe(true)
    }).pipe(Effect.scoped),
  )
})

test('changed, exhausted and not-yet-causal occurrences remain unsupported after caller error handling', async () => {
  for (const scenario of ['changed', 'exhausted', 'future'] as const) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture()
        if (scenario === 'future') yield* f.marketClock.setTime(Date.parse(observedAt) - 1)
        if (scenario === 'exhausted') {
          const first = yield* f.providers.jev
            .evaluate(request.request, 1000)
            .pipe(Effect.provideService(Clock.Clock, f.providerClock), Effect.forkChild)
          yield* f.providerClock.adjust(50)
          yield* Fiber.join(first)
        }
        const raw = scenario === 'changed' ? { ...request.request, state: { symbol: 'MSFT' } } : request.request
        const result = yield* f.providers.jev.evaluate(raw, 1000).pipe(Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        expect(Result.isFailure(yield* f.assertSupported.pipe(Effect.result))).toBe(true)
        expect(f.consumedCount()).toBe(scenario === 'exhausted' ? 1 : 0)
      }).pipe(Effect.scoped),
    )
  }
})

test('shorter deadlines and interruption never refund or reuse a consumed response', async () => {
  for (const scenario of ['deadline', 'interrupt'] as const) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture()
        const evaluated = yield* f.providers.jev
          .evaluate(request.request, 10)
          .pipe(Effect.provideService(Clock.Clock, f.providerClock), Effect.forkChild)
        yield* f.providerClock.adjust(scenario === 'deadline' ? 10 : 1)
        if (scenario === 'interrupt') yield* Fiber.interrupt(evaluated)
        const exit = yield* Fiber.await(evaluated)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit) && scenario === 'deadline')
          expect(Cause.findError(exit.cause)).toMatchObject({ success: { failure: JevFailure.Timeout } })
        yield* f.providerClock.adjust(100)
        expect(f.consumedCount()).toBe(1)
        expect(Result.isFailure(yield* f.providers.jev.evaluate(request.request, 1000).pipe(Effect.result))).toBe(true)
      }).pipe(Effect.scoped),
    )
  }
})

test('retained provider failure preserves its charge evidence', async () => {
  const failed: ReplayInferenceCall = {
    ...call(),
    stage: 'JEV',
    request: request.request,
    outcome: {
      status: 'FAILED',
      failure: JevFailure.Status,
      httpStatus: 503,
      responseHash: hash(response),
      rejectedResponse: response,
    },
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const f = yield* fixture([failed])
      const evaluated = yield* f.providers.jev
        .evaluate(request.request, 1000)
        .pipe(Effect.provideService(Clock.Clock, f.providerClock), Effect.result, Effect.forkChild)
      yield* f.providerClock.adjust(50)
      const result = yield* Fiber.join(evaluated)
      expect(result).toMatchObject({
        failure: {
          failure: JevFailure.Status,
          status: 503,
          requestHash: request.requestHash,
          responseHash: hash(response),
        },
      })
      if (Result.isFailure(result) && result.failure.rejectedResponse !== undefined)
        expect(Redacted.value(result.failure.rejectedResponse)).toEqual(response)
      else throw new Error('Lost rejected response')
      yield* f.assertSupported
    }).pipe(Effect.scoped),
  )
})

test.each(['INTERRUPTED', 'DEFECT'] as const)(
  'retained %s is never converted into a successful provider response',
  async (status) => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture([{ ...call(), outcome: { status } }])
        const evaluated = yield* f.providers.jev
          .evaluate(request.request, 1000)
          .pipe(Effect.provideService(Clock.Clock, f.providerClock), Effect.forkChild)
        yield* f.providerClock.adjust(50)
        const exit = yield* Fiber.await(evaluated)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(status === 'INTERRUPTED')
        expect(f.consumedCount()).toBe(1)
      }).pipe(Effect.scoped),
    )
  },
)

test.each(['CHART', 'BASE_START'] as const)(
  '%s evidence uses the measured replay clock without provider dispatch',
  async (stage) => {
    const evaluation = entryEvaluationRequestFixture(observedAt)
    const chart = Result.getOrThrow(makeNativeChartEvidence(evaluation.request.chartSource))
    const source = { chart, protocol: evaluation.request.protocol, funding: evaluation.request.funding }
    const initial = Result.getOrThrow(makeInitialChartStageRequest(source))
    const prepared = (() => {
      if (stage === 'CHART') return initial
      const next = Result.getOrThrow(
        makeSelectedBaseStartStageRequest(
          source,
          stageResponseIdentity(nativeChartInference(initial.request, providerAt)),
        ),
      )
      if (next.status !== 'PREPARED') throw new Error('Missing requested base stage')
      return next
    })()
    const inference = nativeChartInference(prepared.request, providerAt)
    const retainedCall: ReplayInferenceCall = {
      ...call(),
      ...(stage === 'CHART'
        ? { schemaVersion: 'bayn.replay-inference-call.v2' as const, stage: 'CHART' as const }
        : { schemaVersion: 'bayn.replay-inference-call.v3' as const, stage: 'BASE_START' as const }),
      request: prepared.request,
      requestHash: inference.requestHash,
      outcome: { status: 'RECEIVED', inference },
    }
    const relabeled = recording([
      {
        ...retainedCall,
        ...(stage === 'CHART'
          ? { schemaVersion: 'bayn.replay-inference-call.v3' as const, stage: 'BASE_START' as const }
          : { schemaVersion: 'bayn.replay-inference-call.v2' as const, stage: 'CHART' as const }),
      },
    ])
    expect(Result.isFailure(validateReplayInferenceRecording(relabeled, hash(relabeled)))).toBe(true)
    const recorded: ReplayInferenceCall[] = []
    await Effect.runPromise(
      Effect.gen(function* () {
        const f = yield* fixture([retainedCall])
        const started = yield* Deferred.make<void>()
        const timing = yield* makeReplayInferenceTiming({
          providers: {
            ...f.providers,
            chart: {
              evaluate: (raw, budget) =>
                Deferred.succeed(started, undefined).pipe(Effect.andThen(f.providers.chart.evaluate(raw, budget))),
            },
          },
          budget: makeReplayInferenceBudget(1),
          providerClock: f.providerClock,
          advanceTo: (at) => f.marketClock.setTime(at),
          advanceDeadlineTo: (at) => f.marketClock.setTime(at),
          excludedSourceMillis: Effect.succeed(0),
          measureDatabaseTime: (operation) => operation,
          retain: (value) =>
            Effect.sync(() => {
              recorded.push(value)
            }),
        }).pipe(Effect.provideService(Clock.Clock, f.marketClock))
        const evaluated = yield* timing
          .run(timing.clients.chart.evaluate(prepared.request, 1000))
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* f.providerClock.adjust(50)
        const result = yield* Fiber.join(evaluated)
        expect(result.response).toEqual(inference.response)
        expect(Date.parse(result.completedAt) - Date.parse(observedAt)).toBe(50)
        expect(recorded).toHaveLength(1)
        expect(recorded[0]?.outcome.status).toBe('RECEIVED')
        expect(recorded[0]?.stage).toBe(stage)
        yield* f.assertSupported
      }).pipe(Effect.scoped),
    )
  },
)
