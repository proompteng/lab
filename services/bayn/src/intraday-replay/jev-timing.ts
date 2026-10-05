import { Cause, Clock, Effect, Exit, Redacted, Ref, Result, Semaphore } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevClient, JevError, type JevInference } from '../jev/client'
import { JevFailure, prepareJevRequest, type JevRequest } from '../jev/contract'
import { utcInstantFromEpochMillis } from '../time'
import { ReplayBrokerFailure } from './broker'

export type ReplayJevCall = {
  readonly schemaVersion: 'bayn.replay-jev-call.v1'
  readonly request: JevRequest
  readonly requestHash: string
  readonly simulatedStartedAt: string
  readonly providerStartedAt: string
  readonly providerCompletedAt: string
  readonly outcome:
    | { readonly status: 'RECEIVED'; readonly inference: JevInference }
    | {
        readonly status: 'FAILED'
        readonly failure: JevFailure
        readonly httpStatus: number | null
        readonly responseHash: string | null
        readonly rejectedResponse: unknown
      }
    | { readonly status: 'INTERRUPTED' | 'DEFECT' }
}

const recordedOutcome = (exit: Exit.Exit<JevInference, JevError>): ReplayJevCall['outcome'] => {
  if (Exit.isSuccess(exit)) return { status: 'RECEIVED', inference: exit.value }
  const error = Cause.findError(exit.cause)
  if (Result.isFailure(error)) return { status: Cause.hasInterruptsOnly(exit.cause) ? 'INTERRUPTED' : 'DEFECT' }
  return {
    status: 'FAILED',
    failure: error.success.failure,
    httpStatus: error.success.status ?? null,
    responseHash: error.success.responseHash ?? null,
    rejectedResponse:
      error.success.rejectedResponse === undefined ? null : Redacted.value(error.success.rejectedResponse),
  }
}

export const makeReplayJevTiming = (input: {
  readonly provider: JevClient['Service']
  readonly providerClock: Clock.Clock
  readonly advanceTo: (atMs: number) => Effect.Effect<void, ReplayBrokerFailure>
  readonly advanceDeadlineTo: (atMs: number) => Effect.Effect<void, ReplayBrokerFailure>
  readonly excludedSourceMillis: Effect.Effect<number>
  readonly retain: (call: ReplayJevCall) => Effect.Effect<void, ReplayBrokerFailure>
  readonly measureDatabaseTime: <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ReplayBrokerFailure, R>
}) =>
  Effect.gen(function* () {
    const marketClock = yield* Clock.clockWith(Effect.succeed)
    if (marketClock === input.providerClock)
      return yield* new ReplayBrokerFailure({ message: 'Jev replay requires independent provider and market clocks' })
    const permit = yield* Semaphore.make(1)
    const passPermit = yield* Semaphore.make(1)
    let measurement:
      | { readonly providerAt: number; readonly marketAt: number; readonly excludedSourceMillis: number }
      | undefined
    let activeCalls = 0
    const failure = yield* Ref.make<ReplayBrokerFailure | undefined>(undefined)

    const elapsed = Effect.gen(function* () {
      const providerAt = yield* input.providerClock.currentTimeMillis
      const excludedSourceMillis = yield* input.excludedSourceMillis
      if (
        measurement === undefined ||
        providerAt < measurement.providerAt ||
        !Number.isSafeInteger(excludedSourceMillis) ||
        excludedSourceMillis < measurement.excludedSourceMillis ||
        excludedSourceMillis - measurement.excludedSourceMillis > providerAt - measurement.providerAt
      )
        return yield* new ReplayBrokerFailure({ message: 'Jev replay clock is unbound or moved backwards' })
      return {
        providerAt,
        excludedSourceMillis,
        marketAt: measurement.marketAt,
        elapsedMs: providerAt - measurement.providerAt - (excludedSourceMillis - measurement.excludedSourceMillis),
      }
    })
    const synchronizeUnlocked = (advance: typeof input.advanceTo) =>
      Effect.gen(function* () {
        const current = yield* elapsed
        const atMs = Math.max(yield* marketClock.currentTimeMillis, current.marketAt) + current.elapsedMs
        yield* advance(atMs)
        measurement = {
          providerAt: current.providerAt,
          excludedSourceMillis: current.excludedSourceMillis,
          marketAt: atMs,
        }
        return measurement
      })
    const synchronize = Effect.uninterruptible(permit.withPermit(synchronizeUnlocked(input.advanceDeadlineTo)))

    const client: JevClient['Service'] = {
      evaluate: (raw) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            activeCalls++
          }),
          () =>
            Effect.gen(function* () {
              const prepared = yield* Effect.fromResult(prepareJevRequest(raw)).pipe(
                Effect.mapError((cause) => new ReplayBrokerFailure({ message: 'Invalid replay Jev request', cause })),
              )
              const started = yield* synchronize
              const providerStartedAt = yield* input.providerClock.currentTimeMillis
              if (providerStartedAt < started.providerAt)
                return yield* new ReplayBrokerFailure({ message: 'Jev provider clock moved backwards before dispatch' })
              const simulatedStartedAt = started.marketAt + providerStartedAt - started.providerAt
              const received = yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const exit = yield* restore(
                    input.provider
                      .evaluate(prepared.request)
                      .pipe(Effect.provideService(Clock.Clock, input.providerClock)),
                  ).pipe(Effect.exit)
                  const providerCompletedAt = yield* input.providerClock.currentTimeMillis
                  const call: ReplayJevCall = {
                    schemaVersion: 'bayn.replay-jev-call.v1',
                    request: prepared.request,
                    requestHash: prepared.requestHash,
                    simulatedStartedAt: utcInstantFromEpochMillis(simulatedStartedAt),
                    providerStartedAt: utcInstantFromEpochMillis(providerStartedAt),
                    providerCompletedAt: utcInstantFromEpochMillis(providerCompletedAt),
                    outcome: recordedOutcome(exit),
                  }
                  // Retain paid responses before advancing deadlines can interrupt their native evaluation.
                  yield* input.retain(call)
                  return { exit, providerCompletedAt }
                }),
              )
              const completed = yield* synchronize
              const inference = yield* received.exit
              const responseHash = yield* Effect.fromResult(canonicalHashV1Result(inference.response)).pipe(
                Effect.mapError((cause) => new ReplayBrokerFailure({ message: 'Invalid replay Jev response', cause })),
              )
              if (
                inference.requestHash !== prepared.requestHash ||
                inference.responseHash !== responseHash ||
                Date.parse(inference.startedAt) < providerStartedAt ||
                Date.parse(inference.completedAt) < Date.parse(inference.startedAt) ||
                Date.parse(inference.completedAt) > received.providerCompletedAt
              )
                return yield* new ReplayBrokerFailure({
                  message: 'Jev provider evidence differs from the measured call',
                })
              return {
                ...inference,
                startedAt: utcInstantFromEpochMillis(simulatedStartedAt),
                completedAt: utcInstantFromEpochMillis(completed.marketAt),
              }
            }),
          () =>
            Effect.sync(() => {
              activeCalls--
            }),
        ).pipe(
          Effect.catchTag('ReplayBrokerFailure', (cause) =>
            Ref.set(failure, cause).pipe(
              Effect.andThen(
                Effect.fail(
                  new JevError({ failure: JevFailure.Request, message: cause.message, cause: Redacted.make(cause) }),
                ),
              ),
            ),
          ),
        ),
    }

    const run = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      passPermit.withPermit(
        input
          .measureDatabaseTime(
            Effect.gen(function* () {
              yield* Ref.set(failure, undefined)
              measurement = {
                providerAt: yield* input.providerClock.currentTimeMillis,
                marketAt: yield* marketClock.currentTimeMillis,
                excludedSourceMillis: yield* input.excludedSourceMillis,
              }
              const result = yield* Effect.result(operation)
              yield* synchronize
              const failed = yield* Ref.get(failure)
              if (failed !== undefined) return yield* failed
              return yield* Effect.fromResult(result)
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  measurement = undefined
                }),
              ),
            ),
          )
          .pipe(Effect.onExit(() => marketClock.currentTimeMillis.pipe(Effect.flatMap(input.advanceTo)))),
      )
    return {
      client,
      run,
      currentUtcInstant: Effect.uninterruptible(
        permit.withPermit(
          Effect.gen(function* () {
            if (activeCalls !== 0)
              return yield* new ReplayBrokerFailure({
                message: 'Cannot publish replay source while inference is active',
              })
            const synchronized = yield* synchronizeUnlocked(input.advanceTo)
            const current = yield* elapsed
            measurement = {
              providerAt: current.providerAt,
              excludedSourceMillis: current.excludedSourceMillis,
              marketAt: synchronized.marketAt + current.elapsedMs,
            }
            yield* input.advanceTo(measurement.marketAt)
            return utcInstantFromEpochMillis(measurement.marketAt)
          }),
        ),
      ),
    }
  })
