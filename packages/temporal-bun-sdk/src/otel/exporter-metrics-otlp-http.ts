import { ExportResultCode } from './core'
import { encodeMetricsRequest } from './otlp-proto'
import { type OtlpProtocol, sendOtlpGrpc, sendOtlpHttp } from './otlp-transport'
import {
  Aggregation,
  AggregationTemporality,
  type InstrumentType,
  type PushMetricExporter,
  type ResourceMetrics,
} from './sdk-metrics'

type ExporterConfig = {
  url: string
  headers?: Record<string, string>
  timeoutMillis?: number
  protocol?: OtlpProtocol
}

export class OTLPMetricExporter implements PushMetricExporter {
  readonly #url: string
  readonly #headers?: Record<string, string>
  readonly #timeoutMillis?: number
  readonly #protocol: OtlpProtocol
  #shutdown = false

  constructor(config: ExporterConfig) {
    this.#url = config.url
    this.#headers = config.headers
    this.#timeoutMillis = config.timeoutMillis
    this.#protocol = config.protocol ?? 'http/json'
  }

  export(metrics: ResourceMetrics, resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    if (this.#shutdown) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('exporter shutdown') })
      return
    }
    const protocol = this.#protocol
    const body =
      protocol === 'http/json' ? JSON.stringify({ resourceMetrics: [metrics] }) : encodeMetricsRequest(metrics)

    void this.#send(body, protocol)
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

  async #send(body: string | Uint8Array, protocol: OtlpProtocol): Promise<void> {
    if (protocol === 'grpc') {
      if (!(body instanceof Uint8Array)) {
        throw new Error('OTLP gRPC export requires protobuf payload')
      }
      await sendOtlpGrpc(
        {
          url: this.#url,
          headers: this.#headers,
          ...(this.#timeoutMillis ? { timeoutMillis: this.#timeoutMillis } : {}),
        },
        body,
        '/opentelemetry.proto.collector.metrics.v1.MetricsService/Export',
        'metrics',
      )
      return
    }

    await sendOtlpHttp(
      {
        url: this.#url,
        headers: this.#headers,
        ...(this.#timeoutMillis ? { timeoutMillis: this.#timeoutMillis } : {}),
      },
      body,
      protocol === 'http/protobuf' ? 'application/x-protobuf' : 'application/json',
      'metrics',
    )
  }
}
