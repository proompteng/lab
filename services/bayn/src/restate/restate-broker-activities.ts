import * as restate from '@restatedev/restate-sdk'
import { Clock, Result } from 'effect'

import {
  brokerActivityProjectionContract,
  type BrokerActivityCursorState,
  type BrokerActivityCatchupComplete,
  type BrokerActivityError,
  type BrokerActivityEvent,
  type BrokerActivityHeartbeat,
  type BrokerActivityHeartbeatReceipt,
  type BrokerActivityMessage,
  type BrokerActivityCatchupResult,
  type BrokerActivityPersistenceResult,
  type BrokerActivityRecordResult,
} from '../broker/activities'
import { brokerObservationJsonSerde, type BrokerObservationOwnerConfig } from './restate-broker-observations'

const persistenceRunOptions = { initialRetryInterval: 50, maxRetryInterval: 1_000 }

export interface BrokerActivityRuntime {
  readonly verify: (candidate: unknown, nowMs: number) => Result.Result<BrokerActivityMessage, BrokerActivityError>
  readonly cursor: (signal: AbortSignal) => Promise<BrokerActivityCursorState>
  readonly record: (signal: AbortSignal, event: BrokerActivityEvent) => Promise<BrokerActivityRecordResult>
  readonly completeCatchup: (
    signal: AbortSignal,
    event: BrokerActivityCatchupComplete,
  ) => Promise<BrokerActivityCatchupResult>
  readonly heartbeat: (
    signal: AbortSignal,
    event: BrokerActivityHeartbeat,
  ) => Promise<BrokerActivityPersistenceResult<BrokerActivityHeartbeatReceipt>>
}

export const makeBaynBrokerActivities = (
  config: BrokerObservationOwnerConfig,
  runtime: BrokerActivityRuntime,
  hooks: readonly restate.HooksProvider[] = [],
  transportClock: Pick<Clock.Clock, 'currentTimeMillisUnsafe'> = Clock.Clock.defaultValue(),
) => {
  const verifyKey = (ctx: Pick<restate.ObjectSharedContext, 'key'>) => {
    if (ctx.key !== config.controllerKey) throw new restate.TerminalError('broker activity account binding mismatch')
  }
  const verify = async (ctx: restate.ObjectContext, candidate: unknown) => {
    const result = await ctx.run('verify broker activity', async () =>
      runtime.verify(candidate, transportClock.currentTimeMillisUnsafe()).pipe(
        Result.match({
          onFailure: (failure) => ({ accepted: false as const, reason: failure.reason }),
          onSuccess: (activity) => ({ accepted: true as const, activity }),
        }),
      ),
    )
    if (!result.accepted)
      throw new restate.TerminalError(`broker activity rejected: ${result.reason}`, { errorCode: 400 })
    if (result.activity.session.sourceRevision !== config.sourceRevision)
      throw new restate.TerminalError('broker activity source revision mismatch', { errorCode: 409 })
    return result.activity
  }
  const reconcile = (ctx: restate.ObjectContext, eventId: string) =>
    ctx.genericSend({
      service: 'BaynBrokerObservations',
      method: 'reconcile',
      key: ctx.key,
      parameter: { eventId },
      inputSerde: brokerObservationJsonSerde,
      idempotencyKey: `broker-activity-reconcile:${eventId}`,
    })
  return restate.object({
    name: 'BaynBrokerActivities',
    metadata: {
      'bayn.source-revision': config.sourceRevision,
      'bayn.broker-identity-hash': config.controllerKey,
    },
    handlers: {
      cursor: restate.handlers.object.shared(
        { ingressPrivate: false },
        async (ctx: restate.ObjectSharedContext, _candidate: unknown) => {
          verifyKey(ctx)
          const cursor = await ctx.run(
            'read durable broker activity cursor',
            () => runtime.cursor(ctx.request().attemptCompletedSignal),
            persistenceRunOptions,
          )
          return { ...cursor, projectionContract: brokerActivityProjectionContract }
        },
      ),
      ingest: restate.handlers.object.exclusive(
        { ingressPrivate: false, idempotencyRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, candidate: unknown) => {
          verifyKey(ctx)
          const activity = await verify(ctx, candidate)
          if (activity._tag !== 'Event')
            throw new restate.TerminalError('broker activity ingest requires a source event', { errorCode: 400 })
          const result = await ctx.run(
            'retain and project broker activity',
            () => runtime.record(ctx.request().attemptCompletedSignal, activity),
            persistenceRunOptions,
          )
          if (result._tag === 'RetiredRevision')
            throw new restate.TerminalError('broker activity owner revision is retired', { errorCode: 409 })
          if (result._tag === 'SourceConflict') {
            reconcile(ctx, result.eventId)
            throw new restate.TerminalError('broker activity source content conflicts with retained evidence', {
              errorCode: 409,
            })
          }
          if (result._tag === 'CoverageConflict') {
            reconcile(ctx, result.eventId)
            throw new restate.TerminalError('broker activity contradicts retained publication coverage', {
              errorCode: 409,
            })
          }
          const receipt = result.receipt
          if (receipt.caughtUp) reconcile(ctx, receipt.eventId)
          return receipt
        },
      ),
      catchup: restate.handlers.object.exclusive(
        { ingressPrivate: false, idempotencyRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, candidate: unknown) => {
          verifyKey(ctx)
          const activity = await verify(ctx, candidate)
          if (activity._tag !== 'CatchupComplete')
            throw new restate.TerminalError('broker activity catchup requires a completed historical boundary', {
              errorCode: 400,
            })
          const result = await ctx.run(
            'retain broker activity catchup boundary',
            () => runtime.completeCatchup(ctx.request().attemptCompletedSignal, activity),
            persistenceRunOptions,
          )
          if (result._tag === 'RetiredRevision')
            throw new restate.TerminalError('broker activity owner revision is retired', { errorCode: 409 })
          if (result._tag === 'CoverageConflict') {
            reconcile(ctx, result.eventId)
            throw new restate.TerminalError('broker activity publication coverage is unproved', { errorCode: 409 })
          }
          return {
            accepted: true,
            eventId: activity.eventId,
            ...result.receipt,
            projectionContract: brokerActivityProjectionContract,
          }
        },
      ),
      heartbeat: restate.handlers.object.exclusive(
        { ingressPrivate: false, idempotencyRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, candidate: unknown) => {
          verifyKey(ctx)
          const activity = await verify(ctx, candidate)
          if (activity._tag !== 'Heartbeat')
            throw new restate.TerminalError('broker activity heartbeat requires a live stream boundary', {
              errorCode: 400,
            })
          const result = await ctx.run(
            'retain broker activity heartbeat',
            () => runtime.heartbeat(ctx.request().attemptCompletedSignal, activity),
            persistenceRunOptions,
          )
          if (result._tag === 'RetiredRevision')
            throw new restate.TerminalError('broker activity owner revision is retired', { errorCode: 409 })
          const cursor = result.receipt
          if (cursor.activated) reconcile(ctx, activity.eventId)
          return {
            accepted: true,
            eventId: activity.eventId,
            ...cursor,
            projectionContract: brokerActivityProjectionContract,
          }
        },
      ),
    },
    options: {
      ingressPrivate: false,
      enableLazyState: false,
      hooks: [...hooks],
      retryPolicy: { maxAttempts: 3, onMaxAttempts: 'pause', initialInterval: 1_000, maxInterval: 10_000 },
      inactivityTimeout: { milliseconds: config.operationTimeoutMs * 2 },
      abortTimeout: { milliseconds: config.operationTimeoutMs * 3 },
    },
  })
}
