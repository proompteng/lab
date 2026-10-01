import * as restate from '@restatedev/restate-sdk'
import { Result, Schema } from 'effect'

import { mutationConsistencyDelayMs } from '../broker/alpaca/model'
import { GitSourceRevisionSchema, Sha256Schema, strictParseOptions } from '../schemas'

const key = 'polling'
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
  | { readonly _tag: 'Unavailable' }
) & { readonly nextPollNotBeforeMs: number }

export interface BrokerObservationRuntime {
  readonly activate: (signal: AbortSignal) => Promise<void>
  readonly poll: (signal: AbortSignal) => Promise<BrokerObservationPoll>
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
) => {
  const verifyKey = (ctx: restate.ObjectContext) => {
    if (ctx.key !== config.controllerKey) throw new restate.TerminalError('broker observation account binding mismatch')
  }
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
  const sample = async (ctx: restate.ObjectContext): Promise<BrokerObservationPoll> => {
    try {
      return await ctx.run(
        'poll and publish broker observation',
        () => runtime.poll(ctx.request().attemptCompletedSignal),
        { maxRetryAttempts: 0 },
      )
    } catch {
      ctx.console.warn('Broker observation poll failed before publication')
      return { _tag: 'Unavailable', nextPollNotBeforeMs: 0 }
    }
  }
  const nextDelay = (poll: BrokerObservationPoll, startedAt: number, completedAt: number) =>
    Math.max(
      poll._tag === 'Invalidated'
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
        if (current?.sourceRevision !== config.sourceRevision)
          await ctx.run(
            'activate broker observation projection',
            () => runtime.activate(ctx.request().attemptCompletedSignal),
            { maxRetryAttempts: 0 },
          )
        const startedAt = await ctx.date.now()
        const poll = await sample(ctx)
        const sameRevision = current?.sourceRevision === config.sourceRevision
        const state: State = {
          sourceRevision: config.sourceRevision,
          epoch: sameRevision ? current.epoch : (current?.epoch ?? 0) + 1,
          sequence: sameRevision ? current.sequence : 1,
          ...(poll._tag === 'Published' ? { lastSnapshotHash: poll.snapshotHash } : {}),
        }
        ctx.set(key, state)
        schedule(ctx, state, nextDelay(poll, startedAt, await ctx.date.now()))
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
        const startedAt = await ctx.date.now()
        const poll = await sample(ctx)
        const next: State = {
          sourceRevision: current.sourceRevision,
          epoch: current.epoch,
          sequence: current.sequence + 1,
          ...(poll._tag === 'Published' ? { lastSnapshotHash: poll.snapshotHash } : {}),
        }
        ctx.set(key, next)
        schedule(ctx, next, nextDelay(poll, startedAt, await ctx.date.now()))
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
      enableLazyState: true,
      hooks: [...hooks],
      retryPolicy: { maxAttempts: 3, onMaxAttempts: 'pause', initialInterval: 1_000, maxInterval: 10_000 },
      inactivityTimeout: { milliseconds: config.operationTimeoutMs * 2 },
      abortTimeout: { milliseconds: config.operationTimeoutMs * 3 },
    },
  })
}
