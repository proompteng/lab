import { SpanStatusCode, trace } from '@opentelemetry/api'

import type { MetricAttributes } from './metrics'

export interface Span {
  end(): void
  recordException(error: unknown): void
  setAttribute(key: string, value: string | number | boolean): void
  setAttributes(attributes: MetricAttributes): void
}

export interface Tracer {
  startSpan(name: string, attributes?: MetricAttributes): Span
}

export const makeNoopTracer = (): Tracer => ({
  startSpan() {
    return {
      end() {},
      recordException() {},
      setAttribute() {},
      setAttributes() {},
    }
  },
})

export interface OpenTelemetryTracerOptions {
  serviceName?: string
}

export const makeOpenTelemetryTracer = (options: OpenTelemetryTracerOptions = {}): Tracer => {
  const otelTracer = trace.getTracer(options.serviceName ?? 'temporal-bun-sdk')

  return {
    startSpan(name, attributes) {
      const span = otelTracer.startSpan(name, { attributes })
      return {
        end() {
          span.end()
        },
        recordException(error: unknown) {
          span.recordException(error instanceof Error ? error : { name: 'Error', message: String(error) })
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          })
        },
        setAttribute(key, value) {
          span.setAttribute(key, value)
        },
        setAttributes(attrs) {
          for (const [key, value] of Object.entries(attrs)) {
            span.setAttribute(key, value)
          }
        },
      }
    },
  }
}
