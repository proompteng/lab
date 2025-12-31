import { DiagConsoleLogger, DiagLogLevel, diag } from './diag'
import { type Counter, type Histogram, NoopMeterProvider } from './sdk-metrics'
import { NoopTracerProvider, type Span, type SpanOptions, SpanStatusCode } from './sdk-trace'

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

let globalMeterProvider: GlobalMeterProvider = new NoopMeterProvider()
let globalTracerProvider: GlobalTracerProvider = new NoopTracerProvider()

export const metrics = {
  setGlobalMeterProvider(provider: GlobalMeterProvider) {
    globalMeterProvider = provider
  },
  getMeter(name: string, version?: string) {
    return globalMeterProvider.getMeter(name, version)
  },
}

export const trace = {
  setGlobalTracerProvider(provider: GlobalTracerProvider) {
    globalTracerProvider = provider
  },
  getTracer(name: string, version?: string) {
    return globalTracerProvider.getTracer(name, version)
  },
}

export { DiagConsoleLogger, DiagLogLevel, diag, SpanStatusCode }
export type { Counter, Histogram }
