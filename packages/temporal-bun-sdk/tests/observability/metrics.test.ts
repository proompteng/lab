import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMetricsExporter, createMetricsRegistry } from '../../src/observability/metrics'

test('file metrics exporter emits JSON lines', async () => {
  const path = join(tmpdir(), `metrics-${Date.now()}.json`)
  const exporter = await Effect.runPromise(createMetricsExporter({ type: 'file', endpoint: path }))
  const registry = createMetricsRegistry(exporter)
  const counter = await Effect.runPromise(registry.counter('test_counter', 'test counter'))
  await Effect.runPromise(counter.inc(3))
  const histogram = await Effect.runPromise(registry.histogram('test_hist', 'test hist'))
  await Effect.runPromise(histogram.observe(42))
  await Effect.runPromise(exporter.flush())

  const content = await readFile(path, 'utf8')
  const lines = content.split('\n').filter(Boolean)
  expect(lines.length).toBe(2)

  const parsed = lines.map((line) => JSON.parse(line))
  expect(parsed[0]).toMatchObject({ type: 'counter', name: 'test_counter', value: 3 })
  expect(parsed[1]).toMatchObject({ type: 'histogram', name: 'test_hist', value: 42 })
})
