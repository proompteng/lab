import { expect, test } from 'bun:test'

import { ExportResultCode } from '../src/core'
import { MeterProvider, PeriodicExportingMetricReader } from '../src/sdk-metrics'
import { Resource } from '../src/resources'
import type { PushMetricExporter, ResourceMetrics } from '../src/sdk-metrics'

class TestMetricExporter implements PushMetricExporter {
  readonly exported: ResourceMetrics[] = []

  export(metrics: ResourceMetrics, resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    this.exported.push(metrics)
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}

  selectAggregationTemporality(): any {
    return 'AGGREGATION_TEMPORALITY_CUMULATIVE'
  }

  selectAggregation(): any {
    return { kind: 'default' }
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
