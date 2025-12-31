import { diag } from './diag'
import { metrics, trace } from './api'
import { MeterProvider, type MetricReader } from './sdk-metrics'
import { type SpanExporter, TracerProvider, createSimpleSpanProcessor } from './sdk-trace'
import { Resource } from './resources'

export interface NodeSDKConfiguration {
  resource?: Resource
  traceExporter?: SpanExporter
  metricReader?: MetricReader
  instrumentations?: unknown[]
}

const flattenInstrumentations = (instrumentations: unknown[] = []): unknown[] =>
  instrumentations.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))

export class NodeSDK {
  readonly #config: NodeSDKConfiguration
  #meterProvider: MeterProvider | undefined
  #tracerProvider: TracerProvider | undefined
  #instrumentations: unknown[] = []

  constructor(config: NodeSDKConfiguration = {}) {
    this.#config = config
  }

  async start(): Promise<void> {
    const resource = this.#config.resource ?? Resource.default()

    this.#meterProvider = new MeterProvider({ resource })
    if (this.#config.metricReader) {
      this.#meterProvider.addMetricReader(this.#config.metricReader)
    }
    metrics.setGlobalMeterProvider(this.#meterProvider)

    this.#tracerProvider = new TracerProvider({ resource })
    if (this.#config.traceExporter) {
      this.#tracerProvider.addSpanProcessor(createSimpleSpanProcessor(this.#config.traceExporter))
    }
    trace.setGlobalTracerProvider(this.#tracerProvider)

    this.#instrumentations = flattenInstrumentations(this.#config.instrumentations ?? [])
    for (const instrumentation of this.#instrumentations) {
      if (instrumentation && typeof (instrumentation as { enable?: () => void }).enable === 'function') {
        try {
          ;(instrumentation as { enable: () => void }).enable()
        } catch (error) {
          diag.error('failed to enable instrumentation', error)
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const instrumentation of this.#instrumentations) {
      if (instrumentation && typeof (instrumentation as { disable?: () => void }).disable === 'function') {
        try {
          ;(instrumentation as { disable: () => void }).disable()
        } catch (error) {
          diag.error('failed to disable instrumentation', error)
        }
      }
    }

    await Promise.all([this.#meterProvider?.shutdown(), this.#tracerProvider?.shutdown()])
  }
}
