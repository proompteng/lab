import { describe, expect, test } from 'bun:test'
import { Effect, Fiber, Result } from 'effect'

import {
  awaitRestateInvocation,
  decodeRestateAcceptedInvocation,
  restateInvocationCompletionMaximumAttempts,
  restateInvocationMaximumResponseBytes,
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
        'http://restate.example.test:8080/restate/send/BaynExecutionController/account/activateDeployment',
        { schemaVersion: 'bayn.execution-deployment-activation.v2' },
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

  test('stops consuming and cancels a chunked response as soon as its actual size exceeds the limit', async () => {
    let reads = 0
    let cancellations = 0
    const chunk = new Uint8Array(restateInvocationMaximumResponseBytes / 2)
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads += 1
          controller.enqueue(chunk)
          if (reads === 64) controller.close()
        },
        cancel() {
          cancellations += 1
        },
      },
      { highWaterMark: 0 },
    )
    const failure = await Effect.runPromise(
      Effect.flip(
        awaitRestateInvocation(
          'http://restate.example.test:8080',
          invocationId,
          { maximumAttempts: 1, pollIntervalMs: 0, requestTimeoutMs: 10_000 },
          async () =>
            new Response(body, {
              headers: { 'content-type': 'application/json', 'content-length': '1', 'x-restate-id': invocationId },
            }),
        ),
      ),
    )
    expect(failure).toMatchObject({
      operation: 'await',
      cause: new Error('Restate invocation output returned an oversized response'),
    })
    expect(reads).toBe(3)
    expect(cancellations).toBe(1)
    expect(body.locked).toBe(false)
  })

  test('cancels rejected response bodies once without reading them', async () => {
    const cases = [
      { operation: 'send', status: 503, headers: {} },
      { operation: 'send', status: 200, headers: { 'content-type': 'text/plain' } },
      {
        operation: 'send',
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(restateInvocationMaximumResponseBytes + 1),
        },
      },
      { operation: 'await', status: 503, headers: {} },
      { operation: 'await', status: 200, headers: { 'content-type': 'application/json', 'x-restate-id': 'inv_other' } },
      { operation: 'await', status: 470, headers: {} },
    ] as const
    for (const candidate of cases) {
      let reads = 0
      let cancellations = 0
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            reads += 1
            controller.enqueue(new Uint8Array([0]))
          },
          cancel() {
            cancellations += 1
          },
        },
        { highWaterMark: 0 },
      )
      const request = async () => new Response(body, { status: candidate.status, headers: candidate.headers })
      const result = await Effect.runPromise(
        Effect.flip(
          candidate.operation === 'send'
            ? sendRestateInvocation('http://restate.example.test:8080/send', {}, { timeoutMs: 5000 }, request)
            : awaitRestateInvocation(
                'http://restate.example.test:8080',
                invocationId,
                { maximumAttempts: 1, pollIntervalMs: 0, requestTimeoutMs: 5000 },
                request,
              ),
        ),
      )
      expect(result.operation).toBe(candidate.operation)
      expect(reads).toBe(0)
      expect(cancellations).toBe(1)
      expect(body.locked).toBe(false)
    }
  })

  test('decodes UTF-8 across chunks and accepts a complete response at the byte limit', async () => {
    for (const value of [{ label: '€λ🙂', active: true }, 'x'.repeat(restateInvocationMaximumResponseBytes - 2)]) {
      const bytes = new TextEncoder().encode(JSON.stringify(value))
      let offset = 0
      let completions = 0
      let cancellations = 0
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (offset === bytes.byteLength) {
              completions += 1
              controller.close()
              return
            }
            const size = typeof value === 'string' ? 1_024 : 1
            controller.enqueue(bytes.subarray(offset, offset + size))
            offset = Math.min(offset + size, bytes.byteLength)
          },
          cancel() {
            cancellations += 1
          },
        },
        { highWaterMark: 0 },
      )
      const output = await Effect.runPromise(
        awaitRestateInvocation(
          'http://restate.example.test:8080',
          invocationId,
          { maximumAttempts: 1, pollIntervalMs: 0, requestTimeoutMs: 10_000 },
          async () =>
            new Response(body, { headers: { 'content-type': 'application/json', 'x-restate-id': invocationId } }),
        ),
      )
      expect(output).toEqual(value)
      expect(completions).toBe(1)
      expect(cancellations).toBe(0)
      expect(body.locked).toBe(false)
    }
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
          'http://restate.example.test:8080/restate/send/BaynExecutionController/account/activateDeployment',
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

  test('releases a streaming body after request timeout or interruption', async () => {
    for (const interruption of [false, true]) {
      let beginRead: (() => void) | undefined
      const reading = new Promise<void>((resolve) => void (beginRead = resolve))
      let aborts = 0
      let requestAbortSignal: AbortSignal | undefined
      let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            streamController = controller
          },
          pull() {
            beginRead?.()
          },
        },
        { highWaterMark: 0 },
      )
      const request = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (!(init?.signal instanceof AbortSignal)) throw new Error('request did not receive an abort signal')
        const signal = init.signal
        requestAbortSignal = signal
        signal.addEventListener(
          'abort',
          () => {
            aborts += 1
            streamController?.error(signal.reason)
          },
          { once: true },
        )
        return new Response(body, { headers: { 'content-type': 'application/json', 'x-restate-id': invocationId } })
      }
      const operation = awaitRestateInvocation(
        'http://restate.example.test:8080',
        invocationId,
        { maximumAttempts: 1, pollIntervalMs: 0, requestTimeoutMs: interruption ? 5_000 : 5 },
        request,
      )
      if (interruption) {
        const fiber = Effect.runFork(operation)
        await reading
        await Effect.runPromise(Fiber.interrupt(fiber))
      } else {
        const failure = await Effect.runPromise(Effect.flip(operation))
        expect(failure).toMatchObject({ operation: 'await' })
      }
      expect(requestAbortSignal?.aborted).toBe(true)
      expect(aborts).toBe(1)
      expect(body.locked).toBe(false)
    }
  })
})
