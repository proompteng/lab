import { expect, test } from 'bun:test'
import { Effect, Fiber, Result } from 'effect'
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http'
import { TestClock } from 'effect/testing'

import type { ExecutionControllerHealth } from '../execution/controller-health'
import {
  ExecutionControllerOutcome,
  ExecutionControllerStatusStoreError,
  type ExecutionControllerStatus,
} from '../execution/controller-status'
import { makeExecutionControllerHealthReader } from './controller-client'

const controllerKey = 'a'.repeat(64)
const origin = 'http://restate.restate.svc.cluster.local:8080'
const operational: ExecutionControllerHealth = {
  schemaVersion: 'bayn.execution-controller-health.v1',
  controllerKey,
  planHash: 'b'.repeat(64),
  sourceRevision: 'c'.repeat(40),
  active: true,
  epoch: 1,
  nextSequence: 2,
  pendingWake: { sequence: 2, acceptedAt: '2026-11-11T18:00:00.000Z' },
}
const completion: ExecutionControllerStatus = {
  schemaVersion: 1,
  controllerKey,
  planHash: operational.planHash,
  active: true,
  epoch: 1,
  nextSequence: 2,
  lastSequence: 1,
  lastOutcome: ExecutionControllerOutcome.Waiting,
  lastReceiptHash: 'd'.repeat(64),
  completedAt: '2026-11-11T17:59:59.000Z',
}
const response = (body: string, status = 200) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))))

test('reads sanitized operational health before immutable SQL completion without control credentials', async () => {
  const order: string[] = []
  const http = HttpClient.make((request) => {
    order.push('operational')
    expect(request.method).toBe('POST')
    expect(request.url).toBe(`${origin}/BaynExecutionController/${controllerKey}/health`)
    expect(request.headers['authorization']).toBeUndefined()
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.headers['accept']).toBe('application/json')
    if (request.body._tag !== 'Uint8Array') throw new Error('expected the health request JSON body')
    expect(new TextDecoder().decode(request.body.body)).toBe('{}')
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(operational))))
  })
  const read = makeExecutionControllerHealthReader(
    http,
    origin,
    (key) =>
      Effect.sync(() => {
        order.push('completion')
        expect(key).toBe(controllerKey)
        return completion
      }),
    1_000,
  )
  expect(await Effect.runPromise(read(controllerKey))).toEqual({ operational, status: completion })
  expect(order).toEqual(['operational', 'completion'])
})

test.each([404, 500, 503])('rejects HTTP %i without falling back to a successful SQL completion', async (status) => {
  let reads = 0
  const read = makeExecutionControllerHealthReader(
    response('private upstream body', status),
    origin,
    () =>
      Effect.sync(() => {
        reads++
        return completion
      }),
    1_000,
  )
  const result = await Effect.runPromise(read(controllerKey).pipe(Effect.result))
  expect(result).toMatchObject({
    _tag: 'Failure',
    failure: {
      _tag: 'OperationalError',
      component: 'http',
      operation: 'execution-controller-health',
      message: `execution controller operational health returned HTTP ${status}`,
    },
  })
  expect(JSON.stringify(result)).not.toContain('private upstream body')
  expect(reads).toBe(0)
})

test('releases an unread non-success response when the health probe ends', async () => {
  let signal: AbortSignal | undefined
  const http = HttpClient.make((request, _url, requestSignal) => {
    signal = requestSignal
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('unread upstream body', { status: 503 })))
  })
  const read = makeExecutionControllerHealthReader(http, origin, () => Effect.succeed(completion), 1_000)
  expect(await Effect.runPromise(read(controllerKey).pipe(Effect.result))).toMatchObject({ _tag: 'Failure' })
  expect(signal?.aborted).toBe(true)
})

test.each([
  'not JSON',
  '{}',
  JSON.stringify({ ...operational, receiptHash: 'e'.repeat(64) }),
  JSON.stringify({ ...operational, pendingWake: { sequence: 2, acceptedAt: 'invalid' } }),
  JSON.stringify({ ...operational, sourceRevision: 'wrong-source' }),
])('rejects malformed operational data without a SQL fallback: %s', async (body) => {
  let reads = 0
  const read = makeExecutionControllerHealthReader(
    response(body),
    origin,
    () =>
      Effect.sync(() => {
        reads++
        return completion
      }),
    1_000,
  )
  expect(await Effect.runPromise(read(controllerKey).pipe(Effect.result))).toMatchObject({
    _tag: 'Failure',
    failure: { _tag: 'OperationalError', message: 'execution controller operational health response is invalid' },
  })
  expect(reads).toBe(0)
})

test('keeps an absent operational owner explicit rather than synthesizing it from SQL', async () => {
  const read = makeExecutionControllerHealthReader(response('null'), origin, () => Effect.succeed(completion), 1_000)
  expect(await Effect.runPromise(read(controllerKey))).toEqual({ operational: null, status: completion })
})

test('retains transport failure context without attempting the SQL completion read', async () => {
  let reads = 0
  const http = HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: 'fixture connection refused' }),
      }),
    ),
  )
  const read = makeExecutionControllerHealthReader(
    http,
    origin,
    () =>
      Effect.sync(() => {
        reads++
        return completion
      }),
    1_000,
  )
  const result = await Effect.runPromise(read(controllerKey).pipe(Effect.result))
  expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'OperationalError', component: 'http' } })
  if (Result.isSuccess(result)) throw new Error('expected a transport failure')
  expect(result.failure).toHaveProperty('cause')
  expect(reads).toBe(0)
})

test('retains an actual SQL failure after a valid operational read', async () => {
  const failure = new ExecutionControllerStatusStoreError({
    operation: 'read',
    failure: 'query',
    message: 'fixture SQL completion read failed',
  })
  const read = makeExecutionControllerHealthReader(
    response(JSON.stringify(operational)),
    origin,
    () => Effect.fail(failure),
    1_000,
  )
  const result = await Effect.runPromise(read(controllerKey).pipe(Effect.result))
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isSuccess(result)) throw new Error('expected the SQL completion read to fail')
  expect(result.failure).toBe(failure)
})

test.each(['timeout', 'interruption'] as const)('cancels an outstanding HTTP read exactly once on %s', async (end) => {
  let cancelled = 0
  let reads = 0
  const http = HttpClient.make(() =>
    Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          cancelled++
        }),
      ),
    ),
  )
  const read = makeExecutionControllerHealthReader(
    http,
    origin,
    () =>
      Effect.sync(() => {
        reads++
        return completion
      }),
    50,
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* read(controllerKey).pipe(Effect.result, Effect.forkScoped({ startImmediately: true }))
        yield* Effect.yieldNow
        if (end === 'timeout') {
          yield* TestClock.adjust(50)
          expect(yield* Fiber.join(pending)).toMatchObject({
            _tag: 'Failure',
            failure: { _tag: 'OperationalError', message: 'execution controller health read timed out after 50ms' },
          })
        } else yield* Fiber.interrupt(pending)
        expect(cancelled).toBe(1)
        expect(reads).toBe(0)
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})

test('the same probe deadline cancels a stuck SQL read after the operational response', async () => {
  let cancelled = 0
  const read = makeExecutionControllerHealthReader(
    response(JSON.stringify(operational)),
    origin,
    () =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            cancelled++
          }),
        ),
      ),
    50,
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pending = yield* read(controllerKey).pipe(Effect.result, Effect.forkScoped({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust(50)
        expect(yield* Fiber.join(pending)).toMatchObject({ _tag: 'Failure', failure: { _tag: 'OperationalError' } })
        expect(cancelled).toBe(1)
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  )
})
