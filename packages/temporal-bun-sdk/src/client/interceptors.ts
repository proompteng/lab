import type { Interceptor, UnaryRequest, UnaryResponse } from '@connectrpc/connect'
import { Effect } from 'effect'
import type { Logger } from '../observability/logger'
import type { Counter, Histogram, MetricsExporter, MetricsRegistry } from '../observability/metrics'

export type TemporalInterceptor = Interceptor

export interface InterceptorBuilderInput {
  readonly namespace: string
  readonly identity: string
  readonly logger: Logger
  readonly metricsRegistry: MetricsRegistry
  readonly metricsExporter: MetricsExporter
}

export interface InterceptorBuilder {
  readonly build: (input: InterceptorBuilderInput) => Effect.Effect<TemporalInterceptor[], unknown, never>
}

export const makeDefaultInterceptorBuilder = (): InterceptorBuilder => ({
  build(input) {
    return Effect.gen(function* () {
      const metrics = yield* makeMetricHandles(input.metricsRegistry)
      const loggingInterceptor = createLoggingInterceptor(input.logger, input.namespace)
      const metricsInterceptor = createMetricsInterceptor(metrics)
      const authInterceptor = createAuthInterceptor(input)
      return [loggingInterceptor, metricsInterceptor, authInterceptor]
    })
  },
})

const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

const createAuthInterceptor =
  (input: InterceptorBuilderInput): TemporalInterceptor =>
  (next) =>
  async (req) => {
    if (!req.header.has('temporal-namespace')) {
      req.header.set('temporal-namespace', input.namespace)
    }
    if (!req.header.has('temporal-client-identity')) {
      req.header.set('temporal-client-identity', input.identity)
    }
    return next(req)
  }

const createLoggingInterceptor =
  (logger: Logger, namespace: string): TemporalInterceptor =>
  (next) =>
  async (req: UnaryRequest) => {
    const baseFields = {
      service: req.service.typeName,
      method: req.method.name,
      namespace,
      url: req.url,
    }
    await Effect.runPromise(
      logger.log('debug', 'temporal rpc request', baseFields).pipe(Effect.catchAll(() => Effect.void)),
    )
    const start = Date.now()
    try {
      const response = (await next(req)) as UnaryResponse
      await Effect.runPromise(
        logger
          .log('debug', 'temporal rpc response', { ...baseFields, durationMs: Date.now() - start })
          .pipe(Effect.catchAll(() => Effect.void)),
      )
      return response
    } catch (error) {
      await Effect.runPromise(
        logger
          .log('error', 'temporal rpc failure', { ...baseFields, error: describeError(error) })
          .pipe(Effect.catchAll(() => Effect.void)),
      )
      throw error
    }
  }

const makeMetricHandles = (registry: MetricsRegistry) =>
  Effect.gen(function* () {
    const rpcCounter = yield* registry.counter('temporal_rpc_client_total', 'Temporal workflow service RPC calls')
    const rpcFailures = yield* registry.counter('temporal_rpc_client_failures_total', 'Temporal RPC failures')
    const rpcLatency = yield* registry.histogram('temporal_rpc_client_latency_ms', 'Temporal RPC latency (ms)')
    return { rpcCounter, rpcFailures, rpcLatency }
  })

const createMetricsInterceptor =
  (handles: { rpcCounter: Counter; rpcFailures: Counter; rpcLatency: Histogram }): TemporalInterceptor =>
  (next) =>
  async (req) => {
    const start = Date.now()
    await Effect.runPromise(handles.rpcCounter.inc())
    try {
      const response = await next(req)
      await Effect.runPromise(handles.rpcLatency.observe(Date.now() - start))
      return response
    } catch (error) {
      await Effect.runPromise(handles.rpcFailures.inc())
      await Effect.runPromise(handles.rpcLatency.observe(Date.now() - start))
      throw error
    }
  }
