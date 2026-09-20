import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { decodeJevResponse, jevModel, prepareJevRequest } from './contract'
import { requestFixture, responseFixture } from './test-support'

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
