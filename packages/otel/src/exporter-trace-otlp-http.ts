import { diag } from './diag'
import { ExportResultCode } from './core'
import { attributesToKeyValueList, stableAttributesKey } from './otlp'
import { type SpanData, type SpanExporter } from './sdk-trace'

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

const serializeSpans = (spans: SpanData[]) => {
  const resourceMap = new Map<
    string,
    {
      resourceAttributes: SpanData['resourceAttributes']
      scopeMap: Map<string, { scope: SpanData['scope']; spans: SpanData[] }>
    }
  >()

  for (const span of spans) {
    const resourceKey = stableAttributesKey(span.resourceAttributes)
    const scopeKey = `${span.scope.name}:${span.scope.version ?? ''}`
    let resourceEntry = resourceMap.get(resourceKey)
    if (!resourceEntry) {
      resourceEntry = {
        resourceAttributes: span.resourceAttributes,
        scopeMap: new Map(),
      }
      resourceMap.set(resourceKey, resourceEntry)
    }
    let scopeEntry = resourceEntry.scopeMap.get(scopeKey)
    if (!scopeEntry) {
      scopeEntry = { scope: span.scope, spans: [] }
      resourceEntry.scopeMap.set(scopeKey, scopeEntry)
    }
    scopeEntry.spans.push(span)
  }

  const resourceSpans = []
  for (const resourceEntry of resourceMap.values()) {
    const scopeSpans = []
    for (const scopeEntry of resourceEntry.scopeMap.values()) {
      scopeSpans.push({
        scope: scopeEntry.scope,
        spans: scopeEntry.spans.map((span) => ({
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: span.kind,
          startTimeUnixNano: span.startTimeUnixNano,
          endTimeUnixNano: span.endTimeUnixNano,
          attributes: attributesToKeyValueList(span.attributes),
          ...(span.status ? { status: span.status } : {}),
          ...(span.events
            ? {
                events: span.events.map((event) => ({
                  name: event.name,
                  timeUnixNano: event.timeUnixNano,
                  attributes: attributesToKeyValueList(event.attributes),
                })),
              }
            : {}),
        })),
      })
    }
    resourceSpans.push({
      resource: {
        attributes: attributesToKeyValueList(resourceEntry.resourceAttributes),
      },
      scopeSpans,
    })
  }

  return {
    resourceSpans,
  }
}

export class OTLPTraceExporter implements SpanExporter {
  readonly #url: string
  readonly #headers?: Record<string, string>
  readonly #timeoutMillis?: number
  #shutdown = false

  constructor(config: ExporterConfig) {
    this.#url = config.url
    this.#headers = config.headers
    this.#timeoutMillis = config.timeoutMillis
  }

  export(spans: SpanData[], resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    if (this.#shutdown) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('exporter shutdown') })
      return
    }
    const body = JSON.stringify(serializeSpans(spans))
    void this.#send(body)
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
        throw new Error(`OTLP trace export failed: ${response.status} ${response.statusText} ${text}`.trim())
      }
    } catch (error) {
      diag.error('otlp trace export failed', error)
      throw error
    } finally {
      cancel()
    }
  }
}
