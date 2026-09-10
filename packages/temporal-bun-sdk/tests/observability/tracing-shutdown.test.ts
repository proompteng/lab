import { expect, test } from 'bun:test'

import { ExportResultCode } from '../../src/otel/core'
import { createSimpleSpanProcessor, type SpanData, type SpanExporter, TracerProvider } from '../../src/otel/sdk-trace'

test('span processor drops spans that end after shutdown', async () => {
  let exportCalls = 0
  const exporter: SpanExporter = {
    export(_spans: SpanData[], resultCallback) {
      exportCalls += 1
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('exporter shutdown') })
    },
    async shutdown() {},
  }
  const provider = new TracerProvider()
  provider.addSpanProcessor(createSimpleSpanProcessor(exporter))
  const span = provider.getTracer('shutdown-test').startSpan('late-span')

  await provider.shutdown()
  span.end()

  expect(exportCalls).toBe(0)
})
