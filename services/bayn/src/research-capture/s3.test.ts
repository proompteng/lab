import { expect, test } from 'bun:test'
import { Readable } from 'node:stream'
import type { S3ClientConfig, S3ClientResolvedConfig } from '@aws-sdk/client-s3'
import { Deferred, Effect, Exit, Fiber, Redacted, Result, Tracer } from 'effect'
import { TestClock } from 'effect/testing'

import { provideTestLayer } from '../effect-test-support'
import { captureKafkaTransport } from './capture'
import { captureEvent, marketEvent, recoverCaptureFromStoredObjects } from './capture.test-support'
import { researchCaptureObject, researchCaptureObjectKey, type ResearchCaptureObject } from './export'
import { makeResearchCaptureRecorder, type ResearchCaptureStore } from './recorder'
import { makeS3ResearchCaptureObjectStore } from './s3'

const options = {
  endpoint: 'http://fixture.invalid',
  bucket: 'synthetic-captures',
  region: '',
  accessKeyId: Redacted.make('synthetic-access'),
  secretAccessKey: Redacted.make('synthetic-secret'),
  timeoutMs: 100,
}
type Request = Parameters<S3ClientResolvedConfig['requestHandler']['handle']>[0]
type RequestOptions = { readonly abortSignal?: AbortSignal }
type Fault =
  | 'none'
  | 'existing'
  | 'wrong-existing'
  | 'lost-ack'
  | '503'
  | '409'
  | 'truncated'
  | 'oversized'
  | 'wrong-bytes'
  | 'wrong-length'
  | 'stream-error'
const captureSpans = () => {
  const spans: Tracer.NativeSpan[] = []
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    },
  })
  return { spans, tracer }
}
const fixture = (fault: Fault = 'none') => {
  const requests: Array<{ method: string; conditional: string | undefined; path: string }> = []
  let stored = Buffer.from('fixture payload')
  let destroys = 0
  let readback: Readable | undefined
  const handler: S3ClientConfig['requestHandler'] = {
    handle: async (request: Request) => {
      requests.push({ method: request.method, conditional: request.headers['if-none-match'], path: request.path })
      if (request.method === 'PUT') {
        if (fault === '503' || fault === '409' || fault === 'existing' || fault === 'wrong-existing') {
          const statusCode = fault === '503' ? 503 : fault === '409' ? 409 : 412
          return {
            response: {
              statusCode,
              headers: { 'content-type': 'application/xml' },
              body: Readable.from([
                Buffer.from(
                  `<Error><Code>${statusCode === 412 ? 'PreconditionFailed' : 'ServiceUnavailable'}</Code></Error>`,
                ),
              ]),
            },
          }
        }
        if (!(request.body instanceof Uint8Array)) throw new Error('Expected binary request body')
        stored = Buffer.from(request.body)
        if (fault === 'lost-ack') throw new Error('Acknowledgement lost after commit')
        return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } }
      }
      const payload =
        fault === 'truncated'
          ? stored.subarray(0, 2)
          : fault === 'oversized'
            ? Buffer.concat([stored, Buffer.from([1])])
            : fault === 'wrong-existing' || fault === 'wrong-bytes'
              ? Buffer.alloc(stored.length, 0xff)
              : stored
      readback =
        fault === 'stream-error'
          ? Readable.from(
              (async function* () {
                yield payload.subarray(0, 2)
                throw new Error('Read failed')
              })(),
            )
          : Readable.from([payload.subarray(0, 2), payload.subarray(2)])
      return {
        response: {
          statusCode: 200,
          headers: { 'content-length': String(fault === 'wrong-length' ? stored.length + 1 : stored.length) },
          body: readback,
        },
      }
    },
    destroy: () => {
      destroys++
    },
  }
  return {
    handler,
    requests,
    stored: () => stored,
    destroys: () => destroys,
    readback: () => readback,
    ...captureSpans(),
  }
}

test('the recorder verifies one binary frame with two S3 requests before SQL and verifies both terminal objects', async () => {
  const objects = new Map<string, ResearchCaptureObject>()
  const requests: string[] = []
  const writes: string[] = []
  const chunks: Parameters<ResearchCaptureStore['append']>[0][] = []
  const seals: Parameters<ResearchCaptureStore['seal']>[0][] = []
  let destroys = 0
  const handler: S3ClientConfig['requestHandler'] = {
    handle: async (request: Request) => {
      requests.push(request.method)
      const key = request.path.slice('/synthetic-captures/'.length)
      if (request.method === 'PUT') {
        if (request.headers['if-none-match'] !== '*' || !(request.body instanceof Uint8Array))
          throw new Error('Expected one conditional binary write')
        const object = researchCaptureObject(Buffer.from(request.body))
        if (researchCaptureObjectKey(object.contentHash) !== key) throw new Error('Wrong content address')
        objects.set(key, object)
        writes.push('put')
        return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } }
      }
      const object = objects.get(key)
      if (object === undefined) throw new Error('Readback omitted a preceding write')
      writes.push('get')
      return {
        response: {
          statusCode: 200,
          headers: { 'content-length': String(object.payload.byteLength) },
          body: Readable.from([object.payload]),
        },
      }
    },
    destroy: () => {
      destroys++
    },
  }
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(100)
        const objectStore = yield* makeS3ResearchCaptureObjectStore(options, handler)
        const recorder = yield* makeResearchCaptureRecorder(
          {
            append: (bytes) =>
              Effect.sync(() => {
                writes.push('sql-chunk')
                chunks.push(bytes)
              }),
            seal: (bytes) =>
              Effect.sync(() => {
                writes.push('sql-seal')
                seals.push(bytes)
              }),
          },
          {
            captureId: 'native-s3-fixture',
            sourceRevision: 'a'.repeat(40),
            maximumQueuedReceipts: 32,
            maximumQueuedBytes: 256 * 1024,
            maximumReceiptBytes: 4096,
            flushIntervalMs: 10,
            writeTimeoutMs: 100,
          },
          objectStore,
        )
        recorder.record(captureEvent('STARTED'), 100)
        recorder.record({ ...marketEvent, originalTransport: captureKafkaTransport(100) }, 100, Buffer.from('é'))
        recorder.record(captureEvent('STOPPED'), 100)
        yield* recorder.finish
        expect((yield* recorder.status).invalidations).toEqual([])
      }),
    ).pipe(provideTestLayer(TestClock.layer())),
  )
  expect(requests.filter((method) => method === 'PUT')).toHaveLength(3)
  expect(requests.filter((method) => method === 'GET')).toHaveLength(3)
  expect(writes.slice(0, 3)).toEqual(['put', 'get', 'sql-chunk'])
  expect(writes.at(-1)).toBe('sql-seal')
  expect(objects.size).toBe(3)
  expect(destroys).toBe(1)
  const verified = Result.getOrThrow(recoverCaptureFromStoredObjects(chunks, seals[0], (key) => objects.get(key)))
  expect(verified.structurallyClosed).toBe(true)
  expect(verified.complete).toBe(false)
})

test.each(['none', 'existing'] as const)(
  'S3 %s path uses one conditional put then exact full readback',
  async (fault) => {
    const server = fixture(fault)

    const object = researchCaptureObject(Buffer.from('fixture payload'))
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeS3ResearchCaptureObjectStore(options, server.handler)
          yield* store.putVerified(object)
        }),
      ).pipe(Effect.provideService(Tracer.Tracer, server.tracer)),
    )
    expect(server.requests.map((request) => request.method)).toEqual(['PUT', 'GET'])
    expect(server.requests[0]?.conditional).toBe('*')
    expect(server.requests[0]?.path).toBe(`/synthetic-captures/research-capture/sha256/${object.contentHash}`)
    expect(server.destroys()).toBe(1)
    expect(server.readback()?.destroyed).toBe(true)
    expect(server.spans).toHaveLength(1)
    expect(server.spans[0]?.name).toBe('bayn.capture.object.put_verified')
    expect(Object.fromEntries(server.spans[0]?.attributes ?? [])).toEqual({
      'bayn.dependency': 'object-storage',
      'bayn.operation': 'PUT_VERIFIED',
      'bayn.capture.object.bytes': object.payload.byteLength,
      'bayn.capture.object.phase': 'VERIFIED',
      'bayn.capture.object.sha256': object.contentHash,
    })
    expect(server.spans[0]?.events.map(([name, , attributes]) => ({ name, attributes }))).toEqual([
      { name: 'bayn.capture.object.put.started', attributes: {} },
      {
        name: 'bayn.capture.object.put.acknowledged',
        attributes: { 'http.response.status_code': fault === 'existing' ? 412 : 200 },
      },
      { name: 'bayn.capture.object.readback.started', attributes: {} },
      { name: 'bayn.capture.object.readback.headers_received', attributes: {} },
      { name: 'bayn.capture.object.verified', attributes: {} },
    ])
    const times = server.spans[0]?.events.map(([, time]) => time) ?? []
    expect(times.every((time, index) => index === 0 || time >= (times[index - 1] ?? time))).toBe(true)
    expect(server.spans[0]?.status).toMatchObject({ _tag: 'Ended', exit: { _tag: 'Success' } })
  },
)

test('S3 operations inherit their parent trace and end independently', async () => {
  const server = fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeS3ResearchCaptureObjectStore(options, server.handler)
        const object = researchCaptureObject('fixture payload')
        yield* store.putVerified(object)
        yield* store.putVerified(object)
      }),
    ).pipe(Effect.withSpan('bayn.capture.fixture'), Effect.provideService(Tracer.Tracer, server.tracer)),
  )
  const parent = server.spans.find((span) => span.name === 'bayn.capture.fixture')
  if (parent === undefined) throw new Error('Capture parent span is missing')
  const children = server.spans.filter((span) => span.name === 'bayn.capture.object.put_verified')
  expect(children).toHaveLength(2)
  expect(new Set(children.map((span) => span.spanId)).size).toBe(2)
  for (const span of children) {
    expect(span.traceId).toBe(parent.traceId)
    expect(span.parent).toMatchObject({ _tag: 'Some', value: { spanId: parent.spanId } })
    expect(span.status).toMatchObject({ _tag: 'Ended', exit: { _tag: 'Success' } })
  }
  expect(server.requests.map((request) => request.method)).toEqual(['PUT', 'GET', 'PUT', 'GET'])
  expect(server.destroys()).toBe(1)
})

test('S3 verifies a zero-byte binary object without conflating it with a missing object', async () => {
  const server = fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeS3ResearchCaptureObjectStore(options, server.handler)
        yield* store.putVerified(researchCaptureObject(Buffer.alloc(0)))
      }),
    ),
  )
  expect(server.stored()).toEqual(Buffer.alloc(0))
  expect(server.requests.map((request) => request.method)).toEqual(['PUT', 'GET'])
  expect(server.destroys()).toBe(1)
})

test.each([
  'wrong-existing',
  'lost-ack',
  '503',
  '409',
  'truncated',
  'oversized',
  'wrong-bytes',
  'wrong-length',
  'stream-error',
] as const)('S3 %s fails closed without retry, overwrite, or an acknowledged object', async (fault) => {
  const server = fixture(fault)
  const object = researchCaptureObject(Buffer.from('fixture payload'))
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeS3ResearchCaptureObjectStore(options, server.handler)
        yield* store.putVerified(object)
      }),
    ).pipe(Effect.provideService(Tracer.Tracer, server.tracer)),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(1)
  expect(server.requests.map((request) => request.method)).toEqual(
    fault === 'lost-ack' || fault === '503' || fault === '409' ? ['PUT'] : ['PUT', 'GET'],
  )
  expect(server.destroys()).toBe(1)
  if (server.readback() !== undefined) expect(server.readback()?.destroyed).toBe(true)
  expect(JSON.stringify(exit)).not.toContain('synthetic-secret')
  expect(JSON.stringify(exit)).not.toContain('synthetic-access')
  expect(server.spans).toHaveLength(1)
  expect(server.spans[0]?.attributes.get('bayn.capture.object.phase')).toBe(
    fault === 'lost-ack' || fault === '503' || fault === '409'
      ? 'CONDITIONAL_PUT'
      : fault === 'wrong-length'
        ? 'READBACK'
        : 'VERIFY_BYTES',
  )
  expect(server.spans[0]?.status).toMatchObject({ _tag: 'Ended', exit: { _tag: 'Failure' } })
  expect(server.spans[0]?.events.map(([name]) => name)).not.toContain('bayn.capture.object.verified')
  const serializedSpans = JSON.stringify(
    server.spans.map((span) => ({ attributes: Object.fromEntries(span.attributes), events: span.events })),
    (_key, value) => (typeof value === 'bigint' ? String(value) : value),
  )
  expect(serializedSpans).not.toContain('synthetic-access')
  expect(serializedSpans).not.toContain('synthetic-secret')
  expect(serializedSpans).not.toContain('fixture payload')
  expect(serializedSpans).not.toContain('fixture.invalid')
  expect(serializedSpans).not.toContain('synthetic-captures')
})

test.each([
  { blockedMethod: 'PUT', termination: 'deadline' },
  { blockedMethod: 'GET', termination: 'deadline' },
  { blockedMethod: 'PUT', termination: 'interruption' },
  { blockedMethod: 'GET', termination: 'interruption' },
] as const)(
  'S3 $termination cancels blocked $blockedMethod I/O and releases the client once',
  async ({ blockedMethod, termination }) => {
    let aborted = 0
    let destroys = 0
    const { spans, tracer } = captureSpans()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>()
          const handler: S3ClientConfig['requestHandler'] = {
            handle: async (request: Request, requestOptions: RequestOptions) => {
              if (request.method !== blockedMethod)
                return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } }
              Deferred.doneUnsafe(entered, Effect.void)
              return await new Promise<never>((_resolve, reject) => {
                const abort = () => {
                  aborted++
                  reject(new Error('Aborted fixture request'))
                }
                if (requestOptions?.abortSignal?.aborted) abort()
                else requestOptions?.abortSignal?.addEventListener('abort', abort, { once: true })
              })
            },
            destroy: () => {
              destroys++
            },
          }
          const store = yield* makeS3ResearchCaptureObjectStore(options, handler)
          const operation = yield* store.putVerified(researchCaptureObject('fixture payload')).pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          if (termination === 'deadline') yield* TestClock.adjust(100)
          else yield* Fiber.interrupt(operation)
          expect(Exit.isFailure(yield* Fiber.await(operation))).toBe(true)
        }),
      ).pipe(provideTestLayer(TestClock.layer()), Effect.provideService(Tracer.Tracer, tracer)),
    )
    expect(aborted).toBe(1)
    expect(destroys).toBe(1)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.attributes.get('bayn.capture.object.phase')).toBe(
      blockedMethod === 'PUT' ? 'CONDITIONAL_PUT' : 'READBACK',
    )
    expect(spans[0]?.status._tag).toBe('Ended')
    expect(spans[0]?.events.map(([name]) => name)).toEqual(
      blockedMethod === 'PUT'
        ? ['bayn.capture.object.put.started']
        : [
            'bayn.capture.object.put.started',
            'bayn.capture.object.put.acknowledged',
            'bayn.capture.object.readback.started',
          ],
    )
  },
)

test('S3 rejects an unvalidated object identity before tracing it or sending requests', async () => {
  const server = fixture()
  const object = { ...researchCaptureObject('fixture payload'), contentHash: 'unvalidated-private-identity' }
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeS3ResearchCaptureObjectStore(options, server.handler)
        yield* store.putVerified(object)
      }),
    ).pipe(Effect.provideService(Tracer.Tracer, server.tracer)),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(server.requests).toHaveLength(0)
  expect(server.spans[0]?.attributes.has('bayn.capture.object.sha256')).toBe(false)
  expect(server.spans[0]?.events).toEqual([])
  expect(JSON.stringify(server.spans.map((span) => Object.fromEntries(span.attributes)))).not.toContain(
    object.contentHash,
  )
})

test('S3 timeout destroys a stalled response stream after successful headers', async () => {
  let responseBody: Readable | undefined
  const { spans, tracer } = captureSpans()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const handler: S3ClientConfig['requestHandler'] = {
          handle: async (request: Request) => {
            if (request.method === 'PUT') return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } }
            responseBody = new Readable({
              read() {
                Deferred.doneUnsafe(entered, Effect.void)
              },
            })
            return { response: { statusCode: 200, headers: { 'content-length': '15' }, body: responseBody } }
          },
        }
        const store = yield* makeS3ResearchCaptureObjectStore(options, handler)
        const operation = yield* store.putVerified(researchCaptureObject('fixture payload')).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* TestClock.adjust(100)
        expect(Exit.isFailure(yield* Fiber.await(operation))).toBe(true)
      }),
    ).pipe(provideTestLayer(TestClock.layer()), Effect.provideService(Tracer.Tracer, tracer)),
  )
  expect(responseBody?.destroyed).toBe(true)
  expect(spans).toHaveLength(1)
  expect(spans[0]?.attributes.get('bayn.capture.object.phase')).toBe('VERIFY_BYTES')
  expect(spans[0]?.status._tag).toBe('Ended')
  expect(spans[0]?.events.map(([name]) => name)).toEqual([
    'bayn.capture.object.put.started',
    'bayn.capture.object.put.acknowledged',
    'bayn.capture.object.readback.started',
    'bayn.capture.object.readback.headers_received',
  ])
})

test.each([
  { method: 'PUT', status: 200 },
  { method: 'PUT', status: 412 },
  { method: 'GET', status: 404 },
])(
  'SDK collector rejects oversized $method/$status bodies before unbounded deserialization',
  async ({ method, status }) => {
    let body: Readable | undefined
    let emitted = 0
    const handler: S3ClientConfig['requestHandler'] = {
      handle: async (request: Request) => {
        if (request.method !== method) return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } }
        body = Readable.from(
          (async function* () {
            for (let index = 0; index < 1024; index++) {
              emitted++
              yield Buffer.alloc(1024, 65)
            }
          })(),
          { highWaterMark: 1024, objectMode: false },
        )
        return { response: { statusCode: status, headers: { 'content-type': 'application/xml' }, body } }
      },
    }
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* makeS3ResearchCaptureObjectStore(options, handler)
          yield* store.putVerified(researchCaptureObject('fixture payload'))
        }),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(emitted).toBeLessThan(16)
    expect(body?.destroyed).toBe(true)
  },
)

test.each([
  { method: 'PUT', status: 200 },
  { method: 'PUT', status: 412 },
  { method: 'GET', status: 404 },
])('deadline destroys stalled SDK $method/$status bodies before deserialization', async ({ method, status }) => {
  let body: Readable | undefined
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const handler: S3ClientConfig['requestHandler'] = {
          handle: async (request: Request) => {
            if (request.method !== method)
              return { response: { statusCode: 200, headers: {}, body: Readable.from([]) } }
            body = new Readable({
              read() {
                Deferred.doneUnsafe(entered, Effect.void)
              },
            })
            return { response: { statusCode: status, headers: { 'content-type': 'application/xml' }, body } }
          },
        }
        const store = yield* makeS3ResearchCaptureObjectStore(options, handler)
        const operation = yield* store.putVerified(researchCaptureObject('fixture payload')).pipe(Effect.forkChild)
        yield* Deferred.await(entered)
        yield* TestClock.adjust(100)
        expect(Exit.isFailure(yield* Fiber.await(operation))).toBe(true)
      }),
    ).pipe(provideTestLayer(TestClock.layer())),
  )
  expect(body?.destroyed).toBe(true)
})

test.each(['xml-code', 'transport-name'] as const)('SDK %s never escapes into capture errors', async (fault) => {
  const privateText = 'synthetic-access synthetic-secret private-raw-value'
  const handler: S3ClientConfig['requestHandler'] = {
    handle: async () => {
      if (fault === 'transport-name') {
        const error = new Error(privateText)
        error.name = privateText
        throw error
      }
      return {
        response: {
          statusCode: 503,
          headers: { 'content-type': 'application/xml' },
          body: Readable.from([
            Buffer.from(`<Error><Code>${privateText}</Code><Message>${privateText}</Message></Error>`),
          ]),
        },
      }
    },
  }
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* makeS3ResearchCaptureObjectStore(options, handler)
        yield* store.putVerified(researchCaptureObject('fixture payload'))
      }),
    ),
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(JSON.stringify(exit)).not.toContain('synthetic-access')
  expect(JSON.stringify(exit)).not.toContain('synthetic-secret')
  expect(JSON.stringify(exit)).not.toContain('private-raw-value')
})
