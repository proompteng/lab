import { describe, expect, test } from 'bun:test'
import { Effect, Fiber, Result } from 'effect'

import {
  awaitRestateInvocation,
  decodeRestateAcceptedInvocation,
  restateInvocationCompletionMaximumAttempts,
  RestateSendStatus,
  sendRestateInvocation,
  type RestateHttpRequest,
} from './restate-invocation-client'

const invocationId = 'inv_1aiqX0vFEFNH1Umgre58JiCLgHfTtztYK5'

describe('Restate invocation client', () => {
  test('accepts only closed send receipts', () => {
    expect(Result.isSuccess(decodeRestateAcceptedInvocation({ invocationId, status: 'Accepted' }))).toBe(true)
    expect(
      Result.isSuccess(
        decodeRestateAcceptedInvocation({
          invocationId,
          executionTime: '2026-08-13T13:30:00Z',
          status: 'PreviouslyAccepted',
        }),
      ),
    ).toBe(true)
    expect(Result.isFailure(decodeRestateAcceptedInvocation({ invocationId: 'other', status: 'Accepted' }))).toBe(true)
    expect(Result.isFailure(decodeRestateAcceptedInvocation({ invocationId, status: 'Done' }))).toBe(true)
    expect(Result.isFailure(decodeRestateAcceptedInvocation({ invocationId, status: 'Accepted', extra: true }))).toBe(
      true,
    )
  })

  test('sends with bounded JSON and returns the accepted receipt', async () => {
    const requests: Array<{ readonly body: unknown; readonly headers: Headers; readonly url: string }> = []
    const receipt = await Effect.runPromise(
      sendRestateInvocation(
        'http://restate.example.test:8080/restate/send/BaynExecutionBootstrap/start',
        { schemaVersion: 'bayn.execution-controller-bootstrap.v1' },
        { headers: { authorization: 'Bearer secret', 'idempotency-key': 'request-1' }, timeoutMs: 30_000 },
        async (input, init) => {
          if (typeof init?.body !== 'string') throw new Error('request body was not encoded as JSON')
          requests.push({
            body: JSON.parse(init.body) as unknown,
            headers: new Headers(init?.headers),
            url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          })
          return new Response(JSON.stringify({ invocationId, status: 'Accepted' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          })
        },
      ),
    )

    expect(receipt).toEqual({ invocationId, status: RestateSendStatus.Accepted })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer secret')
    expect(requests[0]?.headers.get('idempotency-key')).toBe('request-1')
  })

  test('waits for the matching invocation and returns bounded JSON output', async () => {
    const responses = [
      new Response(JSON.stringify({ message: 'pending' }), {
        status: 470,
        headers: { 'content-type': 'application/json' },
      }),
      new Response(JSON.stringify({ active: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-restate-id': invocationId },
      }),
    ]
    const output = await Effect.runPromise(
      awaitRestateInvocation(
        'http://restate.example.test:8080',
        invocationId,
        { maximumAttempts: 2, pollIntervalMs: 0, requestTimeoutMs: 10_000 },
        async () => {
          const response = responses.shift()
          if (response === undefined) throw new Error('unexpected output poll')
          return response
        },
      ),
    )

    expect(output).toEqual({ active: true })
    expect(restateInvocationCompletionMaximumAttempts(30_000, 3_000)).toBe(11)
  })

  test('fails closed on identity mismatch, non-JSON, oversize, and bounded exhaustion', async () => {
    const cases = [
      () =>
        new Response(JSON.stringify({ active: true }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-restate-id': 'inv_other' },
        }),
      () => new Response('active', { status: 200, headers: { 'x-restate-id': invocationId } }),
      () =>
        new Response(JSON.stringify({ active: true }), {
          status: 200,
          headers: {
            'content-length': String(17 * 1024),
            'content-type': 'application/json',
            'x-restate-id': invocationId,
          },
        }),
    ]
    for (const response of cases) {
      const failure = await Effect.runPromise(
        Effect.flip(
          awaitRestateInvocation(
            'http://restate.example.test:8080',
            invocationId,
            { maximumAttempts: 1, pollIntervalMs: 0, requestTimeoutMs: 10_000 },
            async () => response(),
          ),
        ),
      )
      expect(failure).toMatchObject({ operation: 'await' })
    }

    const exhausted = await Effect.runPromise(
      Effect.flip(
        awaitRestateInvocation(
          'http://restate.example.test:8080',
          invocationId,
          { maximumAttempts: 1, pollIntervalMs: 0, requestTimeoutMs: 10_000 },
          async () => new Response(null, { status: 470 }),
        ),
      ),
    )
    expect(exhausted.message).toBe('Restate invocation remains incomplete after the bounded completion check')
  })

  test('aborts send and completion I/O when interrupted', async () => {
    const effects = [
      (request: RestateHttpRequest) =>
        sendRestateInvocation(
          'http://restate.example.test:8080/restate/send/BaynExecutionBootstrap/start',
          {},
          { timeoutMs: 30_000 },
          request,
        ),
      (request: RestateHttpRequest) =>
        awaitRestateInvocation(
          'http://restate.example.test:8080',
          invocationId,
          { maximumAttempts: 1, pollIntervalMs: 0, requestTimeoutMs: 10_000 },
          request,
        ),
    ]
    for (const makeEffect of effects) {
      let captureSignal: ((signal: AbortSignal) => void) | undefined
      const observedSignal = new Promise<AbortSignal>((resolve) => void (captureSignal = resolve))
      const request = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (!(init?.signal instanceof AbortSignal)) throw new Error('request did not receive an abort signal')
        captureSignal?.(init.signal)
        return new Promise((_resolve, reject) =>
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }),
        )
      }
      const fiber = Effect.runFork(makeEffect(request))
      const signal = await observedSignal
      expect(signal.aborted).toBe(false)
      await Effect.runPromise(Fiber.interrupt(fiber))
      expect(signal.aborted).toBe(true)
    }
  })
})
