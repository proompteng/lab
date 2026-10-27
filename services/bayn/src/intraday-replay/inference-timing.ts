import { Cause, Clock, Effect, Exit, Redacted, Ref, Result, Schema, Semaphore } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevClient, JevError, type JevInference } from '../jev/client'
import {
  JevFailure,
  JevRequestSchema,
  JevInferenceSchema,
  prepareJevRequest,
  type JevRequest,
  type JevContractError,
} from '../jev/contract'
import {
  DecisionsClient,
  DecisionsError,
  DecisionsInferenceSchema,
  DecisionsRequestSchema,
  DecisionsUsageSchema,
  prepareDecisionsRequest,
  type DecisionsInference,
  type DecisionsRequest,
} from '../jev/decisions'
import { PositiveIntegerSchema, Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import { ReplayBrokerFailure } from './broker'

export interface ReplayInferenceProviders {
  readonly jev: JevClient['Service']
  readonly chart: DecisionsClient['Service']
}

export const makeReplayInferenceBudget = (maximumCalls: number) => {
  let dispatchCount = 0
  return {
    dispatchCount: () => dispatchCount,
    claim: Effect.suspend(() => {
      if (!Number.isSafeInteger(maximumCalls) || maximumCalls <= 0 || dispatchCount >= maximumCalls)
        return Effect.fail(new ReplayBrokerFailure({ message: 'Frozen replay provider-call budget exhausted' }))
      dispatchCount++
      return Effect.void
    }),
  }
}
export type ReplayInferenceBudget = ReturnType<typeof makeReplayInferenceBudget>

const callFields = {
  requestHash: Sha256Schema,
  budgetMs: PositiveIntegerSchema.check(Schema.isLessThanOrEqualTo(10_000)),
  simulatedStartedAt: UtcInstantSchema,
  providerStartedAt: UtcInstantSchema,
  providerCompletedAt: UtcInstantSchema,
}
const terminalOutcome = Schema.Struct({ status: Schema.Literals(['INTERRUPTED', 'DEFECT']) })
const visualCallFields = {
  ...callFields,
  request: DecisionsRequestSchema,
  outcome: Schema.Union([
    Schema.Struct({ status: Schema.Literal('RECEIVED'), inference: DecisionsInferenceSchema }),
    Schema.Struct({
      status: Schema.Literal('FAILED'),
      category: Schema.Literals(['REQUEST', 'TRANSPORT', 'STATUS', 'RESPONSE', 'DEADLINE']),
      httpStatus: Schema.NullOr(Schema.Int),
      responseHash: Schema.NullOr(Sha256Schema),
      usage: Schema.NullOr(DecisionsUsageSchema),
    }),
    terminalOutcome,
  ]),
}
export const ReplayInferenceCallSchema = Schema.Union([
  Schema.Struct({
    ...callFields,
    schemaVersion: Schema.Literal('bayn.replay-inference-call.v2'),
    stage: Schema.Literal('JEV'),
    request: JevRequestSchema,
    outcome: Schema.Union([
      Schema.Struct({ status: Schema.Literal('RECEIVED'), inference: JevInferenceSchema }),
      Schema.Struct({
        status: Schema.Literal('FAILED'),
        failure: Schema.Enum(JevFailure),
        httpStatus: Schema.NullOr(Schema.Int),
        responseHash: Schema.NullOr(Sha256Schema),
        rejectedResponse: Schema.Unknown,
      }),
      terminalOutcome,
    ]),
  }),
  Schema.Struct({
    ...visualCallFields,
    schemaVersion: Schema.Literal('bayn.replay-inference-call.v2'),
    stage: Schema.Literal('CHART'),
  }),
  Schema.Struct({
    ...visualCallFields,
    schemaVersion: Schema.Literal('bayn.replay-inference-call.v3'),
    stage: Schema.Literal('BASE_START'),
  }),
])
export type ReplayInferenceCall = typeof ReplayInferenceCallSchema.Type
type JevCall = Extract<ReplayInferenceCall, { readonly stage: 'JEV' }>
type ChartCall = Exclude<ReplayInferenceCall, { readonly stage: 'JEV' }>
type MeasuredTimes = Pick<ReplayInferenceCall, keyof typeof callFields>

// This labels a measured call; the journal independently verifies the complete
// predecessor graph and exact provider request hash before dispatch admission.
const visualStage = (request: DecisionsRequest) =>
  request.questions.length === 1 && request.questions[0]?.name.startsWith('base_first_bar_ending_') === true
    ? ('BASE_START' as const)
    : ('CHART' as const)
const BaseStartSource = Schema.Struct({
  source: Schema.Unknown,
  predecessor: Schema.Struct({ requestHash: Sha256Schema, responseHash: Sha256Schema }),
  selectedEnd: Schema.NonEmptyString,
})
const prepareReplayVisualRequest = (raw: unknown) =>
  Result.gen(function* () {
    const prepared = yield* prepareDecisionsRequest(raw)
    const data = prepared.request.input[0].content[2].data
    const staged =
      typeof data === 'object' && data !== null && ('predecessor' in data || 'selectedEnd' in data || 'source' in data)
    if (visualStage(prepared.request) === 'BASE_START') {
      const decoded = Schema.decodeUnknownResult(BaseStartSource, strictParseOptions)(data)
      if (Result.isFailure(decoded) || prepared.request.questions[0]?.type !== 'choice')
        return yield* Result.fail(
          new DecisionsError({
            category: 'REQUEST',
            message: 'Base start replay requires its bound source and predecessor',
          }),
        )
    } else if (staged) {
      return yield* Result.fail(
        new DecisionsError({ category: 'REQUEST', message: 'Staged replay source does not match its question stage' }),
      )
    }
    return prepared
  })

const jevOutcome = (exit: Exit.Exit<JevInference, JevError>): JevCall['outcome'] => {
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
const chartOutcome = (
  exit: Exit.Exit<DecisionsInference, DecisionsError>,
  requestHash: string,
): ChartCall['outcome'] => {
  if (Exit.isSuccess(exit)) return { status: 'RECEIVED', inference: exit.value }
  const error = Cause.findError(exit.cause)
  if (Result.isFailure(error)) return { status: Cause.hasInterruptsOnly(exit.cause) ? 'INTERRUPTED' : 'DEFECT' }
  return {
    status: 'FAILED',
    category: error.success.category,
    httpStatus: error.success.status ?? null,
    responseHash: error.success.requestHash === requestHash ? (error.success.responseHash ?? null) : null,
    usage: error.success.requestHash === requestHash ? (error.success.usage ?? null) : null,
  }
}

export const makeReplayInferenceTiming = (input: {
  readonly providers: ReplayInferenceProviders
  readonly budget: ReplayInferenceBudget
  readonly providerClock: Clock.Clock
  readonly advanceTo: (atMs: number) => Effect.Effect<void, ReplayBrokerFailure>
  readonly advanceDeadlineTo: (atMs: number) => Effect.Effect<void, ReplayBrokerFailure>
  readonly excludedSourceMillis: Effect.Effect<number>
  readonly retain: (call: ReplayInferenceCall) => Effect.Effect<void, ReplayBrokerFailure>
  readonly measureDatabaseTime: <A, E, R>(
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ReplayBrokerFailure, R>
}) =>
  Effect.gen(function* () {
    const marketClock = yield* Clock.clockWith(Effect.succeed)
    if (marketClock === input.providerClock)
      return yield* new ReplayBrokerFailure({
        message: 'Inference replay requires independent provider and market clocks',
      })
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
        return yield* new ReplayBrokerFailure({ message: 'Inference replay clock is unbound or moved backwards' })
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

    const measure =
      <
        Request,
        Inference extends JevInference | DecisionsInference,
        Error extends JevError | DecisionsError,
        PreparationError extends { readonly message: string },
      >(
        prepare: (
          raw: unknown,
        ) => Result.Result<{ readonly request: Request; readonly requestHash: string }, PreparationError>,
        evaluate: (request: Request, budgetMs: number) => Effect.Effect<Inference, Error>,
        record: (request: Request, times: MeasuredTimes, exit: Exit.Exit<Inference, Error>) => ReplayInferenceCall,
        deadlineError: () => Error,
      ) =>
      (raw: unknown, budgetMs: number) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            activeCalls++
          }),
          () =>
            Effect.gen(function* () {
              const failed = yield* Ref.get(failure)
              if (failed !== undefined) return yield* failed
              if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0 || budgetMs > 10_000)
                return yield* new ReplayBrokerFailure({ message: 'Invalid remaining replay inference deadline' })
              const prepared = yield* Effect.fromResult(prepare(raw)).pipe(
                Effect.mapError(
                  (cause) => new ReplayBrokerFailure({ message: 'Invalid replay inference request', cause }),
                ),
              )
              const originalMarketAt = yield* marketClock.currentTimeMillis
              const started = yield* synchronize
              const providerStartedAt = yield* input.providerClock.currentTimeMillis
              if (providerStartedAt < started.providerAt)
                return yield* new ReplayBrokerFailure({ message: 'Provider clock moved backwards before dispatch' })
              const simulatedStartedAt = started.marketAt + providerStartedAt - started.providerAt
              const remainingMs = budgetMs - (simulatedStartedAt - originalMarketAt)
              // @effect-diagnostics-next-line unnecessaryFailYieldableError:off -- direct yielding widens the generic provider error to both providers
              if (remainingMs <= 0) return yield* Effect.fail(deadlineError())
              yield* input.budget.claim
              const received = yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const exit = yield* restore(
                    evaluate(prepared.request, remainingMs).pipe(
                      Effect.timeoutOrElse({ duration: remainingMs, orElse: () => Effect.fail(deadlineError()) }),
                      Effect.provideService(Clock.Clock, input.providerClock),
                    ),
                  ).pipe(Effect.exit)
                  const providerCompletedAt = yield* input.providerClock.currentTimeMillis
                  const call = record(
                    prepared.request,
                    {
                      requestHash: prepared.requestHash,
                      budgetMs: remainingMs,
                      simulatedStartedAt: utcInstantFromEpochMillis(simulatedStartedAt),
                      providerStartedAt: utcInstantFromEpochMillis(providerStartedAt),
                      providerCompletedAt: utcInstantFromEpochMillis(providerCompletedAt),
                    },
                    exit,
                  )
                  // Preserve paid evidence before advancing the native clock can interrupt its consumer.
                  yield* input.retain(call)
                  if (call.outcome.status === 'FAILED' && call.outcome.httpStatus === 402)
                    yield* Ref.set(
                      failure,
                      new ReplayBrokerFailure({
                        message: 'Inference replay stopped after HTTP 402 payment required',
                        cause: Exit.isFailure(exit) ? exit.cause : undefined,
                      }),
                    )
                  return { exit, providerCompletedAt }
                }),
              )
              const completed = yield* synchronize
              const inference = yield* received.exit
              const responseHash = yield* Effect.fromResult(canonicalHashV1Result(inference.response)).pipe(
                Effect.mapError(
                  (cause) => new ReplayBrokerFailure({ message: 'Invalid replay provider response', cause }),
                ),
              )
              if (
                inference.requestHash !== prepared.requestHash ||
                inference.responseHash !== responseHash ||
                Date.parse(inference.startedAt) < providerStartedAt ||
                Date.parse(inference.completedAt) < Date.parse(inference.startedAt) ||
                Date.parse(inference.completedAt) > received.providerCompletedAt
              )
                return yield* new ReplayBrokerFailure({ message: 'Provider evidence differs from the measured call' })
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
        )

    const clients: ReplayInferenceProviders = {
      jev: {
        evaluate: (raw, budgetMs) =>
          measure<JevRequest, JevInference, JevError, JevContractError>(
            prepareJevRequest,
            input.providers.jev.evaluate,
            (request, times, exit) => ({
              ...times,
              schemaVersion: 'bayn.replay-inference-call.v2',
              stage: 'JEV',
              request,
              outcome: jevOutcome(exit),
            }),
            () => new JevError({ failure: JevFailure.Timeout, message: 'Original replay inference deadline elapsed' }),
          )(raw, budgetMs).pipe(
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
      },
      chart: {
        evaluate: (raw, budgetMs) =>
          measure<DecisionsRequest, DecisionsInference, DecisionsError, DecisionsError>(
            prepareReplayVisualRequest,
            input.providers.chart.evaluate,
            (request, times, exit) => {
              const measured = { ...times, request, outcome: chartOutcome(exit, times.requestHash) }
              return visualStage(request) === 'BASE_START'
                ? { ...measured, schemaVersion: 'bayn.replay-inference-call.v3', stage: 'BASE_START' }
                : { ...measured, schemaVersion: 'bayn.replay-inference-call.v2', stage: 'CHART' }
            },
            () => new DecisionsError({ category: 'DEADLINE', message: 'Original replay inference deadline elapsed' }),
          )(raw, budgetMs).pipe(
            Effect.catchTag('ReplayBrokerFailure', (cause) =>
              Ref.set(failure, cause).pipe(
                Effect.andThen(
                  Effect.fail(
                    new DecisionsError({ category: 'REQUEST', message: cause.message, cause: Redacted.make(cause) }),
                  ),
                ),
              ),
            ),
          ),
      },
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
      clients,
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
