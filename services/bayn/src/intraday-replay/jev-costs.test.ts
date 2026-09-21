import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1OrThrow } from '../hash'
import { JevFailure, jevModel, prepareJevRequest, type JevResponse } from '../jev/contract'
import { calculateReplayJevCosts } from './jev-costs'
import type { ReplayJevCall } from './jev-timing'

const costs = { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' }
const call = (inputTokens: number, outputTokens = 0): ReplayJevCall => {
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
    schemaVersion: 'bayn.replay-jev-call.v1',
    request: prepared.request,
    requestHash: prepared.requestHash,
    simulatedStartedAt: '2026-09-04T14:00:02.000Z',
    providerStartedAt: '2026-09-21T12:00:00.000Z',
    providerCompletedAt: '2026-09-21T12:00:00.500Z',
    outcome: {
      status: 'RECEIVED',
      inference: {
        requestHash: prepared.requestHash,
        responseHash: canonicalHashV1OrThrow(response),
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
  responseHash: string | null = canonicalHashV1OrThrow(response),
): ReplayJevCall => ({
  ...call(0),
  outcome: { status: 'FAILED', failure, httpStatus: null, responseHash, rejectedResponse: response },
})

test('inference cost uses exact declared tariffs and conservative per-call micro rounding', () => {
  expect(calculateReplayJevCosts([call(1_000_000)], costs)).toMatchObject({
    knownCostMicros: '42000',
    unresolvedCallCount: 0,
    inputTokens: '1000000',
  })
  expect(calculateReplayJevCosts([call(100), call(100)], costs).knownCostMicros).toBe('10')
  expect(
    calculateReplayJevCosts([call(1_000_000, 100)], { ...costs, outputMicrosPerMillionTokens: '5000000' })
      .knownCostMicros,
  ).toBe('42500')
})

test('failed, interrupted and defective calls remain unresolved instead of receiving invented zero cost', () => {
  const unresolved: ReplayJevCall['outcome'][] = [
    { status: 'FAILED', failure: JevFailure.Timeout, httpStatus: null, responseHash: null, rejectedResponse: null },
    { status: 'INTERRUPTED' },
    { status: 'DEFECT' },
  ]
  const calls: ReplayJevCall[] = [call(100), ...unresolved.map((outcome) => ({ ...call(100), outcome }))]
  expect(calculateReplayJevCosts(calls, costs)).toMatchObject({
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
  expect(calculateReplayJevCosts(calls, costs)).toMatchObject({
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
  expect(calculateReplayJevCosts(calls, costs)).toMatchObject({
    callCount: calls.length,
    unresolvedCallCount: calls.length,
    inputTokens: '0',
    outputTokens: '0',
    knownCostMicros: '0',
  })
})
