import { describe, expect, test } from 'bun:test'
import { Effect, Fiber, Layer, Redacted, Result } from 'effect'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import { canonicalHashV1Result, sha256 } from '../hash'
import { JevClient, JevClientLive, JevError } from './client'
import { JevFailure, jevModel, prepareJevRequest } from './contract'
import {
  decodeVisualDecision,
  evaluateDualSignalResearch,
  VisualDecisionClient,
  VisualDecisionClientLive,
  openAiDecisionsEndpoint,
  visualDecisionRequest,
} from './dual-signal'
import { JevEntrySetup } from './trade-plan-choices'
import { nativeCandlestickEvidence, verifiedVisualBars } from './visual-evidence'

const bars = Array.from({ length: 30 }, (_, index) => {
  const price = 100 + index * 0.13
  return {
    minuteBeforeWindowEnd: 30 - index,
    open: price,
    high: price + 0.35,
    low: price - 0.2,
    close: price + 0.18,
    volume: 1000 + index * 10,
  }
})
const request = Result.getOrThrow(
  prepareJevRequest({
    model: jevModel,
    state: { candidate: { symbol: 'AAPL', bars1m: bars }, session: { observedAt: '2026-10-22T20:00:00.000Z' } },
    questions: {
      setup: {
        type: 'choice',
        instructions: 'Classify observed setup',
        criteria: {
          [JevEntrySetup.Upward]: 'Current upward continuation',
          [JevEntrySetup.Unclear]: 'Mixed evidence',
          [JevEntrySetup.Adverse]: 'Adverse deterioration',
        },
      },
    },
  }),
).request

const visualResponse = {
  model: 'gpt-6-luna',
  answers: [
    {
      type: 'choice',
      name: 'chart_setup',
      choice: JevEntrySetup.Upward,
      confidence: 0.8,
      probabilities: [
        { value: JevEntrySetup.Upward, probability: 0.8 },
        { value: JevEntrySetup.Unclear, probability: 0.15 },
        { value: JevEntrySetup.Adverse, probability: 0.05 },
      ],
    },
  ],
  usage: {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 100, cache_write_tokens: 200 },
    output_tokens: 0,
    total_tokens: 1000,
  },
} as const

const numerical = {
  requestHash: Result.getOrThrow(prepareJevRequest(request)).requestHash,
  responseHash: 'b'.repeat(64),
  startedAt: '2026-10-22T20:00:00.000Z',
  completedAt: '2026-10-22T20:00:00.400Z',
  response: {
    model: jevModel,
    answers: {
      setup: {
        type: 'choice',
        choice: JevEntrySetup.Upward,
        confidence: 0.8,
        probabilities: { upward: 0.8, unclear: 0.15, adverse: 0.05 },
      },
    },
    usage: { input_tokens: 2000, output_tokens: 200 },
  },
} as const

const visual = {
  startedAt: '2026-10-22T20:00:00.000Z',
  completedAt: '2026-10-22T20:00:00.850Z',
  responseHash: 'c'.repeat(64),
  response: Result.getOrThrow(decodeVisualDecision(visualResponse)),
}

const providers = () =>
  Layer.merge(
    Layer.succeed(JevClient, { evaluate: () => Effect.succeed(numerical) }),
    Layer.succeed(VisualDecisionClient, { evaluate: () => Effect.succeed(visual) }),
  )

describe('OHLCV + Decisions image shadow research', () => {
  test('renders deterministic native candlesticks and a real PNG header', () => {
    const first = Result.getOrThrow(nativeCandlestickEvidence(request))
    expect(first).toEqual(Result.getOrThrow(nativeCandlestickEvidence(request)))
    const image = Buffer.from(first.image.split(',')[1] ?? '', 'base64')
    expect(image.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(image.readUInt32BE(16)).toBe(640)
    expect(image.readUInt32BE(20)).toBe(360)
    expect(first.provenance).toBe('DERIVED_FROM_SAME_NATIVE_OHLCV')
    expect(visualDecisionRequest(first).input[0]?.content[1]?.type).toBe('input_image')
  })

  test('rejects impossible bars, missing bars and unordered evidence', () => {
    for (const changed of [
      bars.map((bar, i) => (i === 3 ? { ...bar, high: 0 } : bar)),
      bars.map((bar, i) => (i === 3 ? { ...bar, minuteBeforeWindowEnd: 60 } : bar)),
      bars.slice(0, 2),
    ]) {
      const updated = Result.getOrThrow(
        prepareJevRequest({ ...request, state: { candidate: { symbol: 'AAPL', bars1m: changed } } }),
      )
      expect(Result.isFailure(verifiedVisualBars(updated.request))).toBe(true)
    }
  })

  test('rejects refusals, invalid usage and duplicate model choices', () => {
    expect(
      Result.isFailure(
        decodeVisualDecision({ ...visualResponse, answers: [{ type: 'refusal', name: 'chart_setup' }] }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decodeVisualDecision({
          ...visualResponse,
          usage: { ...visualResponse.usage, input_tokens_details: { cached_tokens: 900, cache_write_tokens: 900 } },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        decodeVisualDecision({ ...visualResponse, answers: [visualResponse.answers[0], visualResponse.answers[0]] }),
      ),
    ).toBe(true)
  })

  test('two provider calls produce sealed, metered, non-trading comparison', async () => {
    const report = await Effect.runPromise(
      evaluateDualSignalResearch(request, 'AAPL').pipe(Effect.provide(providers())),
    )
    expect(report.comparison).toMatchObject({ status: 'AGREEMENT', jevSetup: JevEntrySetup.Upward })
    expect(report.costs).toMatchObject({
      coverage: 'PROVIDER_METERED',
      jevEstimatedPicoUsd: '84000000',
      openAiEstimatedPicoUsd: '96000000',
    })
    expect(report.numerical).toMatchObject({ status: 'RECEIVED', setup: { choice: JevEntrySetup.Upward } })
    expect(report.visual).toMatchObject({ status: 'RECEIVED', setup: { choice: JevEntrySetup.Upward } })
    expect(report.reportHash).toMatch(/^[a-f0-9]{64}$/)
    expect(report.independentEvidence).toBe(false)
    expect(report.tradingAuthority).toBe('NONE')
  })

  test('provider errors are explicit and do not create a fused trade', async () => {
    const layers = Layer.merge(
      Layer.succeed(JevClient, {
        evaluate: () => Effect.fail(new JevError({ failure: JevFailure.Timeout, message: 'deadline' })),
      }),
      Layer.succeed(VisualDecisionClient, { evaluate: () => Effect.succeed(visual) }),
    )
    const report = await Effect.runPromise(evaluateDualSignalResearch(request).pipe(Effect.provide(layers)))
    expect(report.costs.coverage).toBe('INCOMPLETE')
    expect(report.comparison.status).toBe('INCOMPLETE')
    expect(report.numerical).toEqual({ status: 'UNAVAILABLE', failure: JevFailure.Timeout })
    expect(report.tradingAuthority).toBe('NONE')
  })

  test('binds the complete visual request, not only its image, into report provenance', async () => {
    const image = Result.getOrThrow(nativeCandlestickEvidence(request))
    const body = visualDecisionRequest(image)
    const report = await Effect.runPromise(evaluateDualSignalResearch(request).pipe(Effect.provide(providers())))
    expect(report.schemaVersion).toBe('bayn.dual-signal-shadow-report.v2')
    expect(report.source).toMatchObject({
      visualEndpoint: openAiDecisionsEndpoint,
      visualRequestHash: sha256(JSON.stringify(body)),
    })
    for (const changed of [
      { ...body, model: 'another-model' },
      { ...body, questions: body.questions.map((question) => ({ ...question, instructions: 'Different prompt' })) },
      {
        ...body,
        questions: body.questions.map((question) => ({
          ...question,
          choices: question.choices.map((choice) => ({ ...choice, description: 'Different criterion' })),
        })),
      },
    ])
      expect(sha256(JSON.stringify(changed))).not.toBe(sha256(JSON.stringify(body)))
  })

  test('the report request hash matches the exact body dispatched by the visual client', async () => {
    const bodies: string[] = []
    const http = HttpClient.make((httpRequest, url) => {
      expect(url.toString()).toBe(openAiDecisionsEndpoint)
      expect(httpRequest.method).toBe('POST')
      if (httpRequest.body._tag !== 'Uint8Array') throw new Error('Expected a serialized request')
      bodies.push(new TextDecoder().decode(httpRequest.body.body))
      return Effect.succeed(HttpClientResponse.fromWeb(httpRequest, new Response(JSON.stringify(visualResponse))))
    })
    const live = VisualDecisionClientLive(Redacted.make('secret-key'), 1000).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    )
    const report = await Effect.runPromise(
      evaluateDualSignalResearch(request).pipe(
        Effect.provide(Layer.merge(Layer.succeed(JevClient, { evaluate: () => Effect.succeed(numerical) }), live)),
      ),
    )
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toBe(JSON.stringify(visualDecisionRequest(Result.getOrThrow(nativeCandlestickEvidence(request)))))
    expect(report.source.visualRequestHash).toBe(sha256(bodies[0] ?? ''))
    expect(JSON.stringify(report)).not.toContain('secret-key')
  })

  test('retains verified rejected Jev usage without treating it as a usable decision', async () => {
    const receipt = { model: jevModel, usage: numerical.response.usage }
    const http = HttpClient.make((httpRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          httpRequest,
          new Response(JSON.stringify({ ...receipt, error: 'private-provider-detail' }), { status: 429 }),
        ),
      ),
    )
    const layers = Layer.merge(
      JevClientLive(Redacted.make('secret-key'), 1000).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http))),
      Layer.succeed(VisualDecisionClient, { evaluate: () => Effect.succeed(visual) }),
    )
    const report = await Effect.runPromise(evaluateDualSignalResearch(request).pipe(Effect.provide(layers)))
    expect(report.numerical).toMatchObject({
      status: 'UNAVAILABLE',
      failure: JevFailure.Status,
      httpStatus: 429,
      responseHash: Result.getOrThrow(canonicalHashV1Result(receipt)),
      tokens: receipt.usage,
    })
    expect(report.costs).toMatchObject({ coverage: 'PROVIDER_METERED', jevEstimatedPicoUsd: '84000000' })
    expect(report.comparison.status).toBe('INCOMPLETE')
    expect(report.tradingAuthority).toBe('NONE')
    expect(JSON.stringify(report)).not.toContain('private-provider-detail')
    expect(JSON.stringify(report)).not.toContain('secret-key')
  })

  test('rejects unbound or malformed rejected metering instead of inventing a zero cost', async () => {
    const receipt = { model: jevModel, usage: numerical.response.usage }
    const bound = {
      failure: JevFailure.Status,
      message: 'rejected',
      status: 429,
      requestHash: numerical.requestHash,
      responseHash: Result.getOrThrow(canonicalHashV1Result(receipt)),
      rejectedResponse: Redacted.make(receipt),
    }
    const invalidUsage = { ...receipt, usage: { input_tokens: -1, output_tokens: 0 } }
    for (const fields of [
      { ...bound, responseHash: '0'.repeat(64) },
      { ...bound, requestHash: '0'.repeat(64) },
      {
        failure: JevFailure.Status,
        message: 'no receipt',
        requestHash: numerical.requestHash,
        responseHash: bound.responseHash,
      },
      { ...bound, failure: JevFailure.Transport },
      {
        ...bound,
        rejectedResponse: Redacted.make(invalidUsage),
        responseHash: Result.getOrThrow(canonicalHashV1Result(invalidUsage)),
      },
    ]) {
      const layers = Layer.merge(
        Layer.succeed(JevClient, { evaluate: () => Effect.fail(new JevError(fields)) }),
        Layer.succeed(VisualDecisionClient, { evaluate: () => Effect.succeed(visual) }),
      )
      const report = await Effect.runPromise(evaluateDualSignalResearch(request).pipe(Effect.provide(layers)))
      expect(report.costs).toMatchObject({ coverage: 'INCOMPLETE', jevEstimatedPicoUsd: null })
      expect(report.numerical).not.toHaveProperty('tokens')
    }
  })

  test('retains a redacted transport cause and only a bounded diagnostic in the partial report', async () => {
    let original: unknown
    const http = HttpClient.make((httpRequest) => {
      const error = new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request: httpRequest,
          cause: new Error('private-transport-detail'),
        }),
      })
      original = error
      return Effect.fail(error)
    })
    const live = VisualDecisionClientLive(Redacted.make('secret-key'), 1000).pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
    )
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* VisualDecisionClient
        return yield* client.evaluate({ symbol: 'AAPL', image: 'data:image/png;base64,fixture' }).pipe(Effect.result)
      }).pipe(Effect.provide(live)),
    )
    expect(Result.isFailure(failure)).toBe(true)
    if (Result.isFailure(failure)) {
      expect(failure.failure).toMatchObject({ category: 'PROVIDER', diagnostic: 'TransportError' })
      expect(Redacted.isRedacted(failure.failure.cause)).toBe(true)
      if (Redacted.isRedacted(failure.failure.cause)) expect(Redacted.value(failure.failure.cause)).toBe(original)
    }
    const report = await Effect.runPromise(
      evaluateDualSignalResearch(request).pipe(
        Effect.provide(Layer.merge(Layer.succeed(JevClient, { evaluate: () => Effect.succeed(numerical) }), live)),
      ),
    )
    expect(report.visual).toMatchObject({ status: 'UNAVAILABLE', failure: 'PROVIDER', diagnostic: 'TransportError' })
    expect(JSON.stringify(report)).not.toContain('private-transport-detail')
    expect(JSON.stringify(report)).not.toContain('secret-key')
  })

  test('distinguishes invalid response JSON without disclosing its body', async () => {
    const http = HttpClient.make((httpRequest) =>
      Effect.succeed(HttpClientResponse.fromWeb(httpRequest, new Response('private-invalid-json', { status: 200 }))),
    )
    const result = await Effect.runPromise(
      VisualDecisionClient.pipe(
        Effect.flatMap((client) => client.evaluate({ symbol: 'AAPL', image: 'fixture' })),
        Effect.provide(VisualDecisionClientLive(Redacted.make('secret-key'), 1000)),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.result,
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({ category: 'PROVIDER', diagnostic: 'DecodeError' })
      expect(Redacted.isRedacted(result.failure.cause)).toBe(true)
      expect(JSON.stringify(result.failure)).not.toContain('private-invalid-json')
    }
  })

  test('preserves the bounded timeout and interruption of the single visual dispatch', async () => {
    let calls = 0
    let interrupted = false
    const http = HttpClient.make(() => {
      calls++
      return Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true
          }),
        ),
      )
    })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* VisualDecisionClient
        const fiber = yield* client
          .evaluate({ symbol: 'AAPL', image: 'fixture' })
          .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }))
        yield* TestClock.adjust(1000)
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.scoped,
        Effect.provide(VisualDecisionClientLive(Redacted.make('secret-key'), 1000)),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({ category: 'DEADLINE', diagnostic: 'TimeoutError' })
    expect(calls).toBe(1)
    expect(interrupted).toBe(true)
  })

  test('a sealed symbol mismatch prevents both provider dispatches', async () => {
    const outcome = await Effect.runPromise(
      evaluateDualSignalResearch(request, 'NVDA').pipe(Effect.provide(providers()), Effect.result),
    )
    expect(Result.isFailure(outcome)).toBe(true)
  })
})
