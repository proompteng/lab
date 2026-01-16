import { Effect } from 'effect'
import type { DataConverter } from '../common/payloads'

export type InterceptorDirection = 'outbound' | 'inbound'

export type InterceptorKind =
  | 'rpc'
  | 'schedule.create'
  | 'schedule.describe'
  | 'schedule.update'
  | 'schedule.patch'
  | 'schedule.list'
  | 'schedule.listMatchingTimes'
  | 'schedule.delete'
  | 'schedule.trigger'
  | 'schedule.backfill'
  | 'schedule.pause'
  | 'schedule.unpause'
  | 'workflow.start'
  | 'workflow.signal'
  | 'workflow.query'
  | 'workflow.result'
  | 'workflow.update'
  | 'workflow.updateOptions'
  | 'workflow.cancel'
  | 'workflow.terminate'
  | 'workflow.pause'
  | 'workflow.unpause'
  | 'workflow.signalWithStart'
  | 'workflow.awaitUpdate'
  | 'workflow.describe'
  | 'workflow.resetStickyTaskQueue'
  | 'worker.list'
  | 'worker.describe'
  | 'worker.fetchConfig'
  | 'worker.updateConfig'
  | 'worker.updateTaskQueueConfig'
  | 'worker.getVersioningRules'
  | 'worker.updateVersioningRules'
  | 'deployment.list'
  | 'deployment.describe'
  | 'deployment.delete'
  | 'deployment.deleteVersion'
  | 'deployment.listWorkerDeployments'
  | 'deployment.describeWorkerDeployment'
  | 'deployment.getCurrent'
  | 'deployment.setCurrent'
  | 'deployment.setCurrentVersion'
  | 'deployment.setManager'
  | 'deployment.setRampingVersion'
  | 'deployment.reachability'
  | 'deployment.updateVersionMetadata'
  | 'operator.addSearchAttributes'
  | 'operator.removeSearchAttributes'
  | 'operator.listSearchAttributes'
  | 'operator.createNexusEndpoint'
  | 'operator.updateNexusEndpoint'
  | 'operator.deleteNexusEndpoint'
  | 'operator.getNexusEndpoint'
  | 'operator.listNexusEndpoints'
  | 'worker.workflowTask'
  | 'worker.activityTask'
  | 'worker.queryTask'
  | 'worker.updateTask'

export interface InterceptorContext {
  kind: InterceptorKind
  direction: InterceptorDirection
  namespace: string
  taskQueue?: string
  identity?: string
  workflowId?: string
  runId?: string
  updateId?: string
  attempt?: number
  buildId?: string
  headers?: Record<string, string>
  dataConverter?: DataConverter
  metadata?: Record<string, unknown>
  startedAt?: number
  durationMs?: number
  result?: unknown
  error?: unknown
}

export type InterceptorNext<A> = () => Effect.Effect<A, unknown, never>

export interface TemporalInterceptor<A = unknown> {
  readonly name?: string
  readonly order?: number
  readonly kinds?: readonly InterceptorKind[]
  readonly outbound?: (context: InterceptorContext, next: InterceptorNext<A>) => Effect.Effect<A, unknown, never>
  readonly inbound?: (context: InterceptorContext, next: InterceptorNext<A>) => Effect.Effect<A, unknown, never>
}

const byOrder = (a: TemporalInterceptor, b: TemporalInterceptor) => (a.order ?? 0) - (b.order ?? 0)

const matchesKind = (interceptor: TemporalInterceptor, kind: InterceptorKind): boolean => {
  if (!interceptor.kinds || interceptor.kinds.length === 0) {
    return true
  }
  return interceptor.kinds.includes(kind)
}

export const runInterceptors = <A>(
  interceptors: readonly TemporalInterceptor<A>[],
  baseContext: Omit<InterceptorContext, 'direction'>,
  run: InterceptorNext<A>,
): Effect.Effect<A, unknown, never> => {
  const applicable = interceptors.filter((interceptor) => matchesKind(interceptor, baseContext.kind)).sort(byOrder)
  const start = baseContext.startedAt ?? Date.now()
  const outboundContext: InterceptorContext = Object.assign(baseContext, {
    startedAt: start,
    direction: 'outbound' as const,
  })

  const outboundPipeline = applicable.reduceRight<InterceptorNext<A>>((next, interceptor) => {
    if (!interceptor.outbound) {
      return next
    }
    return () => interceptor.outbound(outboundContext, next)
  }, run)

  const runInbound = (result: A | undefined, error: unknown): Effect.Effect<A, unknown, never> => {
    const inboundContext: InterceptorContext = {
      ...outboundContext,
      direction: 'inbound',
      durationMs: Date.now() - start,
      result,
      error,
    }
    const terminal: InterceptorNext<A> = () =>
      (error ? Effect.fail(error) : Effect.succeed(result as A)) as Effect.Effect<A, unknown, never>

    const inboundPipeline = applicable.reduceRight<InterceptorNext<A>>((next, interceptor) => {
      if (!interceptor.inbound) {
        return next
      }
      return () => interceptor.inbound(inboundContext, next)
    }, terminal)
    return inboundPipeline()
  }

  return outboundPipeline().pipe(
    Effect.matchEffect({
      onSuccess: (result) => runInbound(result, undefined),
      onFailure: (error) => runInbound(undefined, error),
    }),
  )
}
