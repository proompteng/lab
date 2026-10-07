import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'

import { ConfigProvider, Console, Deferred, Effect, Exit, Fiber, Logger, References } from 'effect'
import { TestClock } from 'effect/testing'

import {
  ExecutionStageTimings,
  type ExecutionStageTiming,
  decodeOtlpTraceEndpoint,
  makeTelemetryRuntimeLayer,
  telemetryRuntimeConfig,
  withObservedSpan,
  withObservedStage,
} from './telemetry'

describe('Bayn telemetry', () => {
  test('aggregates repeated operations without conflating different operations or inclusive time', async () => {
    const timings = new Map<string, ExecutionStageTiming>()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.adjust(10).pipe(
          withObservedStage('bayn.execution-store.operation', { dependency: 'postgresql', operation: 'ingest' }),
        )
        yield* TestClock.adjust(20).pipe(
          withObservedStage('bayn.execution-store.operation', { dependency: 'postgresql', operation: 'ingest' }),
        )
        yield* TestClock.adjust(40).pipe(
          withObservedStage('bayn.execution-store.operation', { dependency: 'postgresql', operation: 'valuation' }),
        )
      }).pipe(
        withObservedStage('bayn.reconciliation.persist'),
        Effect.provideService(ExecutionStageTimings, timings),
        Effect.provide(TestClock.layer()),
      ),
    )
    expect([...timings.values()]).toEqual([
      {
        stage: 'bayn.execution-store.operation',
        dependency: 'postgresql',
        operation: 'ingest',
        count: 2,
        inclusiveElapsedMs: 30,
        maxElapsedMs: 20,
        failures: 0,
        interruptions: 0,
      },
      {
        stage: 'bayn.execution-store.operation',
        dependency: 'postgresql',
        operation: 'valuation',
        count: 1,
        inclusiveElapsedMs: 40,
        maxElapsedMs: 40,
        failures: 0,
        interruptions: 0,
      },
      {
        stage: 'bayn.reconciliation.persist',
        count: 1,
        inclusiveElapsedMs: 70,
        maxElapsedMs: 70,
        failures: 0,
        interruptions: 0,
      },
    ])
  })

  test('records the interrupted stage and elapsed time while preserving cancellation and finalization', async () => {
    const annotations: Readonly<Record<string, unknown>>[] = []
    let finalized = false
    const logger = Logger.make(({ fiber }) => {
      annotations.push(fiber.getRef(References.CurrentLogAnnotations))
    })
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>()
        const operation = yield* Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true
            }),
          ),
          withObservedStage('bayn.execution.intent.read'),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.await(entered)
        yield* TestClock.adjust(250)
        yield* Fiber.interrupt(operation)
        return yield* Fiber.await(operation)
      }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger]))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(finalized).toBe(true)
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({
      stage: 'bayn.execution.intent.read',
      elapsedMs: 250,
      outcome: 'interrupted',
    })
    expect(annotations[0]?.['trace_id']).toMatch(/^[0-9a-f]{32}$/)
  })

  test('loads bounded resource attributes through Effect Config', async () => {
    const options = await Effect.runPromise(
      telemetryRuntimeConfig('bayn-test').pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            BAYN_CODE_REVISION: ' source-revision ',
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: ' http://tempo:4318/v1/traces ',
            NODE_ENV: ' production ',
            POD_NAMESPACE: ' bayn ',
            HOSTNAME: ' bayn-test-0 ',
          }),
        ),
      ),
    )

    expect(options).toEqual({
      serviceName: 'bayn-test',
      serviceVersion: 'source-revision',
      endpoint: 'http://tempo:4318/v1/traces',
      environment: 'production',
      namespace: 'bayn',
      instanceId: 'bayn-test-0',
    })
  })

  test('accepts only an uncredentialed HTTP(S) OTLP traces endpoint', () => {
    expect(decodeOtlpTraceEndpoint(undefined)).toEqual({ _tag: 'Disabled' })
    expect(decodeOtlpTraceEndpoint('http://tempo.observability.svc:4318/v1/traces')).toEqual({
      _tag: 'Configured',
      url: 'http://tempo.observability.svc:4318/v1/traces',
    })
    expect(decodeOtlpTraceEndpoint('http://user:secret@tempo:4318/v1/traces')._tag).toBe('Invalid')
    expect(decodeOtlpTraceEndpoint('http://tempo:4318')._tag).toBe('Invalid')
    expect(decodeOtlpTraceEndpoint('file:///tmp/traces')._tag).toBe('Invalid')
  })

  test('correlates Effect logs with the active trace and span', async () => {
    const annotations: Array<Record<string, unknown>> = []
    const logger = Logger.make((options) => {
      annotations.push(options.fiber.getRef(References.CurrentLogAnnotations))
    })

    await Effect.runPromise(
      Effect.logInfo('correlated').pipe(withObservedSpan('bayn.test'), Effect.provide(Logger.layer([logger]))),
    )

    expect(annotations).toHaveLength(1)
    expect(annotations[0]?.['trace_id']).toMatch(/^[0-9a-f]{32}$/)
    expect(annotations[0]?.['span_id']).toMatch(/^[0-9a-f]{16}$/)
  })

  test('exports Effect spans as OTLP protobuf', async () => {
    const output: unknown[] = []
    const testConsole: Console.Console = { ...console, log: (...messages) => output.push(...messages) }
    let resolveRequest: ((request: { readonly path: string; readonly body: Uint8Array }) => void) | undefined
    const received = new Promise<{ readonly path: string; readonly body: Uint8Array }>((resolve) => {
      resolveRequest = resolve
    })
    const server = createServer((request, response) => {
      const chunks: Array<Uint8Array> = []
      request.on('data', (chunk: Uint8Array) => chunks.push(chunk))
      request.on('end', () => {
        resolveRequest?.({ path: request.url ?? '', body: Buffer.concat(chunks) })
        response.writeHead(200).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('telemetry test server did not bind TCP')

    const tracer = makeTelemetryRuntimeLayer({
      endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
      serviceName: 'bayn-telemetry-test',
      serviceVersion: 'test-version',
    })

    try {
      await Effect.runPromise(
        Effect.void.pipe(
          withObservedSpan('bayn.test.export'),
          Effect.provide(tracer),
          Effect.provideService(Console.Console, testConsole),
        ),
      )
      const request = await received
      expect(request.path).toBe('/v1/traces')
      expect(request.body.byteLength).toBeGreaterThan(0)
      expect(Buffer.from(request.body).includes(Buffer.from('bayn-telemetry-test'))).toBe(true)
      expect(Buffer.from(request.body).includes(Buffer.from('bayn.test.export'))).toBe(true)
      expect(output).toHaveLength(0)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      )
    }
  })

  test('retains rejected trace exports as bounded warnings without collector response contents', async () => {
    const output: unknown[] = []
    const testConsole: Console.Console = { ...console, log: (...messages) => output.push(...messages) }
    let requests = 0
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        requests += 1
        response.writeHead(400).end('private-collector-response')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('telemetry test server did not bind TCP')

    try {
      await Effect.runPromise(
        Effect.void.pipe(
          withObservedSpan('bayn.test.rejected-export'),
          Effect.provide(
            makeTelemetryRuntimeLayer({
              serviceName: 'bayn-telemetry-test',
              serviceVersion: 'test-version',
              endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
            }),
          ),
          Effect.provideService(Console.Console, testConsole),
        ),
      )
      expect(requests).toBe(1)
      expect(output).toHaveLength(1)
      expect(JSON.parse(String(output[0]))).toMatchObject({
        level: 'WARN',
        message: 'Bayn OTLP trace export attempt failed',
        annotations: {
          stage: 'bayn.telemetry.export',
          dependency: 'telemetry',
          serviceName: 'bayn-telemetry-test',
          sourceRevision: 'test-version',
          failureReason: 'http-status',
          httpStatus: 400,
        },
      })
      expect(output.join()).not.toContain('private-collector-response')
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      )
    }
  })

  test('retains trace transport failures without changing the application result or leaking raw errors', async () => {
    const output: unknown[] = []
    const testConsole: Console.Console = { ...console, log: (...messages) => output.push(...messages) }
    const server = createServer((request) => {
      request.resume()
      request.on('end', () => request.socket.destroy(new Error('private-collector-transport')))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('telemetry test server did not bind TCP')

    try {
      const result = await Effect.runPromise(
        Effect.succeed('application-result').pipe(
          withObservedSpan('bayn.test.transport-failure'),
          Effect.provide(
            makeTelemetryRuntimeLayer({
              serviceName: 'bayn-telemetry-test',
              endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
            }),
          ),
          Effect.provideService(Console.Console, testConsole),
        ),
      )
      expect(result).toBe('application-result')
      expect(output.length).toBeGreaterThan(0)
      for (const message of output) {
        expect(JSON.parse(String(message))).toMatchObject({
          level: 'WARN',
          message: 'Bayn OTLP trace export attempt failed',
          annotations: { stage: 'bayn.telemetry.export', failureReason: 'TransportError' },
        })
      }
      expect(output.join()).not.toContain('private-collector-transport')
      expect(output.join()).not.toContain('127.0.0.1')
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      )
    }
  })
})
