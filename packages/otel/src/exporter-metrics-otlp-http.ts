import { ExportResultCode } from './core'
import {
  Aggregation,
  AggregationTemporality,
  InstrumentType,
  type PushMetricExporter,
  type ResourceMetrics,
} from './sdk-metrics'
import { diag } from './diag'

type ExporterConfig = {
  url: string
  headers?: Record<string, string>
  timeoutMillis?: number
}

type FetchTimeout = { signal?: AbortSignal; cancel: () => void }

const createTimeoutSignal = (timeoutMillis?: number): FetchTimeout => {
  if (!timeoutMillis) {
    return { cancel: () => {} }
  }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMillis)
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeoutId),
  }
}

export class OTLPMetricExporter implements PushMetricExporter {
  readonly #url: string
  readonly #headers?: Record<string, string>
  readonly #timeoutMillis?: number
  #shutdown = false

  constructor(config: ExporterConfig) {
    this.#url = config.url
    this.#headers = config.headers
    this.#timeoutMillis = config.timeoutMillis
  }

  export(metrics: ResourceMetrics, resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    if (this.#shutdown) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('exporter shutdown') })
      return
    }

    const body = JSON.stringify({ resourceMetrics: [metrics] })

    void this.#send(body)
      .then(() => {
        resultCallback({ code: ExportResultCode.SUCCESS })
      })
      .catch((error) => {
        resultCallback({ code: ExportResultCode.FAILED, error })
      })
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.#shutdown = true
  }

  selectAggregationTemporality(_instrumentType: InstrumentType): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE
  }

  selectAggregation(_instrumentType: InstrumentType): Aggregation {
    return new Aggregation('default')
  }

  async #send(body: string): Promise<void> {
    const fetchFn = globalThis.fetch
    if (typeof fetchFn !== 'function') {
      throw new Error('fetch is not available in this runtime')
    }
    const { signal, cancel } = createTimeoutSignal(this.#timeoutMillis)
    try {
      const response = await fetchFn(this.#url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.#headers ?? {}),
        },
        body,
        signal,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`OTLP metrics export failed: ${response.status} ${response.statusText} ${text}`.trim())
      }
    } catch (error) {
      diag.error('otlp metric export failed', error)
      throw error
    } finally {
      cancel()
    }
  }
}
