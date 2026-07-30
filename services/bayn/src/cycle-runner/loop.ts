import { Duration, Effect, pipe, Result, Schedule } from 'effect'

import type { BrokerRead } from '../broker/alpaca'
import type { CycleStore } from '../db/cycle-store'
import type { MarketData } from '../market-data'
import { currentUtcInstant } from '../time'
import { cyclePassLogFacts, validateCycleLoopInterval } from './decisions'
import {
  runnerError,
  type AutonomousCycleLoopOptions,
  type CycleNotDueReconciliationError,
  type CyclePassObservation,
  type CycleRunnerError,
  type CycleRunResult,
} from './model'
import { runAutonomousCycleUntilSettled } from './program'

const logCyclePass = (observation: CyclePassObservation): Effect.Effect<void> => {
  const facts = cyclePassLogFacts(observation)
  const log = facts.level === 'INFO' ? Effect.logInfo(facts.message) : Effect.logError(facts.message)
  return log.pipe(Effect.annotateLogs(facts.annotations))
}

const reconcileNotDuePass = <DecisionR>(
  reconcileNotDue: Effect.Effect<void, CycleNotDueReconciliationError, DecisionR>,
  result: CycleRunResult,
): Effect.Effect<CycleRunResult, CycleRunnerError, DecisionR> => {
  if (result.outcome !== 'NOT_DUE') return Effect.succeed(result)
  return reconcileNotDue.pipe(
    Effect.mapError((cause) => runnerError('reconcile-not-due', cause.failure, cause.message, cause)),
    Effect.map((): CycleRunResult => result),
  )
}

const runLoopPass = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData | ContextR | DecisionR> =>
  options.context.pipe(
    Effect.mapError((cause) =>
      runnerError('load-context', 'context', 'autonomous cycle context loading failed', cause),
    ),
    Effect.flatMap(runAutonomousCycleUntilSettled),
    Effect.flatMap((result) => reconcileNotDuePass(options.reconcileNotDue, result)),
    Effect.withLogSpan('autonomous-cycle'),
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

const cycleLoopProgram = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
): Effect.Effect<void, never, BrokerRead | CycleStore | MarketData | ContextR | DecisionR> =>
  pipe(
    runLoopPass(options),
    Effect.flatMap((result) => observeSuccessfulPass(options, result)),
    Effect.catch((error) => observeFailedPass(options, error)),
    Effect.repeat(Schedule.spaced(Duration.millis(options.pollIntervalMs))),
    Effect.asVoid,
  )

export const makeAutonomousCycleLoop = <E, ContextR, DecisionR>(
  options: AutonomousCycleLoopOptions<E, ContextR, DecisionR>,
): Result.Result<
  Effect.Effect<void, never, BrokerRead | CycleStore | MarketData | ContextR | DecisionR>,
  CycleRunnerError
> =>
  pipe(
    validateCycleLoopInterval(options.pollIntervalMs),
    Result.map(() => cycleLoopProgram(options)),
  )
