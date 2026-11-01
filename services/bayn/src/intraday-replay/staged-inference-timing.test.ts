import { expect, test } from 'bun:test'
import { Clock, Effect, Result, Schema } from 'effect'
import { TestClock } from 'effect/testing'

import { makeNativeChartEvidence } from '../jev/chart-evidence'
import {
  chartProviderFixture,
  chartInferenceFixture,
  entryEvaluationRequestFixture,
} from '../jev/entry-inference.test-support'
import { stageResponseIdentity } from '../jev/staged-checkpoint'
import { makeInitialChartStageRequest, makeSelectedBaseStartStageRequest } from '../jev/staged-chart-questions'
import {
  makeReplayInferenceBudget,
  makeReplayInferenceTiming,
  ReplayInferenceCallSchema,
  type ReplayInferenceCall,
} from './inference-timing'

const baseRequest = () => {
  const request = entryEvaluationRequestFixture()
  const chart = Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource))
  const source = { chart, protocol: request.request.protocol, funding: request.request.funding }
  const base = Result.getOrThrow(
    makeSelectedBaseStartStageRequest(
      source,
      stageResponseIdentity(chartInferenceFixture(request.request, request.observedAt)),
    ),
  )
  if (base.status !== 'PREPARED') throw Error('Expected selected base fixture')
  return { source, base }
}

test('replay stage envelopes reject missing predecessor or mixed chart questions before spending a provider budget', async () => {
  const { source, base } = baseRequest()
  const initial = Result.getOrThrow(makeInitialChartStageRequest(source))
  const variants = [
    { ...base.request, input: initial.request.input },
    { ...base.request, questions: initial.request.questions },
  ]
  for (const raw of variants) {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const providerClock = yield* TestClock.make()
          const marketClock = yield* TestClock.make()
          const budget = makeReplayInferenceBudget(3)
          const calls: ReplayInferenceCall[] = []
          let providerCalls = 0
          const advance = (at: number) => marketClock.setTime(at)
          const timing = yield* makeReplayInferenceTiming({
            providerClock,
            budget,
            advanceTo: advance,
            advanceDeadlineTo: advance,
            excludedSourceMillis: Effect.succeed(0),
            measureDatabaseTime: (operation) => operation,
            retain: (call) =>
              Effect.sync(() => {
                calls.push(call)
              }),
            providers: {
              chart: {
                evaluate: (request, remaining) =>
                  Effect.sync(() => {
                    providerCalls++
                  }).pipe(Effect.andThen(chartProviderFixture.evaluate(request, remaining))),
              },
              jev: { evaluate: () => Effect.die('No Jev dispatch expected') },
            },
          }).pipe(Effect.provideService(Clock.Clock, marketClock))
          const outcome = yield* timing.run(timing.clients.chart.evaluate(raw, 10_000)).pipe(Effect.result)
          return { outcome, providerCalls, dispatches: budget.dispatchCount(), calls }
        }),
      ),
    )
    expect(Result.isFailure(result.outcome)).toBe(true)
    expect(result.providerCalls).toBe(0)
    expect(result.dispatches).toBe(0)
    expect(result.calls).toEqual([])
  }
})

test('BASE_START wire identity is versioned separately without admitting it as an old chart call', () => {
  const { source, base } = baseRequest()
  const initial = Result.getOrThrow(makeInitialChartStageRequest(source))
  const call = {
    schemaVersion: 'bayn.replay-inference-call.v3',
    stage: 'BASE_START',
    request: base.request,
    requestHash: base.requestHash,
    budgetMs: 7000,
    simulatedStartedAt: '2026-10-26T20:00:00.000Z',
    providerStartedAt: '2026-10-26T20:00:00.000Z',
    providerCompletedAt: '2026-10-26T20:00:00.000Z',
    outcome: { status: 'INTERRUPTED' },
  }
  const decode = Schema.decodeUnknownResult(ReplayInferenceCallSchema)
  expect(Result.isSuccess(decode(call))).toBe(true)
  expect(Result.isFailure(decode({ ...call, schemaVersion: 'bayn.replay-inference-call.v2' }))).toBe(true)
  expect(
    Result.isSuccess(
      decode({
        ...call,
        schemaVersion: 'bayn.replay-inference-call.v2',
        stage: 'CHART',
        request: initial.request,
        requestHash: initial.requestHash,
      }),
    ),
  ).toBe(true)
})
