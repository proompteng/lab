import { describe, expect, test } from 'bun:test'
import { Effect, Fiber, Layer, Redacted, Result } from 'effect'
import { HttpClient, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result } from '../hash'
import {
  DecisionsClient,
  DecisionsClientLive,
  decodeDecisionsResponse,
  decisionsEndpoint,
  prepareDecisionsRequest,
} from './decisions'
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
const layerFor = (http: HttpClient.HttpClient, timeout = 1_000) =>
  DecisionsClientLive(Redacted.make('private-key'), timeout).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  )

describe('native OpenAI Decisions contract', () => {
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

  test('dispatches the exact sealed request and returns reproducible response hashes', async () => {
    const bodies: string[] = []
    const http = HttpClient.make((sent, url) => {
      expect(url.toString()).toBe(decisionsEndpoint)
      expect(sent.method).toBe('POST')
      if (sent.body._tag !== 'Uint8Array') throw new Error('Expected serialized request')
      bodies.push(new TextDecoder().decode(sent.body.body))
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          sent,
          new Response(JSON.stringify({ ...response, output_tokens_details: { reasoning_tokens: 0 } })),
        ),
      )
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* DecisionsClient).evaluate(request, 1000)
      }).pipe(Effect.provide(layerFor(http))),
    )
    expect(bodies).toEqual([prepared().body])
    expect(result.requestHash).toBe(prepared().requestHash)
    expect(result.responseHash).toBe(Result.getOrThrow(canonicalHashV1Result(result.response)))
  })

  test('retains observed metering on unsuccessful status and malformed successful answers', async () => {
    for (const status of [429, 200]) {
      const http = HttpClient.make((sent) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            sent,
            new Response(JSON.stringify({ ...response, answers: [], error: 'do not retain provider text' }), {
              status,
            }),
          ),
        ),
      )
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* DecisionsClient).evaluate(request, 1000).pipe(Effect.result)
        }).pipe(Effect.provide(layerFor(http))),
      )
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.status).toBe(status)
        expect(result.failure.usage).toEqual(usage)
        expect(result.failure.category).toBe(status === 200 ? 'RESPONSE' : 'STATUS')
        expect(JSON.stringify(result.failure)).not.toContain('private-key')
        expect(JSON.stringify(result.failure)).not.toContain('do not retain provider text')
      }
    }
  })

  test.each([250, 1000])(
    'cancels transport at its remaining %sms deadline without retrying or fabricating usage',
    async (budgetMs) => {
      let dispatches = 0
      let interrupted = 0
      const http = HttpClient.make(() =>
        Effect.gen(function* () {
          dispatches++
          return yield* Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted++
              }),
            ),
          )
        }),
      )
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* DecisionsClient
          const fiber = yield* client.evaluate(request, budgetMs).pipe(Effect.result, Effect.forkChild)
          yield* TestClock.adjust(budgetMs)
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provide(layerFor(http)), Effect.provide(TestClock.layer())),
      )
      expect(dispatches).toBe(1)
      expect(interrupted).toBe(1)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.category).toBe('DEADLINE')
        expect(result.failure.usage).toBeUndefined()
      }
    },
  )
})
