import { expect, test } from 'bun:test'
import { createServer } from 'node:http'
import { Worker } from 'node:worker_threads'
import { Effect, Layer, Logger, Metric } from 'effect'
import { PrometheusMetrics } from 'effect/observability'
import { makeMetricsRuntimeLayer, makeTelemetryRuntimeLayer } from '../../telemetry'
import { makeThreadedKafkaProjection, type ProjectionWorkerOptions } from './worker'
import { nativeArrivalEpochFixture as epoch } from './native-arrival.test-support'

const options: ProjectionWorkerOptions = {
  kafka: {
    brokers: ['unused:9092'],
    username: 'unused',
    password: 'unused',
    groupPrefix: 'fixture',
    operationTimeoutMs: 1000,
    bootstrapTimeoutMs: 1000,
    timestampPolicy: epoch.bootstrap.timestampPolicy,
  },
  database: { postgres: { url: 'postgres://unused/unused', tls: false, caPath: '' }, operationTimeoutMs: 1000 },
  build: epoch.build,
  sources: epoch.sources,
}

test('real isolated worker health crosses the parent protocol and existing OTLP exporter without a second exporter', async () => {
  const bodies: Buffer[] = []
  const server = createServer((request, response) => {
    const chunks: Uint8Array[] = []
    request.on('data', (chunk: Uint8Array) => chunks.push(chunk))
    request.on('end', () => {
      bodies.push(Buffer.concat(chunks))
      response.writeHead(200).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture failed to bind')
  const telemetry = {
    serviceName: 'bayn-execution-controller',
    serviceVersion: 'fixture-revision',
    instanceId: 'fixture-pod',
    metricsEndpoint: `http://127.0.0.1:${address.port}/otlp/v1/metrics`,
  }

  try {
    const metrics = await Effect.runPromise(
      Effect.scoped(
        makeThreadedKafkaProjection(
          options,
          () =>
            new Worker(new URL('./worker-capture-health.test-support.ts', import.meta.url), {
              workerData: options,
              env: {
                PATH: process.env['PATH'],
                OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: telemetry.metricsEndpoint,
                BAYN_CODE_REVISION: telemetry.serviceVersion,
                HOSTNAME: 'isolated-fixture-worker',
              },
            }),
        ),
      ).pipe(
        Effect.andThen(PrometheusMetrics.format()),
        Effect.provide(Layer.mergeAll(makeTelemetryRuntimeLayer(telemetry), makeMetricsRuntimeLayer(telemetry))),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provide(Logger.layer([])),
      ),
    )
    expect(metrics).toMatch(/bayn_capture_terminal_failures_total\{[^\n]*\} 1/)
    expect(metrics).toMatch(/bayn_capture_workers_expected\{[^\n]*\} 0/)
    const body = Buffer.concat(bodies)
    for (const value of [
      'bayn_capture_terminal_failures_total',
      'bayn_capture_workers_expected',
      'bayn_capture_observation_timestamp_seconds',
      'source_revision',
      'fixture-revision',
      'fixture-pod',
    ])
      expect(body.includes(Buffer.from(value)), value).toBe(true)
    expect(bodies).toHaveLength(1)
    for (const forbidden of [epoch.captureId, 'rawValue', 'captureId', 'consumerEpoch', 'unused:9092'])
      expect(body.includes(Buffer.from(forbidden)), forbidden).toBe(false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}, 15_000)

test('unacknowledged health frames stay bounded and recover without blocking normal shutdown', async () => {
  const worker = new Worker(new URL('./worker-capture-health.test-support.ts', import.meta.url), {
    workerData: { ...options, fixtureClock: true },
    env: { PATH: process.env['PATH'] },
  })
  const frames: { _tag: string; health?: { activeCaptures: number; incompleteCaptures: number } }[] = []
  worker.on('message', (message) => frames.push(message))
  const waitFor = (tag: string) =>
    new Promise<void>((resolve, reject) => {
      const onMessage = (message: { _tag: string }) => {
        if (message._tag === tag) {
          worker.off('message', onMessage)
          worker.off('error', reject)
          resolve()
        }
      }
      worker.on('message', onMessage)
      worker.once('error', reject)
    })
  try {
    await waitFor('Ready')
    let advanced = waitFor('FixtureAdvanced')
    worker.postMessage({ operation: 'cancel', id: -1, fixtureAdvance: 60_000 })
    await advanced
    expect(frames.filter((frame) => frame._tag === 'CaptureHealth')).toHaveLength(1)
    advanced = waitFor('FixtureAdvanced')
    worker.postMessage({ operation: 'health-ack' })
    worker.postMessage({ operation: 'cancel', id: -1, fixtureAdvance: 15_000 })
    await advanced
    const health = frames.filter((frame) => frame._tag === 'CaptureHealth')
    expect(health).toHaveLength(2)
    expect(health[1]?.health).toMatchObject({ activeCaptures: 2, incompleteCaptures: 1 })
    const stopped = waitFor('Stopped')
    worker.postMessage({ operation: 'stop', id: 1 })
    await stopped
    expect(frames.filter((frame) => frame._tag === 'CaptureHealth')).toHaveLength(3)
  } finally {
    await worker.terminate()
  }
}, 10_000)
