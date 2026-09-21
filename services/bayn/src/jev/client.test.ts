import { describe, expect, test } from 'bun:test'
import { Cause, Effect, Exit, Fiber, Redacted, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import { canonicalHashV1Result } from '../hash'
import { JevClient, JevClientLive, JevError } from './client'
import { JevFailure, jevEndpoint } from './contract'
import { requestFixture, responseFixture } from './test-support'

const key = Redacted.make('test-secret-never-log')
const run = <A, E>(effect: Effect.Effect<A, E, JevClient>, http: HttpClient.HttpClient, timeout = 1000) =>
  effect.pipe(Effect.provide(JevClientLive(key, timeout)), Effect.provideService(HttpClient.HttpClient, http))
const evaluate = JevClient.pipe(Effect.flatMap((client) => client.evaluate(requestFixture)))
const responseClient = (body: unknown, status = 200) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status }))),
  )

describe('Jev inference transport', () => {
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

  test('preserves rejected raw response and hash for evidence without printing its contents', async () => {
    const body = responseFixture()
    body.answers.direction.probabilities = { favorable: 0.93, unfavorable: 0.05, unclear: 0.01 }
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
