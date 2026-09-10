import { describe, expect, mock, test } from 'bun:test'

void mock.module('server-only', () => ({}))
const {
  MAX_CONCURRENT_TENGRI_ACTION_BODIES,
  MAX_CONCURRENT_TENGRI_ACTION_BODIES_PER_SUBJECT,
  MAX_TENGRI_ACTION_BODY_BYTES,
  isTengriRateLimited,
  readTengriJsonBody,
  requireSameOrigin,
  tengriRouteError,
} = await import('./http')

const bodyRequest = (body: ReadableStream<Uint8Array>, signal?: AbortSignal) =>
  new Request('https://proompteng.ai/api/tengri', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
    signal,
  })

const bodySlotState = () =>
  globalThis as typeof globalThis & {
    tengriActiveActionBodies?: number
    tengriActiveActionBodiesBySubject?: Map<string, number>
  }

const pendingBody = (controllers: ReadableStreamDefaultController<Uint8Array>[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controllers.push(controller)
    },
  })

const jsonBody = () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{}'))
      controller.close()
    },
  })

test('preserves the public conversation error code and prevents caching recovery failures', async () => {
  const { TengriUnavailableError } = await import('./grpc')
  const response = tengriRouteError(
    new TengriUnavailableError('Codex conversation could not be found', 404, 'conversation_not_found'),
  )

  expect(response.status).toBe(404)
  expect(response.headers.get('cache-control')).toBe('no-store, max-age=0')
  expect(await response.json()).toEqual({
    error: 'Codex conversation could not be found',
    code: 'conversation_not_found',
  })
})

describe('Tengri BFF request bodies', () => {
  test('parses a bounded UTF-8 JSON body', async () => {
    const request = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body: JSON.stringify({ action: 'create-agent', displayName: 'Tengri' }),
      headers: { 'content-type': 'application/json' },
    })

    expect(await readTengriJsonBody(request)).toEqual({ action: 'create-agent', displayName: 'Tengri' })
  })

  test('rejects declared and streamed oversized bodies with 413', async () => {
    const declared = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body: '{}',
      headers: {
        'content-length': String(MAX_TENGRI_ACTION_BODY_BYTES + 1),
        'content-type': 'application/json',
      },
    })
    const streamed = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body: new Uint8Array(MAX_TENGRI_ACTION_BODY_BYTES + 1),
      headers: { 'content-type': 'application/json' },
    })

    for (const request of [declared, streamed]) {
      const error = await readTengriJsonBody(request).catch((cause: unknown) => cause)
      const response = tengriRouteError(error)
      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ error: 'Tengri action body is too large' })
    }
  })

  test('rejects malformed UTF-8 as invalid JSON without echoing input', async () => {
    const request = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body: new Uint8Array([0xff]),
      headers: { 'content-type': 'application/json' },
    })
    const error = await readTengriJsonBody(request).catch((cause: unknown) => cause)
    const response = tengriRouteError(error)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Request body is invalid JSON' })
  })

  test('accepts the worst common JSON escaping within the editable file limit', async () => {
    const content = '\u0000'.repeat(1024 * 1024)
    const body = JSON.stringify({ action: 'write-file', agentId: 'agent-test', path: '/workspace/nul.txt', content })
    expect(Buffer.byteLength(body)).toBeGreaterThan(5 * 1024 * 1024)
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_TENGRI_ACTION_BODY_BYTES)

    const request = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/json' },
    })
    expect(await readTengriJsonBody(request)).toEqual({
      action: 'write-file',
      agentId: 'agent-test',
      path: '/workspace/nul.txt',
      content,
    })
  })

  test('bounds concurrent body memory and releases capacity after parsing', async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const activeParses = Array.from({ length: MAX_CONCURRENT_TENGRI_ACTION_BODIES }, () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller)
        },
      })
      const request = {
        body,
        headers: new Headers({ 'content-type': 'application/json' }),
      } as Request
      return readTengriJsonBody(request)
    })

    const blockedRequest = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    })
    const blockedError = await readTengriJsonBody(blockedRequest).catch((cause: unknown) => cause)
    const blockedResponse = tengriRouteError(blockedError)
    expect(blockedResponse.status).toBe(429)
    expect(await blockedResponse.json()).toEqual({ error: 'Too many concurrent Tengri action bodies' })

    const encodedBody = new TextEncoder().encode('{}')
    for (const controller of controllers) {
      controller.enqueue(encodedBody)
      controller.close()
    }
    expect(await Promise.all(activeParses)).toEqual(
      Array.from({ length: MAX_CONCURRENT_TENGRI_ACTION_BODIES }, () => ({})),
    )
    expect(await readTengriJsonBody(blockedRequest.clone())).toEqual({})
  })

  test('enforces an inactivity deadline and releases a subject slot without awaiting hostile cancellation', async () => {
    let cancellations = 0
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations += 1
        return new Promise<void>(() => {})
      },
    })
    const pending = readTengriJsonBody(bodyRequest(body), {
      subject: 'github:body-timeout-test',
      totalTimeoutMs: 100,
      inactivityTimeoutMs: 10,
    })
    const timeoutSentinel = Symbol('timeout')
    const result = await Promise.race([
      pending.catch((cause: unknown) => cause),
      new Promise<typeof timeoutSentinel>((resolve) => setTimeout(() => resolve(timeoutSentinel), 500)),
    ])

    expect(result).not.toBe(timeoutSentinel)
    expect(result).toMatchObject({ message: 'Tengri action body timed out', status: 408 })
    expect(cancellations).toBe(1)
    expect(bodySlotState().tengriActiveActionBodies).toBeUndefined()
    expect(bodySlotState().tengriActiveActionBodiesBySubject).toBeUndefined()
    expect(await readTengriJsonBody(bodyRequest(jsonBody()), { subject: 'github:body-timeout-test' })).toEqual({})
  })

  test('enforces the total deadline even when the body makes progress', async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"action":'))
        timer = setTimeout(() => controller.enqueue(new TextEncoder().encode('"slow"}')), 40)
      },
      cancel() {
        if (timer !== undefined) clearTimeout(timer)
      },
    })
    const error = await readTengriJsonBody(bodyRequest(body), {
      totalTimeoutMs: 10,
      inactivityTimeoutMs: 100,
    }).catch((cause: unknown) => cause)

    expect(error).toMatchObject({ message: 'Tengri action body timed out', status: 408 })
    expect(bodySlotState().tengriActiveActionBodies).toBeUndefined()
  })

  test('cancels an in-flight reader when the connected request signal aborts', async () => {
    const controller = new AbortController()
    let cancellations = 0
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations += 1
        return new Promise<void>(() => {})
      },
    })
    const pending = readTengriJsonBody(bodyRequest(body, controller.signal), {
      subject: 'github:body-abort-test',
      totalTimeoutMs: 100,
      inactivityTimeoutMs: 100,
    })
    controller.abort()
    const error = await Promise.race([
      pending.catch((cause: unknown) => cause),
      new Promise<symbol>((resolve) => setTimeout(() => resolve(Symbol('timeout')), 500)),
    ])

    expect(error).toMatchObject({ name: 'AbortError', message: 'Tengri request was canceled' })
    expect(tengriRouteError(error).status).toBe(499)
    expect(cancellations).toBe(1)
    expect(bodySlotState().tengriActiveActionBodies).toBeUndefined()
    expect(bodySlotState().tengriActiveActionBodiesBySubject).toBeUndefined()
  })

  test('returns capacity when getReader fails after slot acquisition', async () => {
    const body = {
      getReader() {
        throw new Error('reader setup failed')
      },
    } as unknown as ReadableStream<Uint8Array>
    const request = {
      body,
      headers: new Headers({ 'content-type': 'application/json' }),
      signal: new AbortController().signal,
    } as unknown as Request
    const error = await readTengriJsonBody(request, { subject: 'github:reader-failure-test' }).catch(
      (cause: unknown) => cause,
    )

    expect(error).toEqual(new Error('reader setup failed'))
    expect(bodySlotState().tengriActiveActionBodies).toBeUndefined()
    expect(bodySlotState().tengriActiveActionBodiesBySubject).toBeUndefined()
  })

  test('limits one authenticated subject while retaining the global body bound', async () => {
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
    const subject = 'github:body-fairness-test'
    const activeForSubject = Array.from({ length: MAX_CONCURRENT_TENGRI_ACTION_BODIES_PER_SUBJECT }, () =>
      readTengriJsonBody(bodyRequest(pendingBody(controllers)), { subject }),
    )
    const sameSubjectError = await readTengriJsonBody(bodyRequest(new ReadableStream()), { subject }).catch(
      (cause: unknown) => cause,
    )
    expect(tengriRouteError(sameSubjectError).status).toBe(429)

    const otherSubject = 'github:body-other-subject-test'
    const activeForOtherSubject = Array.from(
      { length: MAX_CONCURRENT_TENGRI_ACTION_BODIES - MAX_CONCURRENT_TENGRI_ACTION_BODIES_PER_SUBJECT },
      () => readTengriJsonBody(bodyRequest(pendingBody(controllers)), { subject: otherSubject }),
    )
    const globalError = await readTengriJsonBody(bodyRequest(new ReadableStream()), {
      subject: 'github:body-third-test',
    }).catch((cause: unknown) => cause)
    expect(tengriRouteError(globalError).status).toBe(429)

    const encodedBody = new TextEncoder().encode('{}')
    for (const streamController of controllers) {
      streamController.enqueue(encodedBody)
      streamController.close()
    }
    await Promise.all([...activeForSubject, ...activeForOtherSubject])
    expect(bodySlotState().tengriActiveActionBodies).toBeUndefined()
    expect(bodySlotState().tengriActiveActionBodiesBySubject).toBeUndefined()
  })

  test('requires JSON and rejects cross-origin state-changing requests', async () => {
    process.env.BETTER_AUTH_URL = 'https://proompteng.ai'
    const wrongType = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'text/plain' },
    })
    const typeError = await readTengriJsonBody(wrongType).catch((cause: unknown) => cause)
    expect(tengriRouteError(typeError).status).toBe(415)

    const sameOrigin = new Request('https://proompteng.ai/api/tengri', {
      method: 'POST',
      headers: { origin: 'https://proompteng.ai', 'sec-fetch-site': 'same-origin' },
    })
    expect(() => requireSameOrigin(sameOrigin)).not.toThrow()

    for (const origin of ['https://attacker.example', '']) {
      const request = new Request('https://proompteng.ai/api/tengri', {
        method: 'POST',
        headers: origin ? { origin, 'sec-fetch-site': 'cross-site' } : undefined,
      })
      const error = (() => {
        try {
          requireSameOrigin(request)
          return null
        } catch (cause) {
          return cause
        }
      })()
      expect(tengriRouteError(error).status).toBe(403)
    }
  })
})

describe('Tengri BFF request throttling', () => {
  test('enforces the authenticated subject bucket without trusting caller IP headers', () => {
    const state = globalThis as typeof globalThis & {
      tengriRateSweepAt?: number
      tengriRateWindows?: Map<string, { count: number; resetsAt: number }>
    }
    delete state.tengriRateSweepAt
    delete state.tengriRateWindows
    for (let index = 0; index < 120; index += 1) {
      expect(isTengriRateLimited('github:rate-test')).toBe(false)
    }
    expect(isTengriRateLimited('github:rate-test')).toBe(true)
    const windows = Reflect.get(state, 'tengriRateWindows') as
      | Map<string, { count: number; resetsAt: number }>
      | undefined
    expect([...(windows?.keys() ?? [])]).toEqual(['subject:github:rate-test'])
    delete state.tengriRateSweepAt
    delete state.tengriRateWindows
  })
})
