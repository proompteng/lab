import * as restate from '@restatedev/restate-sdk'
import { Clock, Result, Schema } from 'effect'

import { mutationConsistencyDelayMs } from '../broker/alpaca/model'
import type { BrokerNotification, BrokerNotificationError } from '../broker/notifications'
import type { BrokerSourceProjectionAttempt } from '../broker/trade-update-projection'
import type { ExecutionWakeup, ProtectionReleaseReference } from '../execution/events'
import { GitSourceRevisionSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'

const key = 'observation'
const previousKey = 'polling'
const budgetKey = 'next-poll-not-before-ms'
const recoveryDelayMs = 1_000
const coalescingDelayMs = 100
export const brokerSourceProjectionContract = 'bayn.broker-source-projection.v1'
// Explicit intervals override the finite handler retry policy. Accepted notifications must survive a database
// outage without recording a terminal run result; leave attempt and duration limits unset for idempotent writes.
const persistenceRunOptions = { initialRetryInterval: 50, maxRetryInterval: 1_000 }
const BudgetDeadlineSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const brokerObservationJsonSerde = restate.serde.json.schema<unknown>({})
const BindingSchema = Schema.Struct({ sourceRevision: GitSourceRevisionSchema })
const RefreshSchema = Schema.Struct({ ...BindingSchema.fields, cycleId: Schema.optionalKey(Sha256Schema) })
const TickSchema = Schema.Struct({
  sourceRevision: GitSourceRevisionSchema,
  epoch: Schema.Int.check(Schema.isGreaterThan(0)),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const PreviousOwnerSchema = Schema.Struct({
  ...TickSchema.fields,
  lastSnapshotHash: Schema.optionalKey(Sha256Schema),
})
const ReceiptSchema = Schema.Struct({ eventId: Sha256Schema })
export const BrokerObservationOwnerStateSchema = Schema.Struct({
  ...TickSchema.fields,
  captureScheduled: Schema.Boolean,
  nextCaptureNotBeforeMs: BudgetDeadlineSchema,
  pendingNotificationId: Schema.optionalKey(Sha256Schema),
  lastSnapshotHash: Schema.optionalKey(Sha256Schema),
  lastObservedAt: Schema.optionalKey(UtcInstantSchema),
})
type State = typeof BrokerObservationOwnerStateSchema.Type
type Tick = typeof TickSchema.Type

export type BrokerObservationPoll = (
  | { readonly _tag: 'Published'; readonly snapshotHash: string; readonly observedAt: string }
  | { readonly _tag: 'Invalidated' }
  | { readonly _tag: 'QuotaWait' }
  | {
      readonly _tag: 'Unavailable'
      readonly captureNotStarted?: { readonly reason: 'ExpiredUnusedTicket'; readonly expiredByMs: number }
    }
) & { readonly nextPollNotBeforeMs: number }

export interface BrokerObservationRuntime {
  readonly verifyNotification: (
    candidate: unknown,
    nowMs: number,
  ) => Result.Result<BrokerNotification, BrokerNotificationError>
  readonly activate: (signal: AbortSignal, nextPollNotBeforeMs: number) => Promise<void>
  readonly recordNotification: (
    signal: AbortSignal,
    notification: BrokerNotification,
  ) => Promise<{ readonly covered: boolean }>
  readonly isNotificationCovered: (signal: AbortSignal, eventId: string) => Promise<boolean>
  readonly project: (
    signal: AbortSignal,
    eventId: string,
    allowProtectionWait?: boolean,
  ) => Promise<BrokerSourceProjectionAttempt>
  readonly invalidate: (signal: AbortSignal) => Promise<void>
  readonly probeProtection: (
    signal: AbortSignal,
    cycleId: string,
    claimId: string,
  ) => Promise<ProtectionReleaseReference | undefined>
  readonly poll: (
    signal: AbortSignal,
    reservation: { readonly captureId: string },
  ) => Promise<{
    readonly poll: BrokerObservationPoll
    readonly startedAtMs: number
    readonly completedAtMs: number
  }>
}
export interface BrokerObservationOwnerConfig {
  readonly controllerKey: string
  readonly sourceRevision: string
  readonly maxAgeMs: number
  readonly freshnessLeadMs: number
  readonly operationTimeoutMs: number
}
const decode = <A>(schema: Schema.Codec<A>, value: unknown): A => {
  const decoded = Schema.decodeUnknownResult(schema, strictParseOptions)(value)
  if (Result.isFailure(decoded)) throw new restate.TerminalError('broker observation command failed validation')
  return decoded.success
}

export const makeBaynBrokerObservations = (
  config: BrokerObservationOwnerConfig,
  runtime: BrokerObservationRuntime,
  hooks: readonly restate.HooksProvider[] = [],
  transportClock: Pick<Clock.Clock, 'currentTimeMillisUnsafe'> = Clock.Clock.defaultValue(),
) => {
  const verifyKey = (ctx: Pick<restate.ObjectSharedContext, 'key'>) => {
    if (ctx.key !== config.controllerKey) throw new restate.TerminalError('broker observation account binding mismatch')
  }
  const read = async (ctx: restate.ObjectSharedContext): Promise<State | null> => {
    const stored = await ctx.get<unknown>(key)
    return stored === null ? null : decode(BrokerObservationOwnerStateSchema, stored)
  }
  const matches = (state: State | null, tick: Tick): state is State =>
    state !== null &&
    tick.sourceRevision === config.sourceRevision &&
    state.sourceRevision === config.sourceRevision &&
    tick.epoch === state.epoch &&
    tick.sequence === state.sequence
  // Delay only controls delivery. Quota and snapshot deadlines remain journaled values.
  // SDK 1.16.5 encodes delay as invoke_time; core 7.0.2 excludes it from send replay equality.
  const schedule = (ctx: restate.ObjectContext, method: 'capture' | 'freshness', state: State, dueAt: number) =>
    ctx.genericSend({
      service: 'BaynBrokerObservations',
      method,
      key: ctx.key,
      parameter: { sourceRevision: state.sourceRevision, epoch: state.epoch, sequence: state.sequence },
      inputSerde: brokerObservationJsonSerde,
      delay: { milliseconds: Math.max(0, dueAt - transportClock.currentTimeMillisUnsafe()) },
      idempotencyKey: `broker-observations:${method}:${state.sourceRevision}:${state.epoch}:${state.sequence}`,
    })
  const sample = async (ctx: restate.ObjectContext, waitForQuota: boolean): Promise<BrokerObservationPoll> => {
    const request = ctx.request()
    while (true) {
      let sampled: Awaited<ReturnType<BrokerObservationRuntime['poll']>>
      try {
        sampled = await ctx.run(
          'capture and publish broker observation',
          () => runtime.poll(request.attemptCompletedSignal, { captureId: request.id }),
          { maxRetryAttempts: 0 },
        )
      } catch {
        ctx.console.warn('Broker observation capture failed before publication; the durable claim retains quota')
        return { _tag: 'Unavailable', nextPollNotBeforeMs: 0 }
      }
      if (!waitForQuota || sampled.poll._tag !== 'QuotaWait') return sampled.poll
      await ctx.sleep({ milliseconds: Math.max(0, sampled.poll.nextPollNotBeforeMs - sampled.completedAtMs) })
    }
  }
  const publish = async (ctx: restate.ObjectContext, binding: Tick, poll: BrokerObservationPoll): Promise<State> => {
    const now = await ctx.date.now()
    const state: State = {
      ...binding,
      captureScheduled: poll._tag !== 'Published',
      nextCaptureNotBeforeMs: poll.nextPollNotBeforeMs,
      ...(poll._tag === 'Published' ? { lastSnapshotHash: poll.snapshotHash, lastObservedAt: poll.observedAt } : {}),
    }
    ctx.set(key, state)
    if (poll._tag === 'Published') {
      ctx.genericSend({
        service: 'BaynExecutionController',
        method: 'wake',
        key: ctx.key,
        parameter: {
          schemaVersion: 'bayn.execution-wakeup.v1',
          _tag: 'BrokerObservation',
          sourceRevision: state.sourceRevision,
          eventId: poll.snapshotHash,
          snapshotHash: poll.snapshotHash,
          observedAt: poll.observedAt,
        } satisfies ExecutionWakeup,
        inputSerde: brokerObservationJsonSerde,
        idempotencyKey: `broker-observation:${state.sourceRevision}:${poll.snapshotHash}`,
      })
      // Websocket order events do not cover cash, fees, or historical corrections.
      // Start their completeness refresh before the canonical observation expires.
      schedule(
        ctx,
        'freshness',
        state,
        Math.max(now, Date.parse(poll.observedAt) + config.maxAgeMs - config.freshnessLeadMs),
      )
    } else {
      const recoveryAt = now + (poll._tag === 'Invalidated' ? mutationConsistencyDelayMs : recoveryDelayMs)
      schedule(ctx, 'capture', state, Math.max(recoveryAt, poll.nextPollNotBeforeMs))
    }
    return state
  }
  return restate.object({
    name: 'BaynBrokerObservations',
    metadata: {
      'bayn.source-revision': config.sourceRevision,
      'bayn.broker-identity-hash': config.controllerKey,
    },
    handlers: {
      notify: restate.handlers.object.shared(
        { ingressPrivate: false, idempotencyRetention: { days: 7 } },
        async (ctx: restate.ObjectSharedContext, candidate: unknown) => {
          verifyKey(ctx)
          const verified = await ctx.run('verify broker notification', async () => {
            const result = runtime.verifyNotification(candidate, transportClock.currentTimeMillisUnsafe())
            return Result.isFailure(result)
              ? { accepted: false as const, reason: result.failure.reason }
              : { accepted: true as const, notification: result.success }
          })
          if (!verified.accepted)
            throw new restate.TerminalError(`broker notification rejected: ${verified.reason}`, { errorCode: 400 })
          const notification = verified.notification
          if (notification.session.sourceRevision !== config.sourceRevision)
            throw new restate.TerminalError('broker notification source revision mismatch', { errorCode: 409 })
          const signal = ctx.request().attemptCompletedSignal
          await ctx.run(
            'record verified broker notification',
            () => runtime.recordNotification(signal, notification),
            persistenceRunOptions,
          )
          ctx.genericSend({
            service: 'BaynBrokerSourceProjector',
            method: 'project',
            key: ctx.key,
            parameter: { eventId: notification.eventId },
            inputSerde: brokerObservationJsonSerde,
            idempotencyKey: `broker-source-project:${notification.eventId}`,
          })
          return {
            accepted: true,
            eventId: notification.eventId,
            sourceRevision: config.sourceRevision,
            projectionContract: brokerSourceProjectionContract,
          }
        },
      ),
      reconcile: restate.handlers.object.exclusive(
        { ingressPrivate: true, idempotencyRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, candidate: unknown) => {
          verifyKey(ctx)
          const receipt = decode(ReceiptSchema, candidate)
          const current = await read(ctx)
          if (
            current === null ||
            current.sourceRevision !== config.sourceRevision ||
            current.pendingNotificationId !== undefined
          )
            return
          const signal = ctx.request().attemptCompletedSignal
          await ctx.run(
            'invalidate broker observation after source event',
            () => runtime.invalidate(signal),
            persistenceRunOptions,
          )
          const state: State = {
            sourceRevision: current.sourceRevision,
            epoch: current.epoch,
            sequence: current.captureScheduled ? current.sequence : current.sequence + 1,
            captureScheduled: true,
            nextCaptureNotBeforeMs: current.nextCaptureNotBeforeMs,
            pendingNotificationId: receipt.eventId,
          }
          ctx.set(key, state)
          if (current.captureScheduled) return
          schedule(
            ctx,
            'capture',
            state,
            Math.max((await ctx.date.now()) + coalescingDelayMs, state.nextCaptureNotBeforeMs),
          )
        },
      ),
      refresh: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        async (ctx: restate.ObjectContext, candidate: unknown) => {
          verifyKey(ctx)
          const binding = decode(RefreshSchema, candidate)
          if (binding.sourceRevision !== config.sourceRevision) return
          const current = await read(ctx)
          if (current === null || current.sourceRevision !== config.sourceRevision) return
          const receivedAt = await ctx.date.now()
          const request = ctx.request()
          await ctx.run(
            'invalidate broker observation after execution mutation',
            () => runtime.invalidate(request.attemptCompletedSignal),
            persistenceRunOptions,
          )
          const state: State = {
            sourceRevision: current.sourceRevision,
            epoch: current.epoch,
            sequence: current.sequence + 1,
            captureScheduled: true,
            nextCaptureNotBeforeMs: current.nextCaptureNotBeforeMs,
            ...(current.pendingNotificationId === undefined
              ? {}
              : { pendingNotificationId: current.pendingNotificationId }),
          }
          ctx.set(key, state)
          const cycleId = binding.cycleId
          if (cycleId !== undefined) {
            let proof: ProtectionReleaseReference | null = null
            try {
              proof = await ctx.run(
                'read and record exact protective release',
                async () =>
                  (await runtime.probeProtection(request.attemptCompletedSignal, cycleId, request.id)) ?? null,
                { maxRetryAttempts: 2, initialRetryInterval: 75 },
              )
            } catch {
              ctx.console.warn('Protective release read failed before the next complete broker capture')
            }
            if (proof !== null)
              ctx.genericSend({
                service: 'BaynExecutionController',
                method: 'wake',
                key: ctx.key,
                parameter: {
                  schemaVersion: 'bayn.execution-wakeup.v1',
                  _tag: 'ProtectionRelease',
                  sourceRevision: state.sourceRevision,
                  eventId: proof.proofId,
                  ...proof,
                } satisfies ExecutionWakeup,
                inputSerde: brokerObservationJsonSerde,
                idempotencyKey: `broker-protection-proof:${proof.proofId}`,
              })
          }
          schedule(ctx, 'capture', state, Math.max(receivedAt + coalescingDelayMs, state.nextCaptureNotBeforeMs))
        },
      ),
      activate: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        async (ctx: restate.ObjectContext, candidate: unknown) => {
          verifyKey(ctx)
          const request = decode(BindingSchema, candidate)
          if (request.sourceRevision !== config.sourceRevision)
            throw new restate.TerminalError('broker observation activation revision mismatch')
          const current = await read(ctx)
          // One-way handover of the previous owner; no old handler or polling implementation is retained.
          const storedPrevious = current === null ? await ctx.get<unknown>(previousKey) : null
          const previous = storedPrevious === null ? null : decode(PreviousOwnerSchema, storedPrevious)
          if (current?.sourceRevision !== config.sourceRevision) {
            const storedBudget = await ctx.get<unknown>(budgetKey)
            const nextPollNotBeforeMs = Math.max(
              current?.nextCaptureNotBeforeMs ?? 0,
              storedBudget === null ? 0 : decode(BudgetDeadlineSchema, storedBudget),
            )
            const signal = ctx.request().attemptCompletedSignal
            await ctx.run(
              'activate broker observation projection',
              () => runtime.activate(signal, nextPollNotBeforeMs),
              { maxRetryAttempts: 0 },
            )
            ctx.clear(budgetKey)
          }
          const binding: Tick = {
            sourceRevision: config.sourceRevision,
            epoch:
              current?.sourceRevision === config.sourceRevision
                ? current.epoch
                : (current?.epoch ?? previous?.epoch ?? 0) + 1,
            sequence: (current?.sequence ?? previous?.sequence ?? 0) + 1,
          }
          const state = await publish(ctx, binding, await sample(ctx, true))
          ctx.clear(previousKey)
          return state
        },
      ),
      capture: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        async (ctx: restate.ObjectContext, candidate: unknown) => {
          verifyKey(ctx)
          const tick = decode(TickSchema, candidate)
          const current = await read(ctx)
          if (!matches(current, tick) || !current.captureScheduled) return
          await publish(ctx, { ...tick, sequence: tick.sequence + 1 }, await sample(ctx, false))
        },
      ),
      freshness: restate.handlers.object.exclusive(
        { ingressPrivate: true },
        async (ctx: restate.ObjectContext, candidate: unknown) => {
          verifyKey(ctx)
          const tick = decode(TickSchema, candidate)
          const current = await read(ctx)
          if (!matches(current, tick) || current.captureScheduled) return
          const state: State = { ...current, sequence: current.sequence + 1, captureScheduled: true }
          ctx.set(key, state)
          schedule(ctx, 'capture', state, Math.max(await ctx.date.now(), state.nextCaptureNotBeforeMs))
        },
      ),
      status: restate.handlers.object.shared(
        { ingressPrivate: true },
        async (ctx: restate.ObjectSharedContext, _candidate: unknown) => {
          verifyKey(ctx)
          return read(ctx)
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

export const makeBaynBrokerSourceProjector = (
  config: BrokerObservationOwnerConfig,
  runtime: Pick<BrokerObservationRuntime, 'isNotificationCovered' | 'project'>,
  hooks: readonly restate.HooksProvider[] = [],
) => {
  const verifyKey = (ctx: Pick<restate.ObjectSharedContext, 'key'>) => {
    if (ctx.key !== config.controllerKey) throw new restate.TerminalError('broker projector account binding mismatch')
  }
  return restate.object({
    name: 'BaynBrokerSourceProjector',
    metadata: {
      'bayn.source-revision': config.sourceRevision,
      'bayn.broker-identity-hash': config.controllerKey,
    },
    handlers: {
      // This object is independent of the snapshot owner so slow provider reads cannot block ordered source evidence.
      project: restate.handlers.object.exclusive(
        { ingressPrivate: true, idempotencyRetention: { days: 7 } },
        async (ctx: restate.ObjectContext, candidate: unknown) => {
          verifyKey(ctx)
          const receipt = decode(ReceiptSchema, candidate)
          const signal = ctx.request().attemptCompletedSignal
          let projection = await ctx.run(
            'project durable broker source event',
            () => runtime.project(signal, receipt.eventId),
            persistenceRunOptions,
          )
          if (projection._tag === 'AwaitingProtection') {
            // Only the ordered projector waits. The financial writer transaction has returned, and the independent
            // canonical owner can establish the parent/child binding or cover this early nonfinancial event.
            ctx.genericSend({
              service: 'BaynBrokerObservations',
              method: 'reconcile',
              key: ctx.key,
              parameter: { eventId: receipt.eventId },
              inputSerde: brokerObservationJsonSerde,
              idempotencyKey: `broker-source-reconcile:${receipt.eventId}`,
            })
            const deadlineMs = Date.parse(projection.deadlineAt)
            let attempt = 0
            while (projection._tag === 'AwaitingProtection') {
              const remaining = Math.max(0, deadlineMs - (await ctx.date.now()))
              if (remaining > 0) await ctx.sleep({ milliseconds: Math.min(recoveryDelayMs, remaining) })
              const allowProtectionWait = (await ctx.date.now()) < deadlineMs
              projection = await ctx.run(
                `resolve broker protection binding ${++attempt}`,
                () => runtime.project(signal, receipt.eventId, allowProtectionWait),
                persistenceRunOptions,
              )
              if (!allowProtectionWait && projection._tag === 'AwaitingProtection')
                throw new restate.TerminalError('broker protection binding exceeded its original recovery deadline')
            }
          }
          if (projection._tag === 'CanonicallyCovered') return projection
          const covered = await ctx.run(
            'check canonical broker source coverage',
            () => runtime.isNotificationCovered(signal, receipt.eventId),
            persistenceRunOptions,
          )
          if (projection._tag === 'Projected')
            ctx.genericSend({
              service: 'BaynExecutionController',
              method: 'wake',
              key: ctx.key,
              parameter: {
                schemaVersion: 'bayn.execution-wakeup.v1',
                _tag: 'BrokerEvent',
                sourceRevision: config.sourceRevision,
                eventId: projection.eventId,
                observedAt: projection.observedAt,
              } satisfies ExecutionWakeup,
              inputSerde: brokerObservationJsonSerde,
              idempotencyKey: `broker-source-wake:${projection.eventId}`,
            })
          if (!covered)
            ctx.genericSend({
              service: 'BaynBrokerObservations',
              method: 'reconcile',
              key: ctx.key,
              parameter: { eventId: projection.eventId },
              inputSerde: brokerObservationJsonSerde,
              idempotencyKey: `broker-source-reconcile:${projection.eventId}`,
            })
          return projection
        },
      ),
    },
    options: {
      ingressPrivate: true,
      enableLazyState: false,
      hooks: [...hooks],
      retryPolicy: { maxAttempts: 3, onMaxAttempts: 'pause', initialInterval: 1_000, maxInterval: 10_000 },
      inactivityTimeout: { milliseconds: config.operationTimeoutMs * 2 },
      abortTimeout: { milliseconds: config.operationTimeoutMs * 3 },
    },
  })
}
