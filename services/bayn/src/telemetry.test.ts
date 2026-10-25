import { describe, expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  ConfigProvider,
  Console,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Metric,
  References,
  Tracer,
} from 'effect'
import { PrometheusMetrics } from 'effect/observability'
import { TestClock } from 'effect/testing'

import {
  ExecutionStageTimings,
  type ExecutionStageTiming,
  decodeOtlpTraceEndpoint,
  decodeOtlpMetricsEndpoint,
  makeMetricsRuntimeLayer,
  makeTelemetryRuntimeLayer,
  telemetryRuntimeConfig,
  withObservedSpan,
  withObservedStage,
} from './telemetry'

describe('Bayn telemetry', () => {
  test.each(['success', 'failure', 'defect', 'interruption'])(
    'retains the native millisecond interval through %s and finalizes once',
    async (outcome) => {
      const spans: Tracer.Span[] = []
      let finalized = 0
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          spans.push(yield* Effect.currentSpan.pipe(Effect.orDie))
          yield* TestClock.adjust(25)
          if (outcome === 'failure') return yield* Effect.fail('fixture failure')
          if (outcome === 'defect') return yield* Effect.die('fixture defect')
          if (outcome === 'interruption') return yield* Effect.interrupt
        }).pipe(
          Effect.ensuring(Effect.sync(() => finalized++)),
          withObservedStage('bayn.postgres.commit'),
          Effect.provide(TestClock.layer()),
          Effect.provide(Logger.layer([])),
        ),
      )
      expect(Exit.isSuccess(exit)).toBe(outcome === 'success')
      expect(finalized).toBe(1)
      expect(spans).toHaveLength(1)
      expect(spans[0]?.attributes.get('bayn.native_wall.clock')).toBe('effect.Clock.currentTimeMillis')
      expect(spans[0]?.attributes.get('bayn.native_wall.started_at')).toBe('1970-01-01T00:00:00.000Z')
      expect(spans[0]?.attributes.get('bayn.native_wall.finished_at')).toBe('1970-01-01T00:00:00.025Z')
    },
  )

  test('published research telemetry uses its embedded source without a deployment revision variable', async () => {
    const directory = await mkdtemp(join(import.meta.dir, '.telemetry-build-'))
    const sourceRevision = 'a'.repeat(40)
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, 'telemetry.ts')],
        outdir: directory,
        target: 'bun',
        packages: 'external',
        define: { __BAYN_BUILD_SOURCE_REVISION__: JSON.stringify(sourceRevision) },
      })
      expect(built.success).toBe(true)
      const published: typeof import('./telemetry') = await import(pathToFileURL(join(directory, 'telemetry.js')).href)
      const config = await Effect.runPromise(
        published
          .telemetryRuntimeConfig('bayn-research')
          .pipe(
            Effect.provideService(
              ConfigProvider.ConfigProvider,
              ConfigProvider.fromUnknown({ NODE_ENV: 'production' }),
            ),
          ),
      )
      expect(config.serviceVersion).toBe(sourceRevision)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('retains a backend PID on slow and failed stage logs without copying other span data or logging fast calls', async () => {
    const annotations: Readonly<Record<string, unknown>>[] = []
    const logger = Logger.make(({ fiber }) => {
      annotations.push(fiber.getRef(References.CurrentLogAnnotations))
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan('postgresql.pid', 573682).pipe(
          Effect.andThen(Effect.annotateCurrentSpan('private.fixture', 'do-not-copy-span-data')),
          Effect.andThen(TestClock.adjust(1_200)),
          withObservedStage('bayn.postgres.commit', { dependency: 'postgresql' }),
        )
        yield* Effect.annotateCurrentSpan('postgresql.pid', 573683).pipe(
          Effect.andThen(Effect.fail('fixture rollback')),
          withObservedStage('bayn.postgres.rollback', { dependency: 'postgresql' }),
          Effect.exit,
        )
        yield* Effect.annotateCurrentSpan('postgresql.pid', 573684).pipe(
          withObservedStage('bayn.postgres.commit', { dependency: 'postgresql' }),
        )
        yield* Effect.annotateCurrentSpan('postgresql.pid', 'invalid-pid-canary').pipe(
          Effect.andThen(TestClock.adjust(1_200)),
          withObservedStage('bayn.postgres.commit', { dependency: 'postgresql' }),
        )
      }).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([logger]))),
    )
    expect(annotations).toHaveLength(3)
    expect(annotations[0]).toMatchObject({ 'postgresql.pid': 573682, elapsedMs: 1_200, outcome: 'succeeded' })
    expect(annotations[1]).toMatchObject({ 'postgresql.pid': 573683, outcome: 'failed' })
    expect(annotations[2]).not.toHaveProperty('postgresql.pid')
    expect(JSON.stringify(annotations)).not.toContain('do-not-copy-span-data')
    expect(JSON.stringify(annotations)).not.toContain('invalid-pid-canary')
  })

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
            OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: ' http://mimir/otlp/v1/metrics ',
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
      metricsEndpoint: 'http://mimir/otlp/v1/metrics',
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

  test('validates the Mimir OTLP metrics boundary', () => {
    expect(decodeOtlpMetricsEndpoint(undefined)).toEqual({ _tag: 'Disabled' })
    expect(decodeOtlpMetricsEndpoint('http://mimir/otlp/v1/metrics')._tag).toBe('Configured')
    expect(decodeOtlpMetricsEndpoint('http://user:secret@mimir/otlp/v1/metrics')._tag).toBe('Invalid')
    expect(decodeOtlpMetricsEndpoint('http://mimir/v1/traces')._tag).toBe('Invalid')
  })

  test('histograms preserve elapsed time and distinguish success, typed failure, defect and cancellation', async () => {
    const metrics = await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.adjust(20).pipe(withObservedStage('bayn.postgres.commit'))
        yield* TestClock.adjust(5).pipe(
          Effect.andThen(Effect.fail('private-error')),
          withObservedStage('bayn.postgres.commit'),
          Effect.exit,
        )
        yield* Effect.die('private-defect').pipe(withObservedStage('bayn.postgres.commit'), Effect.exit)
        const entered = yield* Deferred.make<void>()
        const operation = yield* Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          withObservedStage('bayn.postgres.commit'),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.await(entered)
        yield* TestClock.adjust(250)
        yield* Fiber.interrupt(operation)
        return yield* PrometheusMetrics.format()
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provide(Logger.layer([])),
      ),
    )
    expect(metrics).toMatch(/bayn_operation_duration_seconds_count\{[^\n]*outcome="succeeded"[^\n]*\} 1/)
    expect(metrics).toMatch(/bayn_operation_duration_seconds_sum\{[^\n]*outcome="succeeded"[^\n]*\} 0.02/)
    expect(metrics).toMatch(/bayn_operation_duration_seconds_count\{[^\n]*outcome="failed"[^\n]*\} 2/)
    expect(metrics).toMatch(/bayn_operation_duration_seconds_sum\{[^\n]*outcome="interrupted"[^\n]*\} 0.25/)
    expect(metrics).not.toContain('private-error')
    expect(metrics).not.toContain('private-defect')
  })

  test('exports native histograms and a heartbeat as OTLP protobuf at scope shutdown', async () => {
    const bodies: Buffer[] = []
    const server = createServer((request, response) => {
      const chunks: Uint8Array[] = []
      request.on('data', (chunk: Uint8Array) => chunks.push(chunk))
      request.on('end', () => {
        expect(request.url).toBe('/otlp/v1/metrics')
        bodies.push(Buffer.concat(chunks))
        response.writeHead(200).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('metrics test server did not bind TCP')
    const options = {
      serviceName: 'bayn-test',
      serviceVersion: 'source-test',
      instanceId: 'pod-test',
      metricsEndpoint: `http://127.0.0.1:${address.port}/otlp/v1/metrics`,
    }
    try {
      await Effect.runPromise(
        Effect.void.pipe(
          withObservedStage('bayn.postgres.commit'),
          Effect.provide(Layer.mergeAll(makeTelemetryRuntimeLayer(options), makeMetricsRuntimeLayer(options))),
          Effect.provideService(Metric.MetricRegistry, new Map()),
        ),
      )
      const body = Buffer.concat(bodies)
      for (const field of [
        'bayn_operation_duration_seconds',
        'bayn_telemetry_heartbeat_timestamp_seconds',
        'source-test',
        'source_revision',
        'pod-test',
        'succeeded',
      ])
        expect(body.includes(Buffer.from(field)), field).toBe(true)
      expect(bodies).toHaveLength(1)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      )
    }
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
    const errors: unknown[] = []
    const testConsole: Console.Console = {
      ...console,
      log: (...messages) => output.push(...messages),
      error: (...messages) => errors.push(...messages),
    }
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
      expect(errors).toHaveLength(0)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      )
    }
  })

  test('retries a transient collector failure with the same batch and logs transport recovery', async () => {
    const output: unknown[] = []
    const testConsole: Console.Console = { ...console, error: (...messages) => output.push(...messages) }
    const bodies: Buffer[] = []
    const server = createServer((request, response) => {
      const chunks: Uint8Array[] = []
      request.on('data', (chunk: Uint8Array) => chunks.push(chunk))
      request.on('end', () => {
        bodies.push(Buffer.concat(chunks))
        response.writeHead(bodies.length === 1 ? 503 : 200).end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('telemetry test server did not bind TCP')
    try {
      await Effect.runPromise(
        Effect.void.pipe(
          withObservedSpan('bayn.test.recovery'),
          Effect.provide(
            makeTelemetryRuntimeLayer({
              serviceName: 'bayn-telemetry-test',
              endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
            }),
          ),
          Effect.provideService(Console.Console, testConsole),
        ),
      )
      expect(bodies).toHaveLength(2)
      expect(bodies[0]).toEqual(bodies[1])
      expect(output.map((entry) => JSON.parse(String(entry)))).toContainEqual(
        expect.objectContaining({
          message: 'Bayn OTLP trace export request recovered',
          annotations: expect.objectContaining({ failedAttempts: 1, httpStatus: 200 }),
        }),
      )
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      )
    }
  })

  test('retains rejected trace exports as bounded warnings without collector response contents', async () => {
    const output: unknown[] = []
    const stdout: unknown[] = []
    const testConsole: Console.Console = {
      ...console,
      log: (...messages) => stdout.push(...messages),
      error: (...messages) => output.push(...messages),
    }
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
        Console.log('{"schemaVersion":"test-report.v1"}').pipe(
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
      expect(stdout).toEqual(['{"schemaVersion":"test-report.v1"}'])
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
    const stdout: unknown[] = []
    const testConsole: Console.Console = {
      ...console,
      log: (...messages) => stdout.push(...messages),
      error: (...messages) => output.push(...messages),
    }
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
      expect(stdout).toHaveLength(0)
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
