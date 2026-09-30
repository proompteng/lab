import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { canonicalHashV1 } from '../hash'
import { decodeRetainedDecisionResponse, prepareRetainedDecisionRequest } from '../jev/model-evidence'
import { requestFixture as retainedRequest, responseFixture as retainedResponse } from '../jev/retained.test-support'
import { requestFixture, responseFixture } from '../jev/test-support'
import { decodeRuneResponse, prepareRuneRequest, runeModel } from './contract'
import golden from './fixtures/upstream-decisions-v1.json'

describe('pinned native Rune contract', () => {
  test.each(golden.cases)('accepts upstream $name answers without rounding or changing their evidence', (fixture) => {
    const request = Result.getOrThrow(
      prepareRuneRequest({ ...JSON.parse(fixture.body), model: runeModel, thinking: false }),
    )
    const response = {
      id: 'dec-upstream-golden',
      model: runeModel,
      provider: 'surogate',
      answers: fixture.answers,
      usage: { input_tokens: 100, output_tokens: Object.keys(fixture.answers).length, cost: 0 },
    }
    expect(canonicalHashV1(Result.getOrThrow(decodeRuneResponse(request.request, response)))).toBe(
      canonicalHashV1(response),
    )
  })

  test.each<[string, unknown]>([
    ['hosted model', { ...requestFixture, model: 'jev-1.13.0' }],
    ['unversioned model', { ...requestFixture, model: 'rune' }],
    ['thinking', { ...requestFixture, thinking: true }],
    [
      'missing noul criteria',
      { ...requestFixture, questions: { question: { type: 'noul', instructions: 'Decide.' } } },
    ],
    [
      'null choice criterion',
      {
        ...requestFixture,
        questions: { question: { type: 'choice', instructions: 'Decide.', criteria: { a: null, b: 'B' } } },
      },
    ],
    ['excessive body', { ...requestFixture, state: 'x'.repeat(128_001) }],
  ])('rejects %s before transport', (_name, request) => {
    expect(Result.isFailure(prepareRuneRequest(request))).toBe(true)
  })

  test.each<[string, unknown]>([
    ['wrong model', { ...responseFixture(), model: 'jev-1.13.0' }],
    ['wrong provider', { ...responseFixture(), provider: 'typesafe' }],
    ['missing identity', { ...responseFixture(), id: '' }],
    ['missing answers', { ...responseFixture(), answers: {} }],
    [
      'unexpected answers',
      { ...responseFixture(), answers: { ...responseFixture().answers, added: { type: 'noul', noul: 0.5 } } },
    ],
    ['wrong readout count', { ...responseFixture(), usage: { input_tokens: 250, output_tokens: 1, cost: 0 } }],
    ['unexpected billing', { ...responseFixture(), usage: { input_tokens: 250, output_tokens: 2, cost: 1 } }],
    ['nonfinite usage', { ...responseFixture(), usage: { input_tokens: Infinity, output_tokens: 2, cost: 0 } }],
  ])('rejects %s in native responses', (_name, response) => {
    expect(Result.isFailure(decodeRuneResponse(requestFixture, response))).toBe(true)
  })

  test.each([
    { probabilities: { favorable: 0.9, unfavorable: 0.05, unclear: 0.04 } },
    { probabilities: { favorable: 0.9, unfavorable: 0.05, unknown: 0.05 } },
    { probabilities: { favorable: NaN, unfavorable: 0.05, unclear: 0.05 } },
    { choice: 'unfavorable' },
    { confidence: 0.9 },
  ])('rejects a contradictory choice distribution', (change) => {
    const response = responseFixture()
    const answers = { ...response.answers, direction: { ...response.answers.direction, ...change } }
    expect(Result.isFailure(decodeRuneResponse(requestFixture, { ...response, answers }))).toBe(true)
  })

  test('rejects score/legend/confidence substitution against independent upstream answers', () => {
    const fixture = golden.cases.find((item) => item.name === 'ticket')
    if (fixture === undefined) throw new Error('Missing upstream fixture')
    const request = Result.getOrThrow(
      prepareRuneRequest({ ...JSON.parse(fixture.body), model: runeModel, thinking: false }),
    ).request
    const response = {
      id: 'dec-golden',
      model: runeModel,
      provider: 'surogate',
      answers: fixture.answers,
      usage: { input_tokens: 100, output_tokens: 3, cost: 0 },
    }
    for (const changed of [
      { score: 1 },
      { confidence: 0 },
      { legend: { '0': 'Changed', '1': 'Somewhat urgent', '2': 'Very urgent' } },
    ]) {
      const answers = { ...response.answers, urgency: { ...response.answers.urgency, ...changed } }
      expect(Result.isFailure(decodeRuneResponse(request, { ...response, answers }))).toBe(true)
    }
  })

  test('preserves historical hosted evidence and its original hashes without admitting it to Rune', () => {
    const prepared = Result.getOrThrow(prepareRetainedDecisionRequest(retainedRequest))
    const response = Result.getOrThrow(decodeRetainedDecisionResponse(prepared.request, retainedResponse()))
    expect(prepared.requestHash).toBe('c84f3a3a81a56379f8895a8e0d40985cae75848aa45bbb3196080c2b4a5c79a9')
    expect(canonicalHashV1(response)).toBe('400b7a2ed3e2acbdb390e4ac112c0e300ca84bd1a66f31f3c210c557394c4f1a')
    expect(Result.isFailure(prepareRuneRequest(prepared.request))).toBe(true)
  })
})
