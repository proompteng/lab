import {
  DiagConsoleLogger,
  DiagLogLevel,
  diag,
  metrics as sharedMetrics,
  trace as sharedTrace,
} from '@proompteng/otel/api'
import type { Counter, Histogram } from './sdk-metrics'
import { type Span, type SpanOptions, SpanStatusCode } from './sdk-trace'

type MeterLike = {
  createCounter: (name: string, options?: { description?: string; unit?: string }) => Counter
  createHistogram: (name: string, options?: { description?: string; unit?: string }) => Histogram
}

type TracerLike = {
  startSpan: (name: string, options?: SpanOptions) => Span
}

type GlobalMeterProvider = {
  getMeter: (name: string, version?: string) => MeterLike
}

type GlobalTracerProvider = {
  getTracer: (name: string, version?: string) => TracerLike
}

export const metrics = {
  setGlobalMeterProvider(provider: GlobalMeterProvider) {
    sharedMetrics.setGlobalMeterProvider(
      provider as unknown as Parameters<typeof sharedMetrics.setGlobalMeterProvider>[0],
    )
  },
  getMeter(name: string, version?: string) {
    return sharedMetrics.getMeter(name, version)
  },
}

export const trace = {
  setGlobalTracerProvider(provider: GlobalTracerProvider) {
    sharedTrace.setGlobalTracerProvider(
      provider as unknown as Parameters<typeof sharedTrace.setGlobalTracerProvider>[0],
    )
  },
  getTracer(name: string, version?: string) {
    return sharedTrace.getTracer(name, version)
  },
}

export { DiagConsoleLogger, DiagLogLevel, diag, SpanStatusCode }
export type { Counter, Histogram }
