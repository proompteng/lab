import { ExportResultCode } from './core'
import { encodeTraceRequest } from './otlp-proto'
import { serializeSpans } from './otlp-serialize'
import { type OtlpProtocol, sendOtlpGrpc, sendOtlpHttp } from './otlp-transport'
import type { SpanData, SpanExporter } from './sdk-trace'

type ExporterConfig = {
  url: string
  headers?: Record<string, string>
  timeoutMillis?: number
  protocol?: OtlpProtocol
}

export class OTLPTraceExporter implements SpanExporter {
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

  export(spans: SpanData[], resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    if (this.#shutdown) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('exporter shutdown') })
      return
    }
    const protocol = this.#protocol
    const body = protocol === 'http/json' ? JSON.stringify(serializeSpans(spans)) : encodeTraceRequest(spans)
    void this.#send(body, protocol)
      .then(() => {
        resultCallback({ code: ExportResultCode.SUCCESS })
      })
      .catch((error) => {
        resultCallback({ code: ExportResultCode.FAILED, error })
      })
  }

  async shutdown(): Promise<void> {
    this.#shutdown = true
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
        '/opentelemetry.proto.collector.trace.v1.TraceService/Export',
        'trace',
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
      'trace',
    )
  }
}
