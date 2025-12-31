import { randomUUID } from 'node:crypto'

import { Effect } from 'effect'

import { SpanStatusCode, trace } from '@proompteng/otel/api'
import { defaultRetryPolicy, type TemporalRpcRetryPolicy, withTemporalRetry } from '../client/retries'
import type { DataConverter } from '../common/payloads'
import type { Logger } from '../observability/logger'
import type { Counter, Histogram, MetricsExporter, MetricsRegistry } from '../observability/metrics'
import { type InterceptorKind, runInterceptors, type TemporalInterceptor } from './types'

export interface ClientInterceptorContextMetadata {
  retryPolicy?: TemporalRpcRetryPolicy
  callHeaders?: Record<string, string>
  dataConverter?: DataConverter
}

export interface ClientInterceptorBuilderInput {
  namespace: string
  taskQueue?: string
  identity: string
  logger: Logger
  metricsRegistry: MetricsRegistry
  metricsExporter: MetricsExporter
  retryPolicy?: TemporalRpcRetryPolicy
  tracingEnabled?: boolean
}

export type ClientInterceptorBuilder = {
  readonly build: (input: ClientInterceptorBuilderInput) => Effect.Effect<TemporalInterceptor[], unknown, never>
}

const CLIENT_OPERATION_KINDS: readonly InterceptorKind[] = [
  'workflow.start',
  'workflow.signal',
  'workflow.query',
  'workflow.update',
  'workflow.cancel',
  'workflow.signalWithStart',
  'workflow.awaitUpdate',
]

const makeClientMetricHandles = (registry: MetricsRegistry) =>
  Effect.gen(function* () {
    const rpcCounter = yield* registry.counter(
      'temporal_client_interceptor_rpc_total',
      'Temporal client RPC calls observed by interceptors',
    )
    const rpcErrors = yield* registry.counter(
      'temporal_client_interceptor_rpc_errors_total',
      'Temporal client RPC failures observed by interceptors',
    )
    const rpcLatency = yield* registry.histogram(
      'temporal_client_interceptor_rpc_latency_ms',
      'Temporal client RPC latency seen by interceptors (ms)',
    )
    const opCounter = yield* registry.counter(
      'temporal_client_interceptor_operation_total',
      'Temporal client workflow operations observed by interceptors',
    )
    const opErrors = yield* registry.counter(
      'temporal_client_interceptor_operation_errors_total',
      'Temporal client workflow operation failures observed by interceptors',
    )
    const opLatency = yield* registry.histogram(
      'temporal_client_interceptor_operation_latency_ms',
      'Temporal client workflow operation latency seen by interceptors (ms)',
    )
    return { rpcCounter, rpcErrors, rpcLatency, opCounter, opErrors, opLatency }
  })

const metricsInterceptor = (handles: {
  rpcCounter: Counter
  rpcErrors: Counter
  rpcLatency: Histogram
  opCounter: Counter
  opErrors: Counter
  opLatency: Histogram
}): TemporalInterceptor => ({
  name: 'client-metrics',
  order: -20,
  outbound(context, next) {
    const isRpc = context.kind === 'rpc'
    const start = Date.now()
    const counter = isRpc ? handles.rpcCounter : handles.opCounter
    let errorCounted = false
    return Effect.gen(function* () {
      yield* counter.inc()
      try {
        const result = yield* next()
        const latency = Date.now() - start
        yield* isRpc ? handles.rpcLatency.observe(latency) : handles.opLatency.observe(latency)
        if (!errorCounted && context.attempt && context.attempt > 1) {
          const retries = context.attempt - 1
          yield* isRpc ? handles.rpcErrors.inc(retries) : handles.opErrors.inc(retries)
        }
        return result
      } catch (error) {
        yield* isRpc ? handles.rpcErrors.inc() : handles.opErrors.inc()
        errorCounted = true
        const latency = Date.now() - start
        yield* isRpc ? handles.rpcLatency.observe(latency) : handles.opLatency.observe(latency)
        throw error
      }
    })
  },
})

const loggingInterceptor = (logger: Logger): TemporalInterceptor => ({
  name: 'client-logging',
  order: -10,
  outbound(context, next) {
    const base = {
      kind: context.kind,
      namespace: context.namespace,
      taskQueue: context.taskQueue,
      workflowId: context.workflowId,
      runId: context.runId,
      attempt: context.attempt,
    }
    return Effect.gen(function* () {
      yield* logger.log('debug', 'client outbound', base)
      const start = Date.now()
      try {
        const result = yield* next()
        yield* logger.log('debug', 'client inbound', {
          ...base,
          durationMs: Date.now() - start,
        })
        return result
      } catch (error) {
        yield* logger.log('error', 'client operation failed', {
          ...base,
          durationMs: Date.now() - start,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    })
  },
})

const authHeaderInterceptor = (namespace: string, identity: string): TemporalInterceptor => ({
  name: 'client-auth-headers',
  // Apply to RPC and workflow operation routes so callers see consistent headers.
  kinds: ['rpc', ...CLIENT_OPERATION_KINDS],
  order: -30,
  outbound(context, next) {
    if (!context.headers) {
      context.headers = {}
    }
    const headers = context.headers
    if (!headers['temporal-namespace']) {
      headers['temporal-namespace'] = namespace
    }
    if (!headers['temporal-client-identity']) {
      headers['temporal-client-identity'] = identity
    }
    context.headers = headers
    return next()
  },
})

const tracingInterceptor = (logger: Logger): TemporalInterceptor => ({
  name: 'client-trace',
  order: -5,
  outbound(context, next) {
    const traceId = randomUUID()
    const tracer = trace.getTracer('temporal-bun-sdk')
    const span = tracer.startSpan(`temporal.client.${context.kind}`, {
      attributes: {
        'temporal.kind': context.kind,
        'temporal.namespace': context.namespace,
        'temporal.task_queue': context.taskQueue ?? '',
        'temporal.identity': context.identity ?? '',
        'temporal.workflow_id': context.workflowId ?? '',
        'temporal.run_id': context.runId ?? '',
        'temporal.attempt': context.attempt ?? 0,
      },
    })
    if (context.headers) {
      context.headers['x-temporal-trace-id'] = traceId
    }
    return Effect.gen(function* () {
      yield* logger.log('debug', 'trace start', { traceId, kind: context.kind })
      try {
        const result = yield* next()
        span.setStatus({ code: SpanStatusCode.OK })
        yield* logger.log('debug', 'trace finish', { traceId, kind: context.kind })
        span.end()
        return result
      } catch (error) {
        span.recordException(error as Error)
        span.setStatus({ code: SpanStatusCode.ERROR })
        yield* logger.log('error', 'trace error', {
          traceId,
          kind: context.kind,
          error: error instanceof Error ? error.message : String(error),
        })
        span.end()
        throw error
      } finally {
        if (span.isRecording()) {
          span.end()
        }
      }
    })
  },
})

const retryInterceptor = (fallbackPolicy: TemporalRpcRetryPolicy): TemporalInterceptor => ({
  name: 'client-retry',
  kinds: ['rpc'],
  order: -40,
  outbound(context, next) {
    const policy = (context.metadata?.retryPolicy as TemporalRpcRetryPolicy | undefined) ?? fallbackPolicy
    if (policy.maxAttempts <= 1) {
      context.attempt = 1
      return next()
    }
    let attempt = 0
    const runWithAttempt = () =>
      Effect.gen(function* () {
        attempt += 1
        context.attempt = attempt
        return yield* next()
      })
    return withTemporalRetry(runWithAttempt(), policy)
  },
})

export const makeDefaultClientInterceptors = (
  input: ClientInterceptorBuilderInput,
): Effect.Effect<TemporalInterceptor[], unknown, never> =>
  Effect.gen(function* () {
    const metrics = yield* makeClientMetricHandles(input.metricsRegistry)
    const interceptors: TemporalInterceptor[] = [
      retryInterceptor(input.retryPolicy ?? defaultRetryPolicy),
      authHeaderInterceptor(input.namespace, input.identity),
      metricsInterceptor(metrics),
      loggingInterceptor(input.logger),
    ]
    if (input.tracingEnabled) {
      interceptors.push(tracingInterceptor(input.logger))
    }
    return interceptors
  })

export const runClientInterceptors = <A>(
  interceptors: readonly TemporalInterceptor[],
  context: Omit<Parameters<typeof runInterceptors<A>>[1], 'direction'>,
  run: () => Effect.Effect<A, unknown, never>,
) => runInterceptors(interceptors as readonly TemporalInterceptor<A>[], context, run)

export const isWorkflowOperationKind = (kind: InterceptorKind): boolean => CLIENT_OPERATION_KINDS.includes(kind)
