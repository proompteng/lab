import { expect, test } from 'bun:test'
import { Result } from 'effect'

import { decodeJevResponse, prepareJevRequest, type JevResponse } from './contract'

const reference = `bayn_chart_image_${'a'.repeat(64)}`
const request = {
  model: 'jev-1.14.0',
  state: { chart: reference },
  assets: { [reference]: { type: 'image', format: 'png', data_base64: 'aGVsbG8=' } },
  questions: {
    present: { type: 'noul', instructions: 'Is there a consolidation in `chart`?' },
    region: { type: 'box', instructions: 'The most recent completed consolidation in `chart`.' },
  },
}
const response = {
  model: 'jev-1.14.0',
  answers: {
    present: { type: 'noul', noul: 0.1 },
    region: { type: 'box', box: { top: 0.2, bottom: 0.5, left: 0.1, right: 0.7 }, confidence: 0.9 },
  },
  usage: { input_tokens: 2000, output_tokens: 30 },
} satisfies JevResponse

test('decodes Jev 1.14 presence and Box independently without inventing presence from localization', () => {
  const prepared = Result.getOrThrow(prepareJevRequest(request))
  expect(Result.getOrThrow(decodeJevResponse(prepared.request, response))).toEqual(response)
})

test.each([
  { top: 0.5, bottom: 0.2, left: 0.1, right: 0.7 },
  { top: 0.2, bottom: 0.5, left: 0.8, right: 0.7 },
  { top: -0.1, bottom: 0.5, left: 0.1, right: 0.7 },
  { top: 0.2, bottom: 1.1, left: 0.1, right: 0.7 },
])('rejects invalid Box geometry %#', (box) => {
  const prepared = Result.getOrThrow(prepareJevRequest(request))
  expect(
    Result.isFailure(
      decodeJevResponse(prepared.request, {
        ...response,
        answers: { ...response.answers, region: { ...response.answers.region, box } },
      }),
    ),
  ).toBe(true)
})

test('rejects Box on the historical model and without an image', () => {
  expect(Result.isFailure(prepareJevRequest({ ...request, model: 'jev-1.13.0' }))).toBe(true)
  const { assets: _assets, ...withoutImage } = request
  expect(Result.isFailure(prepareJevRequest(withoutImage))).toBe(true)
})

test('rejects a different response model and missing or mistyped Box answers', () => {
  const prepared = Result.getOrThrow(prepareJevRequest(request))
  expect(Result.isFailure(decodeJevResponse(prepared.request, { ...response, model: 'jev-1.13.0' }))).toBe(true)
  expect(
    Result.isFailure(
      decodeJevResponse(prepared.request, { ...response, answers: { present: response.answers.present } }),
    ),
  ).toBe(true)
  expect(
    Result.isFailure(
      decodeJevResponse(prepared.request, {
        ...response,
        answers: { ...response.answers, region: { type: 'noul', noul: 0.9 } },
      }),
    ),
  ).toBe(true)
})
