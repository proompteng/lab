import * as Sentry from '@sentry/node'
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { glitchTipDsn, sanitizeErrorEvent } from './errors'

let initialized = false
let provider: NodeTracerProvider | undefined
const EXPORT_TIMEOUT_MS = 10_000

export function initializeObservability() {
  if (initialized) return
  const release = process.env.APP_SOURCE_REVISION || 'development'
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
  if (endpoint) {
    const batch = new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint, timeoutMillis: EXPORT_TIMEOUT_MS }))
    provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': 'tengri-bff',
        'service.namespace': 'tengri',
        'service.version': release,
        'deployment.environment.name': 'production',
      }),
      spanProcessors: [
        {
          onStart: (span, parent) => batch.onStart(span, parent),
          onEnd: (span) => {
            if (span.instrumentationScope.name === 'tengri-bff') batch.onEnd(span)
          },
          forceFlush: () => batch.forceFlush(),
          shutdown: () => batch.shutdown(),
        },
      ],
    })
    provider.register({
      contextManager: new AsyncLocalStorageContextManager(),
      propagator: new W3CTraceContextPropagator(),
    })
  }
  const dsn = glitchTipDsn(process.env.SENTRY_DSN)
  if (dsn)
    Sentry.init({
      dsn: dsn.toString(),
      release,
      environment: 'production',
      defaultIntegrations: false,
      enableOpenTelemetrySetup: false,
      tracesSampleRate: 0,
      maxBreadcrumbs: 0,
      integrations: [Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration()],
      beforeSend: sanitizeErrorEvent,
    })
  initialized = true
}

export function reportServerError(error: unknown, operation: string, status?: number) {
  const span = trace.getActiveSpan()
  span?.setStatus({ code: SpanStatusCode.ERROR })
  Sentry.withScope((scope) => {
    scope.setTag('service', 'tengri-bff')
    scope.setTag('operation', operation)
    if (status !== undefined) scope.setTag('status', status)
    const traceId = span?.spanContext().traceId
    if (traceId) scope.setTag('trace_id', traceId)
    Sentry.captureException(error)
  })
}

export async function observeRequest(request: Request, operation: string, run: () => Promise<Response>) {
  const parent = propagation.extract(ROOT_CONTEXT, request.headers, {
    keys: () => ['traceparent', 'tracestate'],
    get: (headers, key) => headers.get(key) ?? undefined,
  })
  return trace.getTracer('tengri-bff').startActiveSpan(operation, { kind: SpanKind.SERVER }, parent, async (span) => {
    const active = context.active()
    let ended = false
    const finish = (error?: unknown) => {
      if (ended) return
      ended = true
      if (error !== undefined) {
        span.setStatus({ code: SpanStatusCode.ERROR })
        context.with(active, () => reportServerError(error, operation))
      }
      span.end()
    }
    try {
      const response = await run()
      span.setAttribute('http.response.status_code', response.status)
      if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
      const headers = new Headers(response.headers)
      const id = span.spanContext().traceId
      if (!/^0+$/.test(id)) headers.set('x-trace-id', id)
      let body: ReadableStream<Uint8Array> | null = null
      if (response.body) {
        const reader = response.body.getReader()
        body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const next = await reader.read()
              if (ended) return
              if (next.done) {
                finish()
                controller.close()
              } else controller.enqueue(next.value)
            } catch (error) {
              if (ended) return
              finish(error)
              controller.error(error)
            }
          },
          async cancel(reason) {
            finish()
            await reader.cancel(reason)
          },
        })
      } else finish()
      return new Response(body, { status: response.status, statusText: response.statusText, headers })
    } catch (error) {
      finish(error)
      throw error
    }
  })
}

export function injectTrace(set: (key: string, value: string) => void) {
  propagation.inject(context.active(), undefined, { set: (_carrier, key, value) => set(key, value) })
}

export async function flushObservability() {
  await Promise.all([provider?.forceFlush(), Sentry.flush(EXPORT_TIMEOUT_MS)])
}
