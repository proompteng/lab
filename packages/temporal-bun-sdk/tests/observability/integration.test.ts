import { expect, test } from 'bun:test'
import { Effect } from 'effect'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createObservabilityServices } from '../../src/observability'
import { LogEntry, makeLogger } from '../../src/observability/logger'

const metricsFile = () => join(tmpdir(), `observe-${Date.now()}.json`)

test('observability services log + metrics', async () => {
  const sink: LogEntry[] = []
  const customLogger = makeLogger({
    level: 'debug',
    format: 'json',
    sink: {
      write(entry) {
        sink.push(entry)
      },
    },
  })
  const target = metricsFile()
  const services = await Effect.runPromise(
    createObservabilityServices({
      logLevel: 'debug',
      logFormat: 'json',
      metrics: { type: 'file', endpoint: target },
    }, { logger: customLogger }),
  )
  const { logger, metricsRegistry, metricsExporter } = services
  const counter = await Effect.runPromise(
    metricsRegistry.counter('observability_integration_total', 'test integration runs'),
  )
  await Effect.runPromise(counter.inc())
  await Effect.runPromise(logger.log('info', 'integration test log', { stage: 'metrics' }))
  await Effect.runPromise(metricsExporter.flush())

  const content = await readFile(target, 'utf8')
  expect(content).toContain('observability_integration_total')
  expect(sink.map((entry) => entry.message)).toContain('integration test log')
})
