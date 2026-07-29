import { Duration, Effect, pipe, Result, Schedule } from 'effect'

import type { BrokerRead } from '../broker/alpaca'
import type { CycleStore } from '../db/cycle-store'
import type { MarketData } from '../market-data'
import { currentUtcInstant } from '../time'
import { cyclePassLogFacts, validateCycleLoopInterval } from './decisions'
import {
  runnerError,
  type AutonomousCycleLoopOptions,
  type CyclePassObservation,
  type CycleRunContext,
  type CycleRunnerError,
  type CycleRunResult,
} from './model'
import { runAutonomousCycleUntilSettled } from './program'

const logCyclePass = (observation: CyclePassObservation): Effect.Effect<void> => {
  const facts = cyclePassLogFacts(observation)
  const log = facts.level === 'INFO' ? Effect.logInfo(facts.message) : Effect.logError(facts.message)
  return log.pipe(Effect.annotateLogs(facts.annotations))
}

const runLoopPass = <E, ContextR, DecisionR>(
  context: Effect.Effect<CycleRunContext<DecisionR>, E, ContextR>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData | ContextR | DecisionR> =>
  context.pipe(
    Effect.mapError((cause) =>
      runnerError('load-context', 'context', 'autonomous cycle context loading failed', cause),
    ),
    Effect.flatMap(runAutonomousCycleUntilSettled),
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
    runLoopPass(options.context),
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
