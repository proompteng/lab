import { Result } from 'effect'

import { canonicalHashV1 } from '../hash'
import { decodeRuneResponse, runeModel, prepareRuneRequest, type RuneResponse } from '../rune/contract'
import { jevTradingQuestions } from './trading-signals'

export const tradingSignalInferenceFixture = (input: unknown, at: string) => {
  const { request } = Result.getOrThrow(prepareRuneRequest(input))
  const response = {
    id: 'dec-signal-fixture',
    model: runeModel,
    provider: 'surogate',
    answers: {
      regime: {
        type: 'choice',
        choice: 'upward_trend',
        confidence: 0.75,
        probabilities: { upward_trend: 0.8, downward_trend: 0.05, range: 0.05, unstable: 0.05, unclear: 0.05 },
      },
      continuation: { type: 'noul', noul: 0.8 },
      exhaustion: { type: 'noul', noul: 0.2 },
      setup_quality: {
        type: 'score',
        score: 3,
        confidence: 1,
        probabilities: { '0': 0, '1': 0, '2': 0, '3': 1, '4': 0 },
        legend: Object.fromEntries(
          jevTradingQuestions.setup_quality.criteria.map((label, index) => [String(index), label]),
        ),
      },
      action: {
        type: 'choice',
        choice: 'enter',
        confidence: 0.7,
        probabilities: { enter: 0.8, wait: 0.1, avoid: 0.1 },
      },
    },
    usage: { input_tokens: 250, output_tokens: Object.keys(request.questions).length, cost: 0 },
  } satisfies RuneResponse
  Result.getOrThrow(decodeRuneResponse(request, response))
  return {
    requestHash: canonicalHashV1(request),
    responseHash: canonicalHashV1(response),
    startedAt: at,
    completedAt: at,
    response,
  }
}
