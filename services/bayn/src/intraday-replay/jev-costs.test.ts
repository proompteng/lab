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
