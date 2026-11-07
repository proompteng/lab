import { expect, test } from 'bun:test'
import { createServer } from 'node:http'

import { NodeHttpClient } from '@effect/platform-node'
import { Effect, Layer, Logger, Metric } from 'effect'
import { OtlpMetrics, OtlpSerialization, PrometheusMetrics } from 'effect/observability'
import { TestClock } from 'effect/testing'

import { withObservedStage } from './telemetry'

test.each(['finite', 'canonical'])('Prometheus emits one total overflow bucket for %s boundaries', async (kind) => {
  const boundaries = kind === 'canonical' ? Metric.boundariesFromIterable([0.01, 1]) : [0.01, 1]
  const histogram = Metric.histogram('histogram_overflow_fixture', { boundaries })
  const prometheus = await Effect.runPromise(
    Effect.gen(function* () {
      for (const value of [0.005, 1, 2]) yield* Metric.update(histogram, value)
      return yield* PrometheusMetrics.format()
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())),
  )
  expect(prometheus.split('\n').filter((line) => line.startsWith('histogram_overflow_fixture_bucket'))).toEqual([
    'histogram_overflow_fixture_bucket{le="0.01"} 1',
    'histogram_overflow_fixture_bucket{le="1"} 2',
    'histogram_overflow_fixture_bucket{le="+Inf"} 3',
  ])
  expect(prometheus).toContain('histogram_overflow_fixture_count 3\n')
  expect(prometheus).toContain('histogram_overflow_fixture_sum 3.005\n')
})

test('native Prometheus and OTLP histograms preserve finite boundaries and overflow observations', async () => {
  const exports: OtlpMetrics.MetricsData[] = []
  let requests = 0
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      requests++
      response.writeHead(200).end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('metrics test server did not bind TCP')
  const serialization = Layer.effect(
    OtlpSerialization.OtlpSerialization,
    Effect.map(OtlpSerialization.OtlpSerialization, (native) => ({
      ...native,
      metrics: (data: OtlpMetrics.MetricsData) => {
        exports.push(data)
        return native.metrics(data)
      },
    })),
  ).pipe(Layer.provide(OtlpSerialization.layerProtobuf))
  const metrics = OtlpMetrics.layer({
    url: `http://127.0.0.1:${address.port}/v1/metrics`,
    resource: { serviceName: 'bayn-histogram-test' },
    exportInterval: '1 hour',
    shutdownTimeout: '3 seconds',
  }).pipe(Layer.provide(Layer.mergeAll(NodeHttpClient.layerNodeHttp, serialization)))
  const elapsedMilliseconds = [1, 10, 250, 450, 45_000, 60_000, 75_000]
  const finiteBounds = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]

  try {
    const prometheus = await Effect.runPromise(
      Effect.gen(function* () {
        for (const elapsed of elapsedMilliseconds) {
          yield* TestClock.adjust(elapsed).pipe(withObservedStage('bayn.valkey.get', { slowAfterMs: null }))
        }
        return yield* PrometheusMetrics.format()
      }).pipe(
        Effect.provide(metrics),
        Effect.provide(TestClock.layer()),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provide(Logger.layer([])),
      ),
    )
    expect(requests).toBe(1)
    expect(exports).toHaveLength(1)
    const dataPoints = exports.flatMap((data) =>
      data.resourceMetrics.flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) =>
          scope.metrics.flatMap((metric) =>
            metric.name === 'bayn_operation_duration_seconds' ? (metric.histogram?.dataPoints ?? []) : [],
          ),
        ),
      ),
    )
    expect(dataPoints).toHaveLength(1)
    const point = dataPoints[0]
    expect(point?.explicitBounds).toEqual(finiteBounds)
    const bucketCounts = point?.bucketCounts ?? []
    expect(bucketCounts).toHaveLength(finiteBounds.length + 1)
    expect(bucketCounts.reduce((sum, count) => sum + count, 0)).toBe(elapsedMilliseconds.length)
    expect(bucketCounts.at(-1)).toBe(1)
    expect(point?.count).toBe(elapsedMilliseconds.length)
    const elapsedSeconds = elapsedMilliseconds.map((elapsed) => elapsed / 1_000)
    const sum = elapsedSeconds.reduce((sum, elapsed) => sum + elapsed, 0)
    expect(point?.sum).toBeCloseTo(sum, 9)
    expect(prometheus).toMatch(
      new RegExp(`bayn_operation_duration_seconds_count\\{[^\\n]*\\} ${elapsedSeconds.length}\\n`),
    )
    const sumMatch = prometheus.match(/bayn_operation_duration_seconds_sum\{[^\n]*\} ([^\n]+)/)
    expect(Number(sumMatch?.[1])).toBeCloseTo(sum, 9)
    const buckets = [
      ...prometheus.matchAll(/bayn_operation_duration_seconds_bucket\{[^\n]*le="([^"]+)"[^\n]*\} (\d+)/g),
    ]
    expect(buckets.map((match) => match[1])).toEqual([...finiteBounds.map(String), '+Inf'])
    let cumulativeCount = 0
    for (const [index, match] of buckets.entries()) {
      cumulativeCount += bucketCounts[index] ?? 0
      expect(Number(match[2])).toBe(cumulativeCount)
      const boundary = match[1] === '+Inf' ? Number.POSITIVE_INFINITY : Number(match[1])
      expect(cumulativeCount).toBe(elapsedSeconds.filter((elapsed) => elapsed <= boundary).length)
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
    )
  }
})
