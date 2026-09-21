import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { decodeJevResponse, jevModel, prepareJevRequest } from './contract'
import { requestFixture, responseFixture } from './test-support'

const scoreResponse = (score: number, probabilities: ReadonlyArray<number>) => {
  const criteria = probabilities.map((_, level) => `Level ${level}`)
  const { request } = Result.getOrThrow(
    prepareJevRequest({
      model: jevModel,
      state: { signal: 'fixture' },
      questions: { setup: { type: 'score', instructions: 'Assess the signal', criteria } },
    }),
  )
  return {
    request,
    response: {
      model: jevModel,
      answers: {
        setup: {
          type: 'score' as const,
          score,
          confidence: 0.5,
          probabilities: Object.fromEntries(probabilities.map((value, level) => [String(level), value])),
          legend: Object.fromEntries(criteria.map((value, level) => [String(level), value])),
        },
      },
      usage: { input_tokens: 100, output_tokens: 10 },
    },
  }
}

describe('Jev provider contract', () => {
  test('binds canonical requests independently of object key order', () => {
    const prepared = Result.getOrThrow(prepareJevRequest(requestFixture))
    const reordered = Result.getOrThrow(
      prepareJevRequest({ questions: requestFixture.questions, state: requestFixture.state, model: jevModel }),
    )
    expect(prepared.requestHash).toBe(reordered.requestHash)
    expect(prepared.body).toBe(reordered.body)
    expect(JSON.parse(prepared.body)).toEqual(requestFixture)
  })

  test('accepts an exact response without treating confidence as profitable-trade probability', () => {
    expect(Result.getOrThrow(decodeJevResponse(requestFixture, responseFixture()))).toEqual(responseFixture())
  })

  test.each([
    [2, [1, 0, 0]],
    [0, [0, 0, 1]],
    [0.011, [1, 0]],
    [8.949, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]],
    [1.69, [0.03, 0.46, 0.35, 0.15, 0.01]],
  ] as const)('rejects a score incompatible with its rounded probabilities: %s', (score, probabilities) => {
    const { request, response } = scoreResponse(score, probabilities)
    const result = decodeJevResponse(request, response)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.message).toBe('Jev score contradicts its probability distribution')
      expect(result.failure.question).toBe('setup')
    }
  })

  test.each([
    [0, [1, 0]],
    [0.01, [1, 0]],
    [8.95, [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]],
    [1.63, [0.03, 0.45999999999999996, 0.35, 0.15, 0.01]],
    [3.25, [0, 0.02, 0.07, 0.55, 0.36]],
    [1.52, [0.03, 0.54, 0.31, 0.12, 0]],
    [1.11, [0.14, 0.66, 0.15, 0.05, 0]],
    [2.54, [0.01, 0.1, 0.3, 0.51, 0.08]],
  ] as const)('preserves compatible exact and recorded rounded scores: %s', (score, probabilities) => {
    const { request, response } = scoreResponse(score, probabilities)
    expect(Result.getOrThrow(decodeJevResponse(request, response))).toEqual(response)
  })

  test.each([
    { ...requestFixture, model: 'jev-latest' },
    { ...requestFixture, questions: {} },
    { ...requestFixture, state: { value: Number.NaN } },
    { ...requestFixture, state: 'x'.repeat(128_000) },
    { ...requestFixture, credential: 'never-accepted' },
  ])('rejects an invalid or unpinned request %#', (input) => {
    expect(Result.isFailure(prepareJevRequest(input))).toBe(true)
  })

  test.each([
    (response: ReturnType<typeof responseFixture>) => ({ ...response, model: 'jev-1.14.0' }),
    (response: ReturnType<typeof responseFixture>) => ({
      ...response,
      answers: { relevant: response.answers.relevant },
    }),
    (response: ReturnType<typeof responseFixture>) => ({
      ...response,
      answers: { ...response.answers, extra: { type: 'noul', noul: 0.5 } },
    }),
    (response: ReturnType<typeof responseFixture>) => ({
      ...response,
      answers: { ...response.answers, relevant: { type: 'noul', noul: 2 } },
    }),
    (response: ReturnType<typeof responseFixture>) => ({
      ...response,
      answers: { ...response.answers, direction: { ...response.answers.direction, choice: 'unfavorable' } },
    }),
    (response: ReturnType<typeof responseFixture>) => ({
      ...response,
      answers: {
        ...response.answers,
        direction: {
          ...response.answers.direction,
          probabilities: { favorable: 0.93, unfavorable: 0.05, unclear: 0.01 },
        },
      },
    }),
    (response: ReturnType<typeof responseFixture>) => ({ ...response, usage: { input_tokens: -1, output_tokens: 80 } }),
  ])('rejects malformed, mismatched, or non-normalized responses %#', (mutate) => {
    expect(Result.isFailure(decodeJevResponse(requestFixture, mutate(responseFixture())))).toBe(true)
  })
})
