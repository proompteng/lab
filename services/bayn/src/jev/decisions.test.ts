import { describe, expect, test } from 'bun:test'
import { Effect, Fiber, Layer, Logger, Redacted, References, Result } from 'effect'
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

  test('identifies exhausted OpenAI credit without retaining provider message text or retrying', async () => {
    const body = {
      error: {
        message:
          'You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.',
        type: 'insufficient_quota',
        param: null,
        code: 'credit_balance_exhausted',
      },
    }
    let dispatches = 0
    const logs: Readonly<Record<string, unknown>>[] = []
    const http = HttpClient.make((sent) => {
      dispatches++
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          sent,
          new Response(JSON.stringify(body), { status: 429, headers: { 'x-request-id': 'req_credit_exhausted' } }),
        ),
      )
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* DecisionsClient).evaluate(request, 250).pipe(Effect.result)
      }).pipe(
        Effect.provide(layerFor(http)),
        Effect.provide(
          Logger.layer([Logger.make(({ fiber }) => logs.push(fiber.getRef(References.CurrentLogAnnotations)))]),
        ),
      ),
    )
    expect(dispatches).toBe(1)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        category: 'STATUS',
        status: 429,
        providerErrorCode: 'credit_balance_exhausted',
        providerErrorType: 'insufficient_quota',
        providerRequestId: 'req_credit_exhausted',
        responseHash: 'd1e7b430e2a2dfabfe3d3e55559e6b3a5de1af81bbf97f1387184fc0df7abfd3',
      })
      expect(result.failure.message).toContain('credit_balance_exhausted')
      expect(result.failure.usage).toBeUndefined()
    }
    const serialized = JSON.stringify({ result, logs })
    expect(serialized).toContain('credit_balance_exhausted')
    expect(serialized).not.toContain(body.error.message)
    expect(serialized).not.toContain('private-key')
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({
      event: 'bayn.decisions.failure.v1',
      requestHash: prepared().requestHash,
      providerErrorCode: 'credit_balance_exhausted',
      providerRequestId: 'req_credit_exhausted',
      httpStatus: 429,
    })
  })

  test.each(['2', 'Thu, 01 Jan 1970 00:00:02 GMT'])(
    'preserves Retry-After %s without extending the original deadline',
    async (retryAfter) => {
      let dispatches = 0
      const http = HttpClient.make((sent) => {
        dispatches++
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            sent,
            new Response(JSON.stringify({ error: { type: 'rate_limit_error', code: 'slow_down' } }), {
              status: 429,
              headers: { 'retry-after': retryAfter, 'x-request-id': 'req_rate_limited' },
            }),
          ),
        )
      })
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* DecisionsClient).evaluate(request, 250).pipe(Effect.result)
        }).pipe(Effect.provide(layerFor(http)), Effect.provide(TestClock.layer())),
      )
      expect(dispatches).toBe(1)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result))
        expect(result.failure).toMatchObject({
          status: 429,
          providerErrorCode: 'slow_down',
          providerRequestId: 'req_rate_limited',
          providerRetryAtMs: 2_000,
        })
    },
  )

  test('retains HTTP status and request identity for a non-JSON rejection without exposing its body', async () => {
    const http = HttpClient.make((sent) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          sent,
          new Response('private provider body', {
            status: 429,
            headers: { 'x-request-id': 'req_non_json', 'retry-after': '-1' },
          }),
        ),
      ),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* DecisionsClient).evaluate(request, 250).pipe(Effect.result)
      }).pipe(Effect.provide(layerFor(http))),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ category: 'STATUS', status: 429, providerRequestId: 'req_non_json' })
      expect(result.failure.providerRetryAtMs).toBeUndefined()
      expect(result.failure.responseHash).toBeUndefined()
      expect(JSON.stringify(result.failure)).not.toContain('private provider body')
    }
  })

  test('a rejected request does not prevent a later admitted request from succeeding after funding is restored', async () => {
    let dispatches = 0
    const http = HttpClient.make((sent) => {
      dispatches++
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          sent,
          dispatches === 1
            ? new Response(JSON.stringify({ error: { code: 'credit_balance_exhausted' } }), { status: 429 })
            : new Response(JSON.stringify(response)),
        ),
      )
    })
    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DecisionsClient
        const rejected = yield* client.evaluate(request, 250).pipe(Effect.result)
        const recovered = yield* client.evaluate(request, 250)
        return { rejected, recovered }
      }).pipe(Effect.provide(layerFor(http))),
    )
    expect(dispatches).toBe(2)
    expect(Result.isFailure(results.rejected)).toBe(true)
    expect(results.recovered.requestHash).toBe(prepared().requestHash)
    expect(results.recovered.response).toEqual(response)
  })

  test('a broken diagnostic logger preserves the original provider failure', async () => {
    const http = HttpClient.make((sent) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          sent,
          new Response(JSON.stringify({ error: { code: 'credit_balance_exhausted' } }), { status: 429 }),
        ),
      ),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* DecisionsClient).evaluate(request, 250).pipe(Effect.result)
      }).pipe(
        Effect.provide(layerFor(http)),
        Effect.provide(
          Logger.layer([
            Logger.make(() => {
              throw new Error('logger unavailable')
            }),
          ]),
        ),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) expect(result.failure.providerErrorCode).toBe('credit_balance_exhausted')
  })

  test('retains rejection headers when the response body stalls past the original deadline', async () => {
    let canceled = 0
    const http = HttpClient.make((sent) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          sent,
          new Response(
            new ReadableStream({
              cancel: () => {
                canceled++
              },
            }),
            { status: 503, headers: { 'x-request-id': 'req_stalled_body', 'retry-after': '2' } },
          ),
        ),
      ),
    )
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* DecisionsClient
        const fiber = yield* client.evaluate(request, 250).pipe(Effect.result, Effect.forkChild)
        yield* TestClock.adjust(250)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(layerFor(http)), Effect.provide(TestClock.layer())),
    )
    expect(canceled).toBe(1)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        category: 'DEADLINE',
        status: 503,
        providerRequestId: 'req_stalled_body',
        providerRetryAtMs: 2_000,
      })
      expect(result.failure.usage).toBeUndefined()
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
