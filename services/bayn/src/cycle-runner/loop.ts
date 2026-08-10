import { Clock, Duration, Effect, pipe, Ref, Result } from 'effect'

import type { BrokerRead } from '../broker/alpaca'
import type { CycleStore } from '../db/cycle-store'
import type { MarketData } from '../market-data'
import { currentUtcInstant } from '../time'
import {
  cyclePassLogFacts,
  decideIdleReconciliationCadence,
  shouldDeferCyclePollForReconciliation,
  validateCyclePassTimeout,
  validateCycleLoopInterval,
  validateReconciliationInterval,
} from './decisions'
import {
  runnerError,
  type AutonomousCycleLoopOptions,
  type CycleNotDueReconciliationError,
  type CyclePassObservation,
  type CycleRunContext,
  type CycleRunnerError,
  type CycleRunResult,
  type ReconciliationCadenceState,
} from './model'
import { runAutonomousCycleUntilSettled } from './program'

const logCyclePass = (observation: CyclePassObservation): Effect.Effect<void> => {
  const facts = cyclePassLogFacts(observation)
  const log = facts.level === 'INFO' ? Effect.logInfo(facts.message) : Effect.logError(facts.message)
  return log.pipe(Effect.annotateLogs(facts.annotations))
}

const nanosPerMillisecond = 1_000_000n

const intervalNanos = (intervalMs: number): bigint => BigInt(intervalMs) * nanosPerMillisecond

const sleepUntil = (deadlineNanos: bigint): Effect.Effect<void> =>
  Clock.currentTimeNanos.pipe(
    Effect.flatMap((nowNanos) => {
      const remainingNanos = deadlineNanos - nowNanos
      if (remainingNanos <= 0n) return Effect.void
      const remainingMs = Number((remainingNanos + nanosPerMillisecond - 1n) / nanosPerMillisecond)
      return Effect.sleep(Duration.millis(remainingMs))
    }),
  )

const idleReconciliationError = (cause: CycleNotDueReconciliationError): CycleRunnerError =>
  runnerError({ operation: 'reconcile-not-due', failure: cause.failure, message: cause.message, cause })

const markReconciliationCompleted = (cadence: Ref.Ref<ReconciliationCadenceState>): Effect.Effect<void> =>
  Clock.currentTimeNanos.pipe(Effect.flatMap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos })))

const attemptIdleReconciliation = <DecisionR>(
  reconcileNotDue: Effect.Effect<void, CycleNotDueReconciliationError, DecisionR>,
  cadence: Ref.Ref<ReconciliationCadenceState>,
): Effect.Effect<void, CycleRunnerError, DecisionR> =>
  Clock.currentTimeNanos.pipe(
    Effect.tap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos })),
    Effect.andThen(
      reconcileNotDue.pipe(
        Effect.mapError(idleReconciliationError),
        Effect.tapError((lastFailure) =>
          Clock.currentTimeNanos.pipe(
            Effect.flatMap((lastAttemptAtNanos) => Ref.set(cadence, { lastAttemptAtNanos, lastFailure })),
          ),
        ),
        Effect.tap(() => markReconciliationCompleted(cadence)),
      ),
    ),
  )

const reconcileNotDuePass = <DecisionR>(
  reconcileNotDue: Effect.Effect<void, CycleNotDueReconciliationError, DecisionR>,
  cadence: Ref.Ref<ReconciliationCadenceState>,
  reconciliationIntervalMs: number,
  result: CycleRunResult,
): Effect.Effect<CycleRunResult, CycleRunnerError, DecisionR> => {
  if (result.outcome !== 'NOT_DUE') return Effect.succeed(result)
  return Effect.gen(function* () {
    const nowNanos = yield* Clock.currentTimeNanos
    const state = yield* Ref.get(cadence)
    const decision = decideIdleReconciliationCadence(state, nowNanos, reconciliationIntervalMs)
    if (decision._tag === 'WAIT') {
      if (state.lastFailure !== undefined) return yield* state.lastFailure
      return result
    }
    yield* attemptIdleReconciliation(reconcileNotDue, cadence)
    return result
  })
}

const trackDecisionReconciliation = <DecisionR>(
  cadence: Ref.Ref<ReconciliationCadenceState>,
  context: CycleRunContext<DecisionR>,
): CycleRunContext<DecisionR> => ({
  ...context,
  buildDecision: (cycle) => context.buildDecision(cycle, markReconciliationCompleted(cadence)),
})

const runLoopPass = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
  cadence: Ref.Ref<ReconciliationCadenceState>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData | ContextR | DecisionR> =>
  options.context.pipe(
    Effect.mapError((cause) =>
      runnerError({
        operation: 'load-context',
        failure: 'context',
        message: 'autonomous cycle context loading failed',
        cause,
      }),
    ),
    Effect.map((context) => trackDecisionReconciliation(cadence, context)),
    Effect.flatMap(runAutonomousCycleUntilSettled),
    Effect.withLogSpan('autonomous-cycle'),
  )

const cyclePassTimeoutError = (timeoutMs: number): CycleRunnerError =>
  runnerError({
    operation: 'run-cycle-pass',
    failure: 'operational',
    message: `autonomous cycle pass did not complete or reconcile within ${timeoutMs.toString()}ms`,
  })

const runBoundedLoopPass = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
  cadence: Ref.Ref<ReconciliationCadenceState>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData | ContextR | DecisionR> =>
  runLoopPass(options, cadence).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(options.cyclePassTimeoutMs),
      orElse: () => Effect.fail(cyclePassTimeoutError(options.cyclePassTimeoutMs)),
    }),
  )

const observeSuccessfulPass = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
  result: CycleRunResult,
): Effect.Effect<void> =>
  pipe(
    currentUtcInstant,
    Effect.flatMap((observedAt) => {
      const observation: CyclePassObservation = { outcome: 'SUCCEEDED', observedAt, result }
      return pipe(options.observePass(observation), Effect.andThen(logCyclePass(observation)))
    }),
  )

const observeFailedPass = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
  error: CycleRunnerError,
): Effect.Effect<void> =>
  pipe(
    currentUtcInstant,
    Effect.flatMap((observedAt) => {
      const observation: CyclePassObservation = { outcome: 'FAILED', observedAt, error }
      return pipe(options.observePass(observation), Effect.andThen(logCyclePass(observation)))
    }),
  )

const observeIdleReconciliation = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
  cadence: Ref.Ref<ReconciliationCadenceState>,
  result: Extract<CycleRunResult, { readonly outcome: 'NOT_DUE' }>,
): Effect.Effect<void, never, DecisionR> =>
  reconcileNotDuePass(options.reconcileNotDue, cadence, options.reconciliationIntervalMs, result).pipe(
    Effect.flatMap((reconciled) => observeSuccessfulPass(options, reconciled)),
    Effect.catch((error) => observeFailedPass(options, error)),
  )

const observeCadenceReconciliation = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
  cadence: Ref.Ref<ReconciliationCadenceState>,
  result: CycleRunResult | undefined,
): Effect.Effect<void, never, DecisionR> =>
  Ref.get(cadence).pipe(
    Effect.flatMap((state) =>
      attemptIdleReconciliation(options.reconcileNotDue, cadence).pipe(
        Effect.flatMap(() =>
          result !== undefined && (result.outcome === 'NOT_DUE' || state.lastFailure !== undefined)
            ? observeSuccessfulPass(options, result)
            : Effect.void,
        ),
      ),
    ),
    Effect.catch((error) => observeFailedPass(options, error)),
  )

const observeCycleResult = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
  cadence: Ref.Ref<ReconciliationCadenceState>,
  result: CycleRunResult,
): Effect.Effect<void, never, DecisionR> =>
  result.outcome === 'NOT_DUE'
    ? observeIdleReconciliation(options, cadence, result)
    : Ref.get(cadence).pipe(
        Effect.flatMap((state) =>
          state.lastFailure === undefined
            ? observeSuccessfulPass(options, result)
            : observeFailedPass(options, state.lastFailure),
        ),
      )

const waitUntilNextCyclePoll = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
  cadence: Ref.Ref<ReconciliationCadenceState>,
  result: CycleRunResult | undefined,
  nextPollAtNanos: bigint,
): Effect.Effect<void, never, DecisionR> =>
  Effect.suspend(() =>
    Effect.gen(function* () {
      const nowNanos = yield* Clock.currentTimeNanos
      const state = yield* Ref.get(cadence)
      const decision = decideIdleReconciliationCadence(state, nowNanos, options.reconciliationIntervalMs)
      if (decision._tag === 'RECONCILE') {
        yield* observeCadenceReconciliation(options, cadence, result)
        return yield* waitUntilNextCyclePoll(options, cadence, result, nextPollAtNanos)
      }
      const reconciliationAtNanos = nowNanos + decision.remainingNanos
      const pollStartAtNanos = nowNanos > nextPollAtNanos ? nowNanos : nextPollAtNanos
      if (
        shouldDeferCyclePollForReconciliation({
          lastAttemptAtNanos: state.lastAttemptAtNanos,
          nextPollAtNanos,
          pollStartAtNanos,
          reconciliationAtNanos,
          cyclePassTimeoutNanos: intervalNanos(options.cyclePassTimeoutMs),
        })
      ) {
        yield* sleepUntil(reconciliationAtNanos)
        return yield* waitUntilNextCyclePoll(options, cadence, result, nextPollAtNanos)
      }
      if (nowNanos >= nextPollAtNanos) return
      if (nextPollAtNanos < reconciliationAtNanos) return yield* sleepUntil(nextPollAtNanos)
      yield* sleepUntil(reconciliationAtNanos)
      return yield* waitUntilNextCyclePoll(options, cadence, result, nextPollAtNanos)
    }),
  )

const waitAfterSuccessfulPass = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
  cadence: Ref.Ref<ReconciliationCadenceState>,
  result: CycleRunResult,
): Effect.Effect<void, never, DecisionR> =>
  Clock.currentTimeNanos.pipe(
    Effect.flatMap((completedAtNanos) => {
      const nextPollAtNanos = completedAtNanos + intervalNanos(options.pollIntervalMs)
      return waitUntilNextCyclePoll(options, cadence, result, nextPollAtNanos)
    }),
  )

const waitAfterFailedPass = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
  cadence: Ref.Ref<ReconciliationCadenceState>,
): Effect.Effect<void, never, DecisionR> =>
  Clock.currentTimeNanos.pipe(
    Effect.flatMap((completedAtNanos) =>
      waitUntilNextCyclePoll(options, cadence, undefined, completedAtNanos + intervalNanos(options.pollIntervalMs)),
    ),
  )

const cycleLoopProgram = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
): Effect.Effect<void, never, BrokerRead | CycleStore | MarketData | ContextR | DecisionR> =>
  Effect.gen(function* () {
    const cadence = yield* Ref.make<ReconciliationCadenceState>({})
    const run = (): Effect.Effect<void, never, BrokerRead | CycleStore | MarketData | ContextR | DecisionR> =>
      Effect.suspend(() =>
        runBoundedLoopPass(options, cadence).pipe(
          Effect.matchEffect({
            onFailure: (error) =>
              observeFailedPass(options, error).pipe(
                Effect.andThen(waitAfterFailedPass(options, cadence)),
                Effect.andThen(run()),
              ),
            onSuccess: (result) =>
              observeCycleResult(options, cadence, result).pipe(
                Effect.andThen(waitAfterSuccessfulPass(options, cadence, result)),
                Effect.andThen(run()),
              ),
          }),
        ),
      )
    yield* run()
  })

export const makeAutonomousCycleLoop = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
): Result.Result<
  Effect.Effect<void, never, BrokerRead | CycleStore | MarketData | ContextR | DecisionR>,
  CycleRunnerError
> =>
  pipe(
    validateCycleLoopInterval(options.pollIntervalMs),
    Result.flatMap(() => validateReconciliationInterval(options.reconciliationIntervalMs)),
    Result.flatMap(() => validateCyclePassTimeout(options.cyclePassTimeoutMs, options.reconciliationIntervalMs)),
    Result.map(() => cycleLoopProgram(options)),
  )
