import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevResearchPolicy } from '../jev/acceptance'
import { JevFailure, jevModel, prepareJevRequest, type JevResponse } from '../jev/contract'
import { calculateReplayInferenceCosts, registeredReplayInferenceTariff } from './inference-costs'
import { replayRateCardFixture } from '../system-assessment/fixtures.test-support'
import type { ReplayInferenceCall } from './inference-timing'
import {
  entryEvaluationRequestFixture,
  chartInferenceFixture,
  nativeChartInference,
} from '../jev/entry-inference.test-support'
import { makeNativeChartEvidence } from '../jev/chart-evidence'
import { makeInitialChartStageRequest, makeSelectedBaseStartStageRequest } from '../jev/staged-chart-questions'
import { stageResponseIdentity } from '../jev/staged-checkpoint'

test('registered replay tariffs cover both providers for the whole window without overlapping or substituted rates', () => {
  const card = replayRateCardFixture(costs)
  const interval = { startAt: '2026-11-02T14:30:00.000Z', endAt: '2026-11-27T21:00:00.000Z' }
  expect(Result.getOrThrow(registeredReplayInferenceTariff(card, interval, JevResearchPolicy.Candidate))).toEqual(costs)
  expect(
    Result.getOrThrow(
      registeredReplayInferenceTariff(
        { ...card, rates: [...card.rates].reverse() },
        interval,
        JevResearchPolicy.Candidate,
      ),
    ),
  ).toEqual(costs)
  for (const changed of [
    { ...card, rates: [] },
    { ...card, rates: card.rates.slice(1) },
    { ...card, rates: [...card.rates, ...card.rates] },
    { ...card, rates: card.rates.map((rate) => ({ ...rate, effectiveUntil: interval.endAt })) },
    { ...card, rates: card.rates.map((rate) => ({ ...rate, effectiveFrom: '2026-11-02T14:30:00.001Z' })) },
    { ...card, rates: card.rates.map((rate) => ({ ...rate, model: 'different-model' })) },
  ])
    expect(Result.isFailure(registeredReplayInferenceTariff(changed, interval, JevResearchPolicy.Candidate))).toBe(true)
  expect(
    Result.isFailure(
      registeredReplayInferenceTariff(card, { ...interval, endAt: interval.startAt }, JevResearchPolicy.Candidate),
    ),
  ).toBe(true)
})

const costs = {
  jev: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
  chart: {
    inputMicrosPerMillionTokens: '100000',
    outputMicrosPerMillionTokens: '0',
    cachedInputMicrosPerMillionTokens: '10000',
    cacheWriteInputMicrosPerMillionTokens: '125000',
  },
}
test('controls bind only their own providers and an unexpected call remains an unresolved expense', () => {
  const interval = { startAt: '2026-11-02T14:30:00.000Z', endAt: '2026-11-27T21:00:00.000Z' }
  for (const policy of [JevResearchPolicy.Ablation, JevResearchPolicy.Momentum, JevResearchPolicy.Deployed]) {
    const expected = { jev: null, chart: policy === JevResearchPolicy.Ablation ? costs.chart : null }
    const tariff = Result.getOrThrow(registeredReplayInferenceTariff(replayRateCardFixture(expected), interval, policy))
    expect(tariff).toEqual(expected)
    expect(calculateReplayInferenceCosts([], tariff)).toMatchObject({ knownCostMicros: '0', unresolvedCallCount: 0 })
    expect(calculateReplayInferenceCosts([call(100)], tariff)).toMatchObject({
      knownCostMicros: '0',
      unresolvedCallCount: 1,
      inputTokens: '100',
      callCount: 1,
    })
  }
  expect(
    Result.isFailure(
      registeredReplayInferenceTariff(
        replayRateCardFixture({ jev: null, chart: null }),
        interval,
        JevResearchPolicy.Ablation,
      ),
    ),
  ).toBe(true)
})
type JevCall = Extract<ReplayInferenceCall, { readonly stage: 'JEV' }>
type ChartCall = Extract<ReplayInferenceCall, { readonly stage: 'CHART' }>
const call = (inputTokens: number, outputTokens = 0): JevCall => {
  const prepared = Result.getOrThrow(
    prepareJevRequest({
      model: jevModel,
      state: { symbol: 'AAPL' },
      questions: { enter: { type: 'noul', instructions: 'Assess entry.' } },
    }),
  )
  const response: JevResponse = {
    model: jevModel,
    answers: { enter: { type: 'noul', noul: 0.7 } },
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  }
  return {
    stage: 'JEV',
    budgetMs: 10_000,
    schemaVersion: 'bayn.replay-inference-call.v2',
    request: prepared.request,
    requestHash: prepared.requestHash,
    simulatedStartedAt: '2026-09-04T14:00:02.000Z',
    providerStartedAt: '2026-09-21T12:00:00.000Z',
    providerCompletedAt: '2026-09-21T12:00:00.500Z',
    outcome: {
      status: 'RECEIVED',
      inference: {
        requestHash: prepared.requestHash,
        responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
        startedAt: '2026-09-21T12:00:00.000Z',
        completedAt: '2026-09-21T12:00:00.500Z',
        response,
      },
    },
  }
}

const rejectedCall = (
  response: unknown,
  failure = JevFailure.Response,
  responseHash: string | null = Result.getOrThrow(canonicalHashV1Result(response)),
): JevCall => ({
  ...call(0),
  outcome: { status: 'FAILED', failure, httpStatus: null, responseHash, rejectedResponse: response },
})

test('inference cost uses exact declared tariffs and conservative per-call micro rounding', () => {
  expect(calculateReplayInferenceCosts([call(1_000_000)], costs)).toMatchObject({
    knownCostMicros: '42000',
    unresolvedCallCount: 0,
    inputTokens: '1000000',
  })
  expect(calculateReplayInferenceCosts([call(100), call(100)], costs).knownCostMicros).toBe('10')
  expect(
    calculateReplayInferenceCosts([call(1_000_000, 100)], {
      ...costs,
      jev: { ...costs.jev, outputMicrosPerMillionTokens: '5000000' },
    }).knownCostMicros,
  ).toBe('42500')
})

test('failed, interrupted and defective calls remain unresolved instead of receiving invented zero cost', () => {
  const unresolved: JevCall['outcome'][] = [
    { status: 'FAILED', failure: JevFailure.Timeout, httpStatus: null, responseHash: null, rejectedResponse: null },
    { status: 'INTERRUPTED' },
    { status: 'DEFECT' },
  ]
  const calls: ReplayInferenceCall[] = [call(100), ...unresolved.map((outcome) => ({ ...call(100), outcome }))]
  expect(calculateReplayInferenceCosts(calls, costs)).toMatchObject({
    callCount: 4,
    unresolvedCallCount: 3,
    inputTokens: '100',
    knownCostMicros: '5',
  })
})

test('charges verified provider usage even when answers are rejected or the response arrives late', () => {
  const response = {
    model: jevModel,
    answers: { enter: { type: 'noul', noul: 1.5 } },
    usage: { input_tokens: 7858, output_tokens: 150 },
  }
  const calls = [rejectedCall(response), rejectedCall(response, JevFailure.Timeout)]
  expect(calculateReplayInferenceCosts(calls, costs)).toMatchObject({
    callCount: 2,
    unresolvedCallCount: 0,
    inputTokens: '15716',
    outputTokens: '300',
    knownCostMicros: '662',
  })
  expect(calls.every(({ outcome }) => outcome.status === 'FAILED')).toBe(true)
})

test('does not infer charges from missing, changed, mismatched or malformed usage receipts', () => {
  const response = { model: jevModel, usage: { input_tokens: 7858, output_tokens: 150 } }
  const calls = [
    rejectedCall(response, JevFailure.Response, null),
    rejectedCall(response, JevFailure.Response, '0'.repeat(64)),
    rejectedCall(response, JevFailure.Transport),
    rejectedCall({ ...response, model: 'unrecognized-model' }),
    rejectedCall({ model: jevModel }),
    ...[-1, 1.5, '7858', Number.MAX_SAFE_INTEGER + 1].map((input_tokens) =>
      rejectedCall({ ...response, usage: { ...response.usage, input_tokens } }),
    ),
    rejectedCall({ ...response, usage: { ...response.usage, output_tokens: -1 } }),
  ]
  expect(calculateReplayInferenceCosts(calls, costs)).toMatchObject({
    callCount: calls.length,
    unresolvedCallCount: calls.length,
    inputTokens: '0',
    outputTokens: '0',
    knownCostMicros: '0',
  })
})

test('retained HTTP failure usage is included while status failure remains unusable', () => {
  const response = { model: jevModel, usage: { input_tokens: 7858, output_tokens: 150 }, error: 'fixture rejection' }
  const retained = rejectedCall(response, JevFailure.Status)
  expect(calculateReplayInferenceCosts([retained], costs)).toMatchObject({
    callCount: 1,
    unresolvedCallCount: 0,
    inputTokens: '7858',
    outputTokens: '150',
    knownCostMicros: '331',
  })
  expect(retained.outcome.status).toBe('FAILED')
})

const chartCall = (): ChartCall => {
  const request = entryEvaluationRequestFixture()
  const prepared = Result.getOrThrow(
    makeInitialChartStageRequest({
      chart: Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource)),
      protocol: request.request.protocol,
      funding: request.request.funding,
    }),
  )
  const inference = chartInferenceFixture(request.request, request.observedAt)
  return {
    schemaVersion: 'bayn.replay-inference-call.v2',
    stage: 'CHART',
    budgetMs: 10_000,
    request: prepared.request,
    requestHash: prepared.requestHash,
    simulatedStartedAt: request.observedAt,
    providerStartedAt: request.observedAt,
    providerCompletedAt: request.observedAt,
    outcome: { status: 'RECEIVED', inference },
  }
}

test('the same evaluation retains separate chart and Jev charges', () => {
  expect(calculateReplayInferenceCosts([chartCall(), call(200)], costs)).toMatchObject({
    callCount: 2,
    chartCallCount: 1,
    jevCallCount: 1,
    unresolvedCallCount: 0,
    inputTokens: '300',
    knownCostMicros: '19',
  })
})

test('selected base calls retain a distinct identity and the visual tariff without changing old summary bytes', () => {
  const chart = chartCall()
  if (chart.outcome.status !== 'RECEIVED') throw Error('Expected fixture chart response')
  const request = entryEvaluationRequestFixture()
  const prepared = Result.getOrThrow(
    makeSelectedBaseStartStageRequest(
      {
        chart: Result.getOrThrow(makeNativeChartEvidence(request.request.chartSource)),
        protocol: request.request.protocol,
        funding: request.request.funding,
      },
      stageResponseIdentity(chart.outcome.inference),
    ),
  )
  if (prepared.status !== 'PREPARED') throw Error('Expected fixture selected base request')
  const base: Extract<ReplayInferenceCall, { stage: 'BASE_START' }> = {
    ...chart,
    schemaVersion: 'bayn.replay-inference-call.v3',
    stage: 'BASE_START',
    request: prepared.request,
    requestHash: prepared.requestHash,
    outcome: { status: 'RECEIVED', inference: nativeChartInference(prepared.request, request.observedAt) },
  }
  expect(base.requestHash).not.toBe(chart.requestHash)
  expect(calculateReplayInferenceCosts([chart, base, call(200)], costs)).toMatchObject({
    callCount: 3,
    chartCallCount: 1,
    baseStartCallCount: 1,
    jevCallCount: 1,
    knownCostMicros: '29',
    unresolvedCallCount: 0,
  })
  expect(calculateReplayInferenceCosts([chart, call(200)], costs)).not.toHaveProperty('baseStartCallCount')
  expect(calculateReplayInferenceCosts([{ ...base, outcome: { status: 'INTERRUPTED' } }], costs)).toMatchObject({
    baseStartCallCount: 1,
    knownCostMicros: '0',
    unresolvedCallCount: 1,
  })
})

test('chart cache reads and writes are priced once within total input tokens', () => {
  const chart = chartCall()
  if (chart.outcome.status !== 'RECEIVED') throw Error('Fixture must receive a chart response')
  const response = {
    ...chart.outcome.inference.response,
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
      output_tokens: 0,
      total_tokens: 100,
    },
  }
  const cached: ChartCall = {
    ...chart,
    outcome: {
      status: 'RECEIVED',
      inference: {
        ...chart.outcome.inference,
        response,
        responseHash: Result.getOrThrow(canonicalHashV1Result(response)),
      },
    },
  }
  expect(calculateReplayInferenceCosts([cached], costs)).toMatchObject({
    inputTokens: '100',
    cachedInputTokens: '20',
    cacheWriteInputTokens: '30',
    knownCostMicros: '9',
    unresolvedCallCount: 0,
  })
})

test('a metered rejected chart and interrupted Jev retain known chart costs and an explicit unknown', () => {
  const chart = chartCall()
  if (chart.outcome.status !== 'RECEIVED') throw Error('Fixture must receive a chart response')
  const failed: ChartCall = {
    ...chart,
    outcome: {
      status: 'FAILED',
      category: 'RESPONSE',
      httpStatus: 200,
      responseHash: chart.outcome.inference.responseHash,
      usage: chart.outcome.inference.response.usage,
    },
  }
  expect(
    calculateReplayInferenceCosts([failed, { ...call(200), outcome: { status: 'INTERRUPTED' } }], costs),
  ).toMatchObject({
    callCount: 2,
    knownCostMicros: '10',
    unresolvedCallCount: 1,
  })
  if (failed.outcome.status !== 'FAILED') throw Error('Fixture must retain a failure')
  expect(
    calculateReplayInferenceCosts([{ ...failed, outcome: { ...failed.outcome, responseHash: null } }], costs),
  ).toMatchObject({
    unresolvedCallCount: 1,
    knownCostMicros: '0',
  })
})
