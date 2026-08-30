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

type SharedOtelApiState = {
  tracerProvider?: unknown
}

const OTEL_TRACE_API_STATE_KEY = Symbol.for('proompteng.otel.trace-api.state.v1')
let globalMeterProvider: GlobalMeterProvider = new NoopMeterProvider()
const localTracerProvider = new NoopTracerProvider()

const sharedState = (() => {
  const registry = globalThis as typeof globalThis & { [key: symbol]: unknown }
  const existing = registry[OTEL_TRACE_API_STATE_KEY]
  if (typeof existing === 'object' && existing !== null) {
    return existing as SharedOtelApiState
  }
  const created: SharedOtelApiState = {}
  registry[OTEL_TRACE_API_STATE_KEY] = created
  return created
})()

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
    sharedState.tracerProvider = provider
  },
  getTracer(name: string, version?: string) {
    const provider = (sharedState.tracerProvider as GlobalTracerProvider | undefined) ?? localTracerProvider
    return provider.getTracer(name, version)
  },
}

export { DiagConsoleLogger, DiagLogLevel, diag, SpanStatusCode }
export type { Counter, Histogram }
