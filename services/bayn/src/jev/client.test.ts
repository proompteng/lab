import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Fiber, Redacted, Result, Stream, Tracer } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientResponse } from 'effect/http'

import { canonicalHashV1Result } from '../hash'
import { makeInferenceCostReport } from '../inference-costs'
import { JevOutcome, makeJevEvaluationReceipt } from './evidence'
import { JevClient, JevClientLive, JevError } from './client'
import { JevFailure, jevEndpoint } from './contract'
import { evaluationRequestFixture, requestFixture, responseFixture } from './test-support'

const key = Redacted.make('test-secret-never-log')
const run = <A, E>(effect: Effect.Effect<A, E, JevClient>, http: HttpClient.HttpClient, timeout = 1000) =>
  effect.pipe(Effect.provide(JevClientLive(key, timeout)), Effect.provideService(HttpClient.HttpClient, http))
const evaluate = JevClient.pipe(Effect.flatMap((client) => client.evaluate(requestFixture)))
const responseClient = (body: unknown, status = 200) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }))),
  )

describe('Jev inference transport', () => {
  test.each([200, 429])(
    'redacts sensitive HTTP headers while retaining trace diagnostics for status %i',
    async (status) => {
      const spans: Tracer.NativeSpan[] = []
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const http = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(status === 200 ? responseFixture() : { error: 'unavailable' }), {
              status,
              headers: {
                'set-cookie': 'private-session-cookie',
                'x-api-key': 'private-provider-key',
                'x-ratelimit-remaining': '199',
              },
            }),
          ),
        ),
      )
      const result = await Effect.runPromise(
        run(Effect.result(evaluate), http).pipe(Effect.provideService(Tracer.Tracer, tracer)),
      )
      expect(Result.isSuccess(result)).toBe(status === 200)
      const requests = spans.filter((span) => span.name === 'http.client POST')
      expect(requests).toHaveLength(1)
      const span = requests[0]
      expect(span).toBeDefined()
      if (span === undefined) throw new Error('Jev HTTP trace is missing')
      expect(span.attributes.get('http.request.header.authorization')).toBe('<redacted>')
      expect(span.attributes.get('http.response.header.set-cookie')).toBe('<redacted>')
      expect(span.attributes.get('http.response.header.x-api-key')).toBe('<redacted>')
      expect(span.attributes.get('http.response.header.x-ratelimit-remaining')).toBe('199')
      expect(span.attributes.get('http.response.status_code')).toBe(status)
      expect(JSON.stringify([...span.attributes])).not.toContain(Redacted.value(key))
    },
  )

  test('uses the fixed endpoint and returns replayable hashes with recorded response', async () => {
    let calls = 0
    const http = HttpClient.make((request, url) => {
      calls += 1
      expect(url.toString()).toBe(jevEndpoint)
      expect(request.method).toBe('POST')
      expect(request.headers['authorization']).toBe(`Bearer ${Redacted.value(key)}`)
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(responseFixture()))))
    })
    const result = await Effect.runPromise(run(evaluate, http))
    expect(calls).toBe(1)
    expect(result.response).toEqual(responseFixture())
    expect(result.requestHash).toBe(Result.getOrThrow(canonicalHashV1Result(requestFixture)))
    expect(result.responseHash).toBe(Result.getOrThrow(canonicalHashV1Result(responseFixture())))
    expect(Date.parse(result.completedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt))
  })

  test.each([401, 422, 429, 529])('retains status %i without retry or alternate model', async (status) => {
    const result = await Effect.runPromise(
      run(Effect.result(evaluate), responseClient({ error: 'unavailable' }, status)),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.failure).toBe(JevFailure.Status)
      expect(result.failure.status).toBe(status)
      expect(JSON.stringify(result.failure)).not.toContain(Redacted.value(key))
    }
  })

  test.each([422, 503, 529])(
    'preserves metered failure body for status %i without authorizing inference',
    async (status) => {
      const usage = { model: requestFixture.model, usage: { input_tokens: 7858, output_tokens: 150 } }
      const body = {
        ...usage,
        error: 'fixture rejection',
        echoedRequest: requestFixture,
        authorization: Redacted.value(key),
      }
      let calls = 0
      const http = HttpClient.make((request) => {
        calls += 1
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })))
      })
      const result = await Effect.runPromise(run(Effect.result(evaluate), http))
      expect(calls).toBe(1)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.failure).toBe(JevFailure.Status)
        expect(result.failure.status).toBe(status)
        expect(result.failure.responseHash).toBe(Result.getOrThrow(canonicalHashV1Result(usage)))
        expect(result.failure.rejectedResponse).toBeDefined()
        if (result.failure.rejectedResponse !== undefined)
          expect(Redacted.value(result.failure.rejectedResponse)).toEqual(usage)
        expect(JSON.stringify(result.failure)).not.toContain('fixture rejection')
      }
    },
  )

  test.each([
    '',
    '<html>unavailable</html>',
    '{invalid',
    JSON.stringify({ error: 'unavailable' }),
    JSON.stringify({ model: 'unexpected-model', usage: { input_tokens: 10, output_tokens: 1 } }),
    JSON.stringify({ model: requestFixture.model, usage: { input_tokens: -1, output_tokens: 1 } }),
    JSON.stringify({ model: requestFixture.model, usage: { input_tokens: 1.5, output_tokens: 1 } }),
  ])('keeps missing or invalid HTTP failure usage unknown: %s', async (body) => {
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 503 }))),
    )
    const result = await Effect.runPromise(run(Effect.result(evaluate), http))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.failure).toBe(JevFailure.Status)
      expect(result.failure.status).toBe(503)
      expect(result.failure.responseHash).toBeUndefined()
      expect(result.failure.rejectedResponse).toBeUndefined()
    }
  })

  test.each([8192, 8193])('bounds failure JSON to %i bytes before retaining usage', async (length) => {
    const usage = { model: requestFixture.model, usage: { input_tokens: 10, output_tokens: 1 } }
    const prefix = JSON.stringify({ ...usage, padding: '' })
    const body = JSON.stringify({ ...usage, padding: 'x'.repeat(length - prefix.length) })
    expect(new TextEncoder().encode(body).byteLength).toBe(length)
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 503 }))),
    )
    const result = await Effect.runPromise(run(Effect.result(evaluate), http))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.failure).toBe(JevFailure.Status)
      expect(result.failure.status).toBe(503)
      expect(result.failure.responseHash).toBe(
        length === 8192 ? Result.getOrThrow(canonicalHashV1Result(usage)) : undefined,
      )
      if (result.failure.rejectedResponse !== undefined)
        expect(Redacted.value(result.failure.rejectedResponse)).toEqual(usage)
      else expect(length).toBe(8193)
    }
  })

  test('cancels an oversized unfinished failure body after the byte ceiling', async () => {
    let cancelled = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8193))
      },
      cancel() {
        cancelled += 1
      },
    })
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 503 }))),
    )
    const result = await Effect.runPromise(run(Effect.result(evaluate), http))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.failure).toBe(JevFailure.Status)
      expect(result.failure.rejectedResponse).toBeUndefined()
    }
    expect(cancelled).toBe(1)
  })

  test.each(['deadline', 'interruption'] as const)('cancels an unfinished failure body once on %s', async (end) => {
    let reading = false
    let cancelled = 0
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reading = true
      },
      cancel() {
        cancelled += 1
      },
    })
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 503 }))),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* run(Effect.result(evaluate), http).pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Effect.yieldNow
          expect(reading).toBe(true)
          if (end === 'deadline') {
            yield* TestClock.adjust(1000)
            const result = yield* Fiber.join(fiber)
            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure.failure).toBe(JevFailure.Timeout)
              expect(result.failure.rejectedResponse).toBeUndefined()
            }
          } else yield* Fiber.interrupt(fiber)
          expect(cancelled).toBe(1)
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    )
  })

  test('preserves HTTP status when reading its error body fails', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('synthetic stream failure'))
      },
    })
    const http = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status: 503 }))),
    )
    const result = await Effect.runPromise(run(Effect.result(evaluate), http))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.failure).toBe(JevFailure.Status)
      expect(result.failure.status).toBe(503)
      expect(result.failure.rejectedResponse).toBeUndefined()
    }
  })

  test('propagates failure-body stream defects rather than converting them to unknown usage', async () => {
    const defect = new Error('synthetic failure-body defect')
    const http = HttpClient.make((request) => {
      const response = HttpClientResponse.fromWeb(request, new Response('', { status: 503 }))
      Object.defineProperty(response, 'stream', { value: Stream.die(defect) })
      return Effect.succeed(response)
    })
    const exit = await Effect.runPromiseExit(run(evaluate, http))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect)
  })

  test('meters the exact retained failure projection once while missing prices remain unknown', async () => {
    const request = evaluationRequestFixture()
    const usage = { model: request.request.model, usage: { input_tokens: 7858, output_tokens: 150 } }
    const body = {
      ...usage,
      error: 'fixture rejection',
      echoedRequest: request.request,
      authorization: Redacted.value(key),
    }
    const result = await Effect.runPromise(run(Effect.result(evaluate), responseClient(body, 503)))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isSuccess(result)) return
    const receipt = Result.getOrThrow(
      makeJevEvaluationReceipt(request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v1',
        requestId: request.requestId,
        startedAt: request.observedAt,
        completedAt: request.observedAt,
        outcome: {
          status: JevOutcome.Failed,
          failure: result.failure.failure,
          httpStatus: result.failure.status,
          responseHash: result.failure.responseHash,
          rejectedResponse:
            result.failure.rejectedResponse === undefined ? null : Redacted.value(result.failure.rejectedResponse),
        },
      }),
    )
    const row = {
      requestId: request.requestId,
      cycleId: request.cycleId,
      authorityGenerationHash: request.authorityGenerationHash,
      request,
      receipt,
      resolution: null,
    }
    const report = Result.getOrThrow(
      makeInferenceCostReport(
        {
          schemaVersion: 'bayn.inference-cost-evidence.v1',
          accountBindingHash: 'a'.repeat(64),
          sessionDate: '1970-01-01',
          asOf: request.expiresAt,
          requests: [row, row],
        },
        { schemaVersion: 'bayn.inference-rate-card.v1', rates: [] },
      ),
    )
    expect(report).toMatchObject({
      requestCount: 1,
      meteredRequestCount: 1,
      rejectedResponseUsageCount: 1,
      unknownUsageCount: 0,
      unpricedUsageCount: 1,
      inputTokens: '7858',
      outputTokens: '150',
      estimatedTotalCostMicros: null,
      invoiceReconciled: false,
    })
    expect(receipt.outcome.status).toBe(JevOutcome.Failed)
    expect(JSON.stringify(receipt)).not.toContain('fixture rejection')
    expect(JSON.stringify(receipt)).not.toContain(Redacted.value(key))
    expect(JSON.stringify(receipt)).not.toContain('echoedRequest')
  })

  test('retains approximately normalized probabilities and their original response hash', async () => {
    const body = responseFixture()
    body.answers.direction.probabilities = { favorable: 0.93, unfavorable: 0.05, unclear: 0.01 }
    const result = await Effect.runPromise(run(evaluate, responseClient(body)))
    expect(result.response).toEqual(body)
    expect(result.responseHash).toBe(Result.getOrThrow(canonicalHashV1Result(body)))
  })

  test('preserves rejected raw response and hash for evidence without printing its contents', async () => {
    const body = responseFixture()
    body.answers.direction.probabilities = { favorable: 0.9, unfavorable: 0.05, unclear: 0.01 }
    const result = await Effect.runPromise(run(Effect.result(evaluate), responseClient(body)))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure.failure).toBe(JevFailure.Response)
      expect(result.failure.responseHash).toBe(Result.getOrThrow(canonicalHashV1Result(body)))
      expect(result.failure.rejectedResponse).toBeDefined()
      if (result.failure.rejectedResponse !== undefined) {
        expect(Redacted.value(result.failure.rejectedResponse)).toEqual(body)
      }
      expect(JSON.parse(JSON.stringify(result.failure)).rejectedResponse).toBe('<redacted>')
    }
  })

  test('cancels in-flight inference on deadline and finalizes it once', async () => {
    let started = 0
    let stopped = 0
    const http = HttpClient.make(() =>
      Effect.sync(() => {
        started += 1
      }).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            stopped += 1
          }),
        ),
      ),
    )
    const program = Effect.scoped(
      Effect.gen(function* () {
        const fiber = yield* run(Effect.result(evaluate), http).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(started).toBe(1)
        yield* TestClock.adjust(1000)
        const result = yield* Fiber.join(fiber)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) expect(result.failure.failure).toBe(JevFailure.Timeout)
        expect(stopped).toBe(1)
      }),
    ).pipe(Effect.provide(TestClock.layer()))
    await Effect.runPromise(program)
  })

  test('caller interruption cancels the HTTP operation without returning an inference', async () => {
    let stopped = 0
    const http = HttpClient.make(() =>
      Effect.never.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            stopped += 1
          }),
        ),
      ),
    )
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* run(evaluate, http).pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
          expect(stopped).toBe(1)
        }),
      ),
    )
  })

  test('does not turn a programming defect into a recoverable no-signal answer', async () => {
    const defect = new Error('programming defect')
    const exit = await Effect.runPromiseExit(
      run(
        evaluate,
        HttpClient.make(() => Effect.die(defect)),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect)
  })

  test('rejects invalid startup timeout before sending any request', async () => {
    let calls = 0
    const http = HttpClient.make(() => {
      calls += 1
      return Effect.die('unexpected request')
    })
    const exit = await Effect.runPromiseExit(run(evaluate, http, 0))
    expect(calls).toBe(0)
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(JevError)
  })
})
