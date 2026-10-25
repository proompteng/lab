import { createHmac, timingSafeEqual } from 'node:crypto'
import * as restate from '@restatedev/restate-sdk'
import { Effect, Redacted, Result, Schedule, Schema } from 'effect'

import { PublicInformationSource, PublicInformationRunSchema, type PublicInformationRun } from '../public-information'
import { GitSourceRevisionSchema, Sha256Schema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import {
  callRestateInvocation,
  RestateInvocationClientError,
  restateInvocationAcceptTimeoutMs,
  sendRestateInvocation,
  type RestateHttpRequest,
} from './restate-invocation-client'

export const submitPublicInformationActivation = (
  config: {
    readonly sourceRevision: string
    readonly approvalKey: Redacted.Redacted<string>
    readonly ingressOrigin: string
  },
  source: PublicInformationSource,
  request: RestateHttpRequest = fetch,
) =>
  Effect.gen(function* () {
    const registered = yield* callRestateInvocation(
      `${config.ingressOrigin}/BaynPublicInformationControl/revision`,
      null,
      { timeoutMs: restateInvocationAcceptTimeoutMs },
      request,
    )
    const decoded = Schema.decodeUnknownResult(GitSourceRevisionSchema)(registered)
    if (Result.isFailure(decoded) || decoded.success !== config.sourceRevision)
      return yield* new RestateInvocationClientError({
        operation: 'call',
        message: 'Public information worker revision is not registered yet',
      })
    return yield* sendRestateInvocation(
      `${config.ingressOrigin}/BaynPublicInformationControl/activate/send`,
      {
        source,
        sourceRevision: config.sourceRevision,
        approval: approvePublicInformation(source, config.sourceRevision, config.approvalKey),
      },
      { timeoutMs: 5_000, headers: { 'Idempotency-Key': `public-information:${source}:${config.sourceRevision}` } },
      request,
    )
  }).pipe(
    Effect.withSpan('bayn.public-information.activation', {
      attributes: { 'bayn.public.source': source, 'bayn.source.revision': config.sourceRevision },
    }),
  )

export const submitPublicInformationJobs = (
  submit: (source: PublicInformationSource) => Effect.Effect<unknown, RestateInvocationClientError>,
) =>
  Effect.forEach(
    Object.values(PublicInformationSource),
    (source) =>
      submit(source).pipe(
        Effect.retry({ schedule: Schedule.spaced('10 seconds'), times: 60 }),
        Effect.andThen(Effect.logInfo('Public information activation submitted')),
        Effect.catchCause(() =>
          Effect.logWarning('Public information activation failed; other jobs remain independent'),
        ),
        Effect.annotateLogs({ source }),
      ),
    { concurrency: 2, discard: true },
  )

const jsonSerde = restate.serde.json.schema<unknown>({})
const Binding = Schema.Struct({ source: Schema.Enum(PublicInformationSource), sourceRevision: GitSourceRevisionSchema })
const Activation = Schema.Struct({ ...Binding.fields, approval: Sha256Schema })
const Tick = Schema.Struct({ ...Binding.fields, epoch: Schema.Int, sequence: Schema.Int })
const StateSchema = Schema.Struct({
  sourceRevision: GitSourceRevisionSchema,
  epoch: Schema.Int,
  sequence: Schema.Int,
  lastRun: Schema.NullOr(PublicInformationRunSchema),
  lastFailureAt: Schema.NullOr(Schema.String),
})
type State = typeof StateSchema.Type
const decode = <A>(schema: Schema.Codec<A>, value: unknown): A => {
  const result = Schema.decodeUnknownResult(schema, strictParseOptions)(value)
  if (Result.isFailure(result)) throw new restate.TerminalError('Public information command is malformed')
  return result.success
}
export const approvePublicInformation = (
  source: PublicInformationSource,
  sourceRevision: string,
  key: Redacted.Redacted<string>,
) =>
  createHmac('sha256', Buffer.from(Redacted.value(key), 'hex'))
    .update(`bayn.public-information-activation.v1:${source}:${sourceRevision}`)
    .digest('hex')

export interface PublicInformationRuntime {
  readonly collect: (
    source: PublicInformationSource,
    previous: PublicInformationRun | null,
    signal: AbortSignal,
  ) => Promise<PublicInformationRun>
}
export const makePublicInformationServices = (
  config: {
    readonly sourceRevision: string
    readonly approvalKey: Redacted.Redacted<string>
    readonly intervalMs: (source: PublicInformationSource) => number
  },
  runtime: PublicInformationRuntime,
  hooks: readonly restate.HooksProvider[] = [],
) => {
  const schedule = (ctx: restate.ObjectContext, source: PublicInformationSource, state: State, delayMs: number) =>
    ctx.genericSend({
      service: 'BaynPublicInformation',
      method: 'poll',
      key: source,
      parameter: { source, sourceRevision: state.sourceRevision, epoch: state.epoch, sequence: state.sequence },
      inputSerde: jsonSerde,
      delay: { milliseconds: delayMs },
      idempotencyKey: `public-information:${source}:${state.sourceRevision}:${state.epoch}:${state.sequence}`,
    })
  const owner = restate.object({
    name: 'BaynPublicInformation',
    options: {
      ingressPrivate: true,
      enableLazyState: false,
      hooks: [...hooks],
      inactivityTimeout: 12 * 60_000,
      abortTimeout: 15 * 60_000,
    },
    handlers: {
      activate: restate.handlers.object.exclusive(async (ctx: restate.ObjectContext, input: unknown) => {
        const binding = decode(Binding, input)
        if (ctx.key !== binding.source || binding.sourceRevision !== config.sourceRevision)
          throw new restate.TerminalError('Public information source binding differs')
        const old = await ctx.get<unknown>('state')
        const current = old === null ? null : decode(StateSchema, old)
        if (current?.sourceRevision === config.sourceRevision) return current
        const next: State = {
          sourceRevision: config.sourceRevision,
          epoch: (current?.epoch ?? 0) + 1,
          sequence: 1,
          lastRun: current?.lastRun ?? null,
          lastFailureAt: null,
        }
        ctx.set('state', next)
        schedule(ctx, binding.source, next, 0)
        return next
      }),
      poll: restate.handlers.object.exclusive(async (ctx: restate.ObjectContext, input: unknown) => {
        const tick = decode(Tick, input)
        if (ctx.key !== tick.source) throw new restate.TerminalError('Public information source key differs')
        const raw = await ctx.get<unknown>('state')
        if (raw === null) return
        const current = decode(StateSchema, raw)
        if (
          tick.sourceRevision !== config.sourceRevision ||
          current.sourceRevision !== config.sourceRevision ||
          current.epoch !== tick.epoch ||
          current.sequence !== tick.sequence
        )
          return
        let lastRun = current.lastRun
        let failed = true
        try {
          const collected = decode(
            PublicInformationRunSchema,
            await ctx.run(
              'collect public information',
              () => runtime.collect(tick.source, current.lastRun, ctx.request().attemptCompletedSignal),
              { maxRetryAttempts: 0 },
            ),
          )
          if (collected.source !== tick.source || collected.sourceRevision !== config.sourceRevision)
            throw new Error('Public information runtime binding differs')
          lastRun = collected
          failed = collected.failures.length > 0
        } catch {
          ctx.console.warn('Public information collection failed; the independent job will retry')
        }
        const next: State = {
          ...current,
          sequence: current.sequence + 1,
          lastRun,
          lastFailureAt: failed ? utcInstantFromEpochMillis(await ctx.date.now()) : null,
        }
        ctx.set('state', next)
        schedule(ctx, tick.source, next, config.intervalMs(tick.source))
      }),
      status: restate.handlers.object.shared(async (ctx: restate.ObjectSharedContext) => {
        decode(Schema.Enum(PublicInformationSource), ctx.key)
        const state = await ctx.get<unknown>('state')
        return state === null ? null : decode(StateSchema, state)
      }),
    },
  })
  const control = restate.service({
    name: 'BaynPublicInformationControl',
    options: { hooks: [...hooks] },
    handlers: {
      revision: async () => config.sourceRevision,
      activate: async (ctx: restate.Context, input: unknown) => {
        const activation = decode(Activation, input)
        const expected = approvePublicInformation(activation.source, activation.sourceRevision, config.approvalKey)
        if (
          activation.sourceRevision !== config.sourceRevision ||
          !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(activation.approval, 'hex'))
        )
          throw new restate.TerminalError('Public information activation lacks approval for this revision')
        return ctx.genericCall({
          service: 'BaynPublicInformation',
          method: 'activate',
          key: activation.source,
          parameter: { source: activation.source, sourceRevision: activation.sourceRevision },
          inputSerde: jsonSerde,
          outputSerde: jsonSerde,
        })
      },
      status: async (ctx: restate.Context, input: unknown) => {
        const source = decode(Schema.Enum(PublicInformationSource), input)
        return ctx.genericCall({
          service: 'BaynPublicInformation',
          method: 'status',
          key: source,
          parameter: undefined,
          inputSerde: jsonSerde,
          outputSerde: jsonSerde,
        })
      },
    },
  })
  return [owner, control] as const
}
