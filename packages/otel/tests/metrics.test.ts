import { expect, test } from 'bun:test'
import http2 from 'node:http2'

import { ExportResultCode } from '../src/core'
import { OTLPMetricExporter } from '../src/exporter-metrics-otlp-http'
import { Resource } from '../src/resources'
import type { PushMetricExporter, ResourceMetrics } from '../src/sdk-metrics'
import { Aggregation, AggregationTemporality, MeterProvider, PeriodicExportingMetricReader } from '../src/sdk-metrics'

class TestMetricExporter implements PushMetricExporter {
  readonly exported: ResourceMetrics[] = []

  export(metrics: ResourceMetrics, resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    this.exported.push(metrics)
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE
  }

  selectAggregation(): Aggregation {
    return new Aggregation('default')
  }
}

test('metric reader exports counters and histograms with resource attributes', async () => {
  const exporter = new TestMetricExporter()
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 })
  const provider = new MeterProvider({
    resource: new Resource({ 'service.name': 'otel-test' }),
  })

  provider.addMetricReader(reader)
  const meter = provider.getMeter('unit-test')
  const counter = meter.createCounter('unit_counter', { description: 'unit counter' })
  counter.add(2, { env: 'test' })
  const histogram = meter.createHistogram('unit_histogram', { description: 'unit histogram', unit: 'ms' })
  histogram.record(5, { env: 'test' })

  await reader.forceFlush()
  await provider.shutdown()

  expect(exporter.exported.length).toBe(1)
  const payload = exporter.exported[0]
  expect(payload?.resource?.attributes?.[0]?.key).toBe('service.name')
  const scopeMetrics = payload.scopeMetrics[0]
  expect(scopeMetrics.metrics.map((metric) => metric.name)).toContain('unit_counter')
  expect(scopeMetrics.metrics.map((metric) => metric.name)).toContain('unit_histogram')
})

test('metric reader skips instruments without data points', async () => {
  const exporter = new TestMetricExporter()
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 60000 })
  const provider = new MeterProvider({
    resource: new Resource({ 'service.name': 'otel-empty' }),
  })

  provider.addMetricReader(reader)
  const meter = provider.getMeter('unit-empty')
  meter.createCounter('empty_counter')
  meter.createHistogram('empty_histogram')

  await reader.forceFlush()
  await provider.shutdown()

  expect(exporter.exported.length).toBe(0)
})

test('metric exporter emits protobuf payload when configured', async () => {
  let capturedContentType: string | undefined
  let capturedLength = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url, init) => {
    const headers = init?.headers as Record<string, string> | undefined
    capturedContentType = headers?.['content-type'] ?? headers?.['Content-Type']
    const body = init?.body
    if (body instanceof Uint8Array) {
      capturedLength = body.length
    } else if (body instanceof ArrayBuffer) {
      capturedLength = body.byteLength
    }
    return new Response('', { status: 200 })
  }) as typeof fetch

  try {
    const exporter = new OTLPMetricExporter({
      url: 'http://collector.test/v1/metrics',
      protocol: 'http/protobuf',
    })
    const metrics: ResourceMetrics = {
      resource: { attributes: [] },
      scopeMetrics: [
        {
          scope: { name: 'unit-test' },
          metrics: [
            {
              name: 'unit_metric',
              sum: {
                aggregationTemporality: AggregationTemporality.CUMULATIVE,
                isMonotonic: true,
                dataPoints: [
                  {
                    attributes: [],
                    startTimeUnixNano: '1',
                    timeUnixNano: '2',
                    asDouble: 1,
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    await new Promise<void>((resolve, reject) => {
      exporter.export(metrics, (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          resolve()
          return
        }
        reject(result.error)
      })
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  expect(capturedContentType).toBe('application/x-protobuf')
  expect(capturedLength).toBeGreaterThan(0)
})

test('metric exporter sends gRPC payload', async () => {
  const server = http2.createServer()
  let receivedPath = ''
  let receivedLength = 0

  server.on('stream', (stream, headers) => {
    receivedPath = String(headers[':path'] ?? '')
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => {
      chunks.push(Buffer.from(chunk))
    })
    stream.on('end', () => {
      const payload = Buffer.concat(chunks)
      if (payload.length >= 5) {
        receivedLength = payload.readUInt32BE(1)
      }
      stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'grpc-status': '0' })
      stream.end(Buffer.from([0, 0, 0, 0, 0]))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  try {
    const exporter = new OTLPMetricExporter({
      url: `http://127.0.0.1:${port}`,
      protocol: 'grpc',
      timeoutMillis: 2000,
    })
    const metrics: ResourceMetrics = {
      resource: { attributes: [] },
      scopeMetrics: [
        {
          scope: { name: 'unit-test' },
          metrics: [
            {
              name: 'grpc_metric',
              sum: {
                aggregationTemporality: AggregationTemporality.CUMULATIVE,
                isMonotonic: true,
                dataPoints: [
                  {
                    attributes: [],
                    startTimeUnixNano: '1',
                    timeUnixNano: '2',
                    asDouble: 1,
                  },
                ],
              },
            },
          ],
        },
      ],
    }

    await new Promise<void>((resolve, reject) => {
      exporter.export(metrics, (result) => {
        if (result.code === ExportResultCode.SUCCESS) {
          resolve()
          return
        }
        reject(result.error)
      })
    })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  expect(receivedPath).toBe('/opentelemetry.proto.collector.metrics.v1.MetricsService/Export')
  expect(receivedLength).toBeGreaterThan(0)
})
