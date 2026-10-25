import * as restate from '@restatedev/restate-sdk'
import { Clock, Result, Schema } from 'effect'

import { mutationConsistencyDelayMs } from '../broker/alpaca/model'
import { GitSourceRevisionSchema, Sha256Schema, strictParseOptions } from '../schemas'

const key = 'polling'
const budgetKey = 'next-poll-not-before-ms'
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
export const BrokerObservationOwnerStateSchema = Schema.Struct({
  ...TickSchema.fields,
  lastSnapshotHash: Schema.optionalKey(Sha256Schema),
})
type State = typeof BrokerObservationOwnerStateSchema.Type

export type BrokerObservationPoll = (
  | { readonly _tag: 'Published'; readonly snapshotHash: string }
  | { readonly _tag: 'Invalidated' }
  | { readonly _tag: 'QuotaWait' }
  | {
      readonly _tag: 'Unavailable'
      readonly captureNotStarted?: { readonly reason: 'ExpiredUnusedTicket'; readonly expiredByMs: number }
    }
) & { readonly nextPollNotBeforeMs: number }

export interface BrokerObservationRuntime {
  readonly activate: (signal: AbortSignal, nextPollNotBeforeMs: number) => Promise<void>
  readonly poll: (
    signal: AbortSignal,
    reservation: {
      readonly captureId: string
    },
  ) => Promise<{
    readonly poll: BrokerObservationPoll
    readonly startedAtMs: number
    readonly completedAtMs: number
  }>
}
export interface BrokerObservationOwnerConfig {
  readonly controllerKey: string
  readonly sourceRevision: string
  readonly pollIntervalMs: number
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
  const abortTimeoutMs = config.operationTimeoutMs * 3
  const verifyKey = (ctx: restate.ObjectContext) => {
    if (ctx.key !== config.controllerKey) throw new restate.TerminalError('broker observation account binding mismatch')
  }
  // SDK 1.16.5 encodes delay as invoke_time; core 7.0.2 excludes it from send replay equality.
  const schedule = (ctx: restate.ObjectContext, state: State, delayMs: number) =>
    ctx.genericSend({
      service: 'BaynBrokerObservations',
      method: 'poll',
      key: ctx.key,
      parameter: { sourceRevision: state.sourceRevision, epoch: state.epoch, sequence: state.sequence },
      inputSerde: brokerObservationJsonSerde,
      delay: { milliseconds: delayMs },
      idempotencyKey: `broker-observations:${state.sourceRevision}:${state.epoch}:${state.sequence}`,
    })
  const sample = async (
    ctx: restate.ObjectContext,
    waitForQuota: boolean,
  ): Promise<{ readonly poll: BrokerObservationPoll; readonly startedAt: number }> => {
    while (true) {
      let sampled: Awaited<ReturnType<BrokerObservationRuntime['poll']>>
      try {
        sampled = await ctx.run(
          'poll and publish broker observation',
          () => runtime.poll(ctx.request().attemptCompletedSignal, { captureId: ctx.request().id }),
          { maxRetryAttempts: 0 },
        )
      } catch {
        ctx.console.warn('Broker observation poll failed before publication; the durable claim retains quota')
        return {
          poll: { _tag: 'Unavailable', nextPollNotBeforeMs: 0 },
          startedAt: transportClock.currentTimeMillisUnsafe(),
        }
      }
      if (!waitForQuota || sampled.poll._tag !== 'QuotaWait')
        return { poll: sampled.poll, startedAt: sampled.startedAtMs }
      await ctx.sleep({ milliseconds: Math.max(0, sampled.poll.nextPollNotBeforeMs - sampled.completedAtMs) })
    }
  }
  const nextDelay = (poll: BrokerObservationPoll, startedAt: number, completedAt: number) =>
    Math.max(
      poll._tag === 'QuotaWait'
        ? 0
        : poll._tag === 'Invalidated'
          ? mutationConsistencyDelayMs
          : Math.max(1_000, config.pollIntervalMs - (completedAt - startedAt)),
      poll.nextPollNotBeforeMs - completedAt,
    )
  return restate.object({
    name: 'BaynBrokerObservations',
    handlers: {
      activate: restate.handlers.object.exclusive(async (ctx: restate.ObjectContext, candidate: unknown) => {
        verifyKey(ctx)
        const request = decode(BindingSchema, candidate)
        if (request.sourceRevision !== config.sourceRevision)
          throw new restate.TerminalError('broker observation activation revision mismatch')
        const stored = await ctx.get<unknown>(key)
        const current = stored === null ? null : decode(BrokerObservationOwnerStateSchema, stored)
        if (current?.sourceRevision !== config.sourceRevision) {
          const storedBudget = await ctx.get<unknown>(budgetKey)
          const nextPollNotBeforeMs = storedBudget === null ? 0 : decode(BudgetDeadlineSchema, storedBudget)
          await ctx.run(
            'activate broker observation projection',
            () => runtime.activate(ctx.request().attemptCompletedSignal, nextPollNotBeforeMs),
            { maxRetryAttempts: 0 },
          )
          ctx.clear(budgetKey)
        }
        const { poll, startedAt } = await sample(ctx, true)
        const sameRevision = current?.sourceRevision === config.sourceRevision
        const state: State = {
          sourceRevision: config.sourceRevision,
          epoch: sameRevision ? current.epoch : (current?.epoch ?? 0) + 1,
          sequence: sameRevision ? current.sequence : 1,
          ...(poll._tag === 'Published' ? { lastSnapshotHash: poll.snapshotHash } : {}),
        }
        ctx.set(key, state)
        schedule(ctx, state, nextDelay(poll, startedAt, transportClock.currentTimeMillisUnsafe()))
        return state
      }),
      poll: restate.handlers.object.exclusive(async (ctx: restate.ObjectContext, candidate: unknown) => {
        verifyKey(ctx)
        const tick = decode(TickSchema, candidate)
        const stored = await ctx.get<unknown>(key)
        if (stored === null) return
        const current = decode(BrokerObservationOwnerStateSchema, stored)
        if (
          tick.sourceRevision !== config.sourceRevision ||
          current.sourceRevision !== config.sourceRevision ||
          tick.epoch !== current.epoch ||
          tick.sequence !== current.sequence
        )
          return
        const { poll, startedAt } = await sample(ctx, false)
        const next: State = {
          sourceRevision: current.sourceRevision,
          epoch: current.epoch,
          sequence: current.sequence + 1,
          ...(poll._tag === 'Published' ? { lastSnapshotHash: poll.snapshotHash } : {}),
        }
        ctx.set(key, next)
        schedule(ctx, next, nextDelay(poll, startedAt, transportClock.currentTimeMillisUnsafe()))
      }),
      status: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext, _candidate: unknown) => {
        if (ctx.key !== config.controllerKey)
          throw new restate.TerminalError('broker observation account binding mismatch')
        const stored = await ctx.get<unknown>(key)
        return stored === null ? null : decode(BrokerObservationOwnerStateSchema, stored)
      }),
    },
    options: {
      ingressPrivate: true,
      enableLazyState: false,
      hooks: [...hooks],
      retryPolicy: { maxAttempts: 3, onMaxAttempts: 'pause', initialInterval: 1_000, maxInterval: 10_000 },
      inactivityTimeout: { milliseconds: config.operationTimeoutMs * 2 },
      abortTimeout: { milliseconds: abortTimeoutMs },
    },
  })
}
