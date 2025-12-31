import { randomUUID } from 'node:crypto'

import { SpanStatusCode, trace } from '@proompteng/otel/api'
import { Effect } from 'effect'
import type { DataConverter } from '../common/payloads'
import type { Logger } from '../observability/logger'
import type { Counter, Histogram, MetricsExporter, MetricsRegistry } from '../observability/metrics'
import { runInterceptors, type TemporalInterceptor } from './types'

export interface WorkerInterceptorBuilderInput {
  namespace: string
  taskQueue: string
  identity: string
  buildId?: string
  logger: Logger
  metricsRegistry: MetricsRegistry
  metricsExporter: MetricsExporter
  dataConverter: DataConverter
  tracingEnabled?: boolean
}

export type WorkerInterceptorBuilder = {
  readonly build: (input: WorkerInterceptorBuilderInput) => Effect.Effect<TemporalInterceptor[], unknown, never>
}

const makeWorkerMetricHandles = (registry: MetricsRegistry) =>
  Effect.gen(function* () {
    const workflowCounter = yield* registry.counter(
      'temporal_worker_interceptor_workflow_total',
      'Workflow tasks processed with interceptors',
    )
    const workflowErrors = yield* registry.counter(
      'temporal_worker_interceptor_workflow_errors_total',
      'Workflow task failures observed by interceptors',
    )
    const workflowLatency = yield* registry.histogram(
      'temporal_worker_interceptor_workflow_latency_ms',
      'Workflow task latency seen by interceptors (ms)',
    )
    const activityCounter = yield* registry.counter(
      'temporal_worker_interceptor_activity_total',
      'Activity tasks processed with interceptors',
    )
    const activityErrors = yield* registry.counter(
      'temporal_worker_interceptor_activity_errors_total',
      'Activity task failures observed by interceptors',
    )
    const activityLatency = yield* registry.histogram(
      'temporal_worker_interceptor_activity_latency_ms',
      'Activity task latency seen by interceptors (ms)',
    )
    const queryCounter = yield* registry.counter(
      'temporal_worker_interceptor_query_total',
      'Workflow query tasks processed with interceptors',
    )
    const queryErrors = yield* registry.counter(
      'temporal_worker_interceptor_query_errors_total',
      'Workflow query failures observed by interceptors',
    )
    const queryLatency = yield* registry.histogram(
      'temporal_worker_interceptor_query_latency_ms',
      'Workflow query latency seen by interceptors (ms)',
    )
    const updateCounter = yield* registry.counter(
      'temporal_worker_interceptor_update_total',
      'Workflow update tasks processed with interceptors',
    )
    const updateErrors = yield* registry.counter(
      'temporal_worker_interceptor_update_errors_total',
      'Workflow update failures observed by interceptors',
    )
    const updateLatency = yield* registry.histogram(
      'temporal_worker_interceptor_update_latency_ms',
      'Workflow update latency seen by interceptors (ms)',
    )
    return {
      workflowCounter,
      workflowErrors,
      workflowLatency,
      activityCounter,
      activityErrors,
      activityLatency,
      queryCounter,
      queryErrors,
      queryLatency,
      updateCounter,
      updateErrors,
      updateLatency,
    }
  })

const metricsInterceptor = (
  handles: ReturnType<typeof makeWorkerMetricHandles> extends Effect.Effect<infer A> ? A : never,
): TemporalInterceptor => ({
  name: 'worker-metrics',
  order: -20,
  outbound(context, next) {
    const start = Date.now()
    let counter: Counter | undefined
    let errors: Counter | undefined
    let latency: Histogram | undefined
    switch (context.kind) {
      case 'worker.workflowTask':
        counter = handles.workflowCounter
        errors = handles.workflowErrors
        latency = handles.workflowLatency
        break
      case 'worker.activityTask':
        counter = handles.activityCounter
        errors = handles.activityErrors
        latency = handles.activityLatency
        break
      case 'worker.queryTask':
        counter = handles.queryCounter
        errors = handles.queryErrors
        latency = handles.queryLatency
        break
      case 'worker.updateTask':
        counter = handles.updateCounter
        errors = handles.updateErrors
        latency = handles.updateLatency
        break
      default:
        break
    }

    return Effect.gen(function* () {
      if (counter) {
        yield* counter.inc()
      }
      try {
        const result = yield* next()
        if (latency) {
          yield* latency.observe(Date.now() - start)
        }
        return result
      } catch (error) {
        if (errors) {
          yield* errors.inc()
        }
        if (latency) {
          yield* latency.observe(Date.now() - start)
        }
        throw error
      }
    })
  },
})

const loggingInterceptor = (logger: Logger): TemporalInterceptor => ({
  name: 'worker-logging',
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
      yield* logger.log('debug', 'worker task start', base)
      const start = Date.now()
      try {
        const result = yield* next()
        yield* logger.log('debug', 'worker task finish', { ...base, durationMs: Date.now() - start })
        return result
      } catch (error) {
        yield* logger.log('error', 'worker task failure', {
          ...base,
          durationMs: Date.now() - start,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    })
  },
})

const tracingInterceptor = (logger: Logger): TemporalInterceptor => ({
  name: 'worker-trace',
  order: -5,
  outbound(context, next) {
    const traceId = randomUUID()
    const tracer = trace.getTracer('temporal-bun-sdk')
    const span = tracer.startSpan(`temporal.worker.${context.kind}`, {
      attributes: {
        'temporal.kind': context.kind,
        'temporal.namespace': context.namespace,
        'temporal.task_queue': context.taskQueue ?? '',
        'temporal.identity': context.identity ?? '',
        'temporal.workflow_id': context.workflowId ?? '',
        'temporal.run_id': context.runId ?? '',
        'temporal.attempt': context.attempt ?? 0,
        'temporal.build_id': context.buildId ?? '',
      },
    })
    return Effect.gen(function* () {
      yield* logger.log('debug', 'worker trace start', { traceId, kind: context.kind })
      try {
        const result = yield* next()
        span.setStatus({ code: SpanStatusCode.OK })
        yield* logger.log('debug', 'worker trace finish', {
          traceId,
          kind: context.kind,
        })
        span.end()
        return result
      } catch (error) {
        span.recordException(error as Error)
        span.setStatus({ code: SpanStatusCode.ERROR })
        yield* logger.log('error', 'worker trace error', {
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

export const makeDefaultWorkerInterceptors = (
  input: WorkerInterceptorBuilderInput,
): Effect.Effect<TemporalInterceptor[], unknown, never> =>
  Effect.gen(function* () {
    const metrics = yield* makeWorkerMetricHandles(input.metricsRegistry)
    const interceptors: TemporalInterceptor[] = [metricsInterceptor(metrics), loggingInterceptor(input.logger)]
    if (input.tracingEnabled) {
      interceptors.push(tracingInterceptor(input.logger))
    }
    return interceptors
  })

export const runWorkerInterceptors = <A>(
  interceptors: readonly TemporalInterceptor[],
  context: Omit<Parameters<typeof runInterceptors<A>>[1], 'direction'>,
  run: () => Effect.Effect<A, unknown, never>,
) => runInterceptors(interceptors as readonly TemporalInterceptor<A>[], context, run)
