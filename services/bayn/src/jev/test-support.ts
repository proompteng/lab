import { jevModel, type JevRequest, type JevResponse } from './contract'
import { Result } from 'effect'
import { canonicalHashV1 } from '../hash'
import { makeNewsSnapshot } from '../market-data/news/model'
import { makeJevEvaluationRequest } from './evidence'

export const requestFixture = {
  model: jevModel,
  state: { subject: 'ExampleCo', headline: 'ExampleCo raises its revenue outlook.' },
  questions: {
    relevant: { type: 'noul', instructions: 'Does this contain a fact directly about ExampleCo?' },
    direction: {
      type: 'choice',
      instructions: 'Which outlook direction does the announcement support?',
      criteria: {
        favorable: 'Improved outlook.',
        unfavorable: 'Worsened outlook.',
        unclear: 'Neither is established.',
      },
    },
  },
} satisfies JevRequest

export const responseFixture = () =>
  ({
    model: jevModel,
    answers: {
      relevant: { type: 'noul', noul: 0.95 },
      direction: {
        type: 'choice',
        choice: 'favorable',
        confidence: 0.82,
        probabilities: { favorable: 0.9, unfavorable: 0.02, unclear: 0.08 },
      },
    },
    usage: { input_tokens: 250, output_tokens: 80 },
  }) satisfies JevResponse

export const evaluationRequestFixture = () =>
  Result.getOrThrow(
    makeJevEvaluationRequest({
      schemaVersion: 'bayn.jev-evaluation-request.v1',
      cycleId: 'a'.repeat(64),
      authorityGenerationHash: 'b'.repeat(64),
      snapshotId: 'c'.repeat(64),
      symbol: 'AAPL',
      observedAt: '1970-01-01T00:00:00.000Z',
      expiresAt: '1970-01-01T00:00:05.000Z',
      news: Result.getOrThrow(
        makeNewsSnapshot({
          schemaVersion: 'bayn.company-news-snapshot.v1',
          source: 'alpaca-news-v1beta1',
          query: { symbol: 'AAPL', asOf: '1970-01-01T00:00:00.000Z' },
          requestedAt: '1970-01-01T00:00:00.000Z',
          receivedAt: '1970-01-01T00:00:00.000Z',
          articles: [],
          pages: [{ requestPageToken: null, response: { news: [], next_page_token: null } }],
        }),
      ),
      requestHash: canonicalHashV1(requestFixture),
      request: requestFixture,
    }),
  )

export const inferenceFixture = () => ({
  requestHash: canonicalHashV1(requestFixture),
  responseHash: canonicalHashV1(responseFixture()),
  startedAt: '1970-01-01T00:00:00.000Z',
  completedAt: '1970-01-01T00:00:00.000Z',
  response: responseFixture(),
})
