import { describe, expect, test } from 'bun:test'
import { Result } from 'effect'

import { decodeDecisionsResponse, prepareDecisionsRequest } from './decisions'
import { renderNativeCandlesPng } from './chart-evidence'

const bars = Array.from({ length: 6 }, (_, index) => ({
  minuteBeforeWindowEnd: 6 - index,
  open: 100 + index,
  high: 102 + index,
  low: 99 + index,
  close: 101 + index,
  volume: 10 + index,
}))
const request = {
  model: 'gpt-6-luna',
  input: [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Read the supplied completed candles and source bar identifiers.' },
        { type: 'input_image', image_url: `data:image/png;base64,${renderNativeCandlesPng(bars).toString('base64')}` },
        { type: 'input_json', data: { symbol: 'ETH/USD', bars } },
      ],
    },
  ],
  questions: [
    { type: 'predicate', name: 'support_present', instructions: 'Is there a defended support level?' },
    {
      type: 'choice',
      name: 'support_bar',
      instructions: 'Which source bar anchors the defended support?',
      choices: [
        { value: 'bar_1', description: 'First source bar.' },
        { value: 'bar_2', description: 'Second source bar.' },
      ],
    },
  ],
}
const prepared = () => Result.getOrThrow(prepareDecisionsRequest(request))
const usage = {
  input_tokens: 1_000,
  input_tokens_details: { cached_tokens: 100, cache_write_tokens: 200 },
  output_tokens: 2,
  total_tokens: 1_002,
}
const response = {
  model: 'gpt-6-luna',
  answers: [
    { type: 'predicate', name: 'support_present', probability: 0.8 },
    {
      type: 'choice',
      name: 'support_bar',
      choice: 'bar_1',
      confidence: 0.6,
      probabilities: [
        { value: 'bar_1', probability: 0.8 },
        { value: 'bar_2', probability: 0.2 },
      ],
    },
  ],
  usage,
} as const
describe('retained OpenAI Decisions evidence contract', () => {
  test('retains named predicates and source-anchor choices without a setup label', () => {
    const result = Result.getOrThrow(decodeDecisionsResponse(prepared().request, response))
    expect(result.answers).toEqual(response.answers)
    expect(result.usage).toEqual(usage)
  })

  test('retains a per-question refusal independently of successful judgments and metering', () => {
    const answers = [response.answers[0], { type: 'refusal', name: 'support_bar' }] as const
    const result = Result.getOrThrow(decodeDecisionsResponse(prepared().request, { ...response, answers }))
    expect(result.answers).toEqual(answers)
    expect(result.usage).toEqual(usage)
  })

  test('rejects missing, reordered, duplicated, mistyped and foreign answers', () => {
    for (const answers of [
      response.answers.slice(0, 1),
      response.answers.toReversed(),
      [response.answers[0], response.answers[0]],
      [{ type: 'predicate', name: 'support_present', probability: 1.01 }, response.answers[1]],
      [response.answers[0], { type: 'refusal', name: null }],
      [response.answers[0], { type: 'predicate', name: 'support_bar', probability: 0.8 }],
      [response.answers[0], { ...response.answers[1], choice: 'invented_level' }],
      [
        response.answers[0],
        {
          ...response.answers[1],
          probabilities: [
            { value: 'bar_1', probability: 0.8 },
            { value: 'bar_1', probability: 0.2 },
          ],
        },
      ],
      [response.answers[0], { ...response.answers[1], choice: 'bar_2' }],
      [
        response.answers[0],
        {
          ...response.answers[1],
          probabilities: [
            { value: 'bar_1', probability: 0.2 },
            { value: 'bar_2', probability: 0.2 },
          ],
        },
      ],
    ])
      expect(Result.isFailure(decodeDecisionsResponse(prepared().request, { ...response, answers }))).toBe(true)
  })

  test('rejects inconsistent or negative usage instead of reducing the reported cost', () => {
    for (const changed of [
      { ...usage, input_tokens: -1 },
      { ...usage, total_tokens: 1_000 },
      { ...usage, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 900 } },
    ])
      expect(Result.isFailure(decodeDecisionsResponse(prepared().request, { ...response, usage: changed }))).toBe(true)
  })

  test('rejects duplicate question identities and values, single-choice questions and remote images', () => {
    const choice = request.questions[1]
    for (const changed of [
      { ...request, questions: [request.questions[0], request.questions[0]] },
      { ...request, questions: [{ ...choice, choices: [{ value: 'x', description: 'X' }] }] },
      {
        ...request,
        questions: [
          {
            ...choice,
            choices: [
              { value: 'x', description: 'X' },
              { value: 'x', description: 'Again' },
            ],
          },
        ],
      },
      {
        ...request,
        input: [
          {
            role: 'user',
            content: [
              request.input[0]?.content[0],
              { type: 'input_image', image_url: 'https://unverified.example/chart.png' },
              request.input[0]?.content[2],
            ],
          },
        ],
      },
    ])
      expect(Result.isFailure(prepareDecisionsRequest(changed))).toBe(true)
  })
})
