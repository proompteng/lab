import * as restate from '@restatedev/restate-sdk'
import { Clock, Result, Schema } from 'effect'

import { mutationConsistencyDelayMs } from '../broker/alpaca/model'
import type { BrokerNotification, BrokerNotificationError } from '../broker/notifications'
import type { ExecutionWakeup } from '../execution/events'
import { GitSourceRevisionSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'

const key = 'observation'
const previousKey = 'polling'
const budgetKey = 'next-poll-not-before-ms'
const recoveryDelayMs = 1_000
const coalescingDelayMs = 100
// Explicit intervals override the finite handler retry policy. Accepted notifications must survive a database
// outage without recording a terminal run result; leave attempt and duration limits unset for idempotent writes.
const persistenceRunOptions = { initialRetryInterval: 50, maxRetryInterval: 1_000 }
const BudgetDeadlineSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
export const brokerObservationJsonSerde = restate.serde.json.schema<unknown>({})
const BindingSchema = Schema.Struct({ sourceRevision: GitSourceRevisionSchema })
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
    receipt: Pick<BrokerNotification, 'eventId' | 'receivedAt'>,
  ) => Promise<{ readonly covered: boolean }>
  readonly invalidate: (signal: AbortSignal) => Promise<void>
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
    while (true) {
      let sampled: Awaited<ReturnType<BrokerObservationRuntime['poll']>>
      try {
        sampled = await ctx.run(
          'capture and publish broker observation',
          () => runtime.poll(ctx.request().attemptCompletedSignal, { captureId: ctx.request().id }),
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
        { ingressPrivate: false },
        async (ctx: restate.ObjectSharedContext, candidate: unknown) => {
          verifyKey(ctx)
          const verified = await ctx.run('verify broker notification', async () => {
            const result = runtime.verifyNotification(candidate, transportClock.currentTimeMillisUnsafe())
            return Result.isFailure(result)
              ? { accepted: false as const, reason: result.failure.reason }
              : { accepted: true as const, eventId: result.success.eventId, receivedAt: result.success.receivedAt }
          })
          if (!verified.accepted)
            throw new restate.TerminalError(`broker notification rejected: ${verified.reason}`, { errorCode: 400 })
          const retained = await ctx.run(
            'record verified broker notification',
            () =>
              runtime.recordNotification(ctx.request().attemptCompletedSignal, {
                eventId: verified.eventId,
                receivedAt: verified.receivedAt,
              }),
            persistenceRunOptions,
          )
          if (retained.covered) return { accepted: true, eventId: verified.eventId }
          // Only the stable identity is retained; payloads and credentials never enter owner state.
          ctx.genericSend({
            service: 'BaynBrokerObservations',
            method: 'accept',
            key: ctx.key,
            parameter: { eventId: verified.eventId },
            inputSerde: brokerObservationJsonSerde,
            idempotencyKey: `broker-notification:${verified.eventId}`,
          })
          return { accepted: true, eventId: verified.eventId }
        },
      ),
      accept: restate.handlers.object.exclusive(
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
          await ctx.run(
            'invalidate broker observation after notification',
            () => runtime.invalidate(ctx.request().attemptCompletedSignal),
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
          const binding = decode(BindingSchema, candidate)
          if (binding.sourceRevision !== config.sourceRevision) return
          const current = await read(ctx)
          if (current === null || current.sourceRevision !== config.sourceRevision) return
          const receivedAt = await ctx.date.now()
          await ctx.run(
            'invalidate broker observation after execution mutation',
            () => runtime.invalidate(ctx.request().attemptCompletedSignal),
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
            await ctx.run(
              'activate broker observation projection',
              () => runtime.activate(ctx.request().attemptCompletedSignal, nextPollNotBeforeMs),
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
