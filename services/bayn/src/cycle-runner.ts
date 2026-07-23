import { Clock, Data, Duration, Effect, Fiber, Schedule, Scope } from 'effect'

import {
  BrokerRead,
  type MarketCalendarObservation,
  type MarketCalendarQuery,
  type MarketCalendarSession,
} from './broker/alpaca'
import {
  makeCycleDraft,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  type CycleDraft,
  type CycleExecutionPolicy,
} from './cycle'
import { CycleStore, type CycleAcquireReceipt } from './db/cycle-store'
import type { SignalSessionRow } from './market-data'

const calendarRangeDays = 31
const millisecondsPerDay = 86_400_000

type SignalCycleSession = Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'close_time' | 'timezone'>

export interface CycleCandidate {
  readonly qualificationRunId: string
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly signalSession: SignalCycleSession
  readonly executionPolicy: CycleExecutionPolicy
}

export type CycleRunResult =
  | {
      readonly outcome: 'NOT_DUE'
      readonly signalSessionDate: string
      readonly executionSessionDate: string
      readonly observedAt: string
      readonly calendarResponseHash: string
      readonly calendarReadContentHash: string
    }
  | {
      readonly outcome: 'ACQUIRED' | 'REACQUIRED'
      readonly signalSessionDate: string
      readonly executionSessionDate: string
      readonly observedAt: string
      readonly calendarResponseHash: string
      readonly calendarReadContentHash: string
      readonly receipt: CycleAcquireReceipt
    }

export class CycleRunnerError extends Data.TaggedError('CycleRunnerError')<{
  readonly operation:
    | 'acquire-cycle'
    | 'build-cycle'
    | 'configure'
    | 'load-candidate'
    | 'market-calendar'
    | 'select-session'
  readonly failure: 'calendar-read' | 'calendar-unavailable' | 'candidate' | 'contract' | 'invalid-config' | 'store'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface AutonomousCycleLoopOptions<E = never, R = never> {
  readonly candidate: Effect.Effect<CycleCandidate | undefined, E, R>
  readonly pollIntervalMs: number
}

const runnerError = (
  operation: CycleRunnerError['operation'],
  failure: CycleRunnerError['failure'],
  message: string,
  cause?: unknown,
): CycleRunnerError => new CycleRunnerError({ operation, failure, message, cause })

const addUtcDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * millisecondsPerDay).toISOString().slice(0, 10)

export const marketCalendarQueryForSignal = (signalSessionDate: string): MarketCalendarQuery => ({
  start: signalSessionDate,
  end: addUtcDays(signalSessionDate, calendarRangeDays - 1),
})

export const selectNextExecutionSession = (
  signalSessionDate: string,
  observation: MarketCalendarObservation,
): MarketCalendarSession | undefined => {
  let selected: MarketCalendarSession | undefined
  for (const session of observation.sessions) {
    if (session.date > signalSessionDate && (selected === undefined || session.date < selected.date)) {
      selected = session
    }
  }
  return selected
}

export const isMonthEndCycleDue = (signalSessionDate: string, executionSessionDate: string): boolean =>
  signalSessionDate.slice(0, 7) !== executionSessionDate.slice(0, 7)

export const makeDueCycleDraft = (
  candidate: CycleCandidate,
  observation: MarketCalendarObservation,
  executionSession: MarketCalendarSession,
): CycleDraft | undefined => {
  if (!isMonthEndCycleDue(candidate.signalSession.session_date, executionSession.date)) return undefined
  const executionCalendar = makeExecutionCalendarObservation({
    schemaVersion: observation.schemaVersion,
    source: observation.source,
    ...executionSession,
  })
  const identity = makeCycleIdentity({
    schemaVersion: 'bayn.autonomous-cycle-identity.v1',
    strategyName: 'risk-balanced-trend',
    qualificationRunId: candidate.qualificationRunId,
    strategyProtocolHash: candidate.strategyProtocolHash,
    accountId: candidate.accountId,
    signalSessionDate: candidate.signalSession.session_date,
    signalCalendarVersion: candidate.signalSession.calendar_version,
    executionSessionDate: executionCalendar.executionSessionDate,
    executionCalendarSchemaVersion: executionCalendar.executionCalendarSchemaVersion,
    executionCalendarSource: executionCalendar.executionCalendarSource,
    executionCalendarHash: executionCalendar.executionCalendarHash,
    executionPolicy: candidate.executionPolicy,
  })
  const window = makeCycleWindow(candidate.signalSession, executionCalendar, candidate.executionPolicy)
  return makeCycleDraft(identity, window)
}

export const runAutonomousCyclePass = (
  candidate: CycleCandidate,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore> =>
  Effect.gen(function* () {
    const broker = yield* BrokerRead
    const store = yield* CycleStore
    const query = marketCalendarQueryForSignal(candidate.signalSession.session_date)
    const calendar = yield* broker
      .marketCalendar(query)
      .pipe(
        Effect.mapError((cause) =>
          runnerError('market-calendar', 'calendar-read', 'authoritative broker calendar read failed', cause),
        ),
      )
    const executionSession = selectNextExecutionSession(candidate.signalSession.session_date, calendar.value)
    if (executionSession === undefined) {
      return yield* Effect.fail(
        runnerError(
          'select-session',
          'calendar-unavailable',
          `broker calendar has no trading session after ${candidate.signalSession.session_date}`,
        ),
      )
    }
    const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const common = {
      signalSessionDate: candidate.signalSession.session_date,
      executionSessionDate: executionSession.date,
      observedAt,
      calendarResponseHash: calendar.value.normalizedResponseHash,
      calendarReadContentHash: calendar.evidence.contentHash,
    } as const
    const draft = yield* Effect.try({
      try: () => makeDueCycleDraft(candidate, calendar.value, executionSession),
      catch: (cause) => runnerError('build-cycle', 'contract', 'autonomous cycle draft construction failed', cause),
    })
    if (draft === undefined) return { outcome: 'NOT_DUE', ...common }
    const receipt = yield* store
      .acquire(draft, observedAt)
      .pipe(
        Effect.mapError((cause) =>
          runnerError('acquire-cycle', 'store', 'durable autonomous cycle acquisition failed', cause),
        ),
      )
    return {
      outcome: receipt.created ? 'ACQUIRED' : 'REACQUIRED',
      ...common,
      receipt,
    }
  })

const logCompletedPass = (result: CycleRunResult): Effect.Effect<void> =>
  Effect.logInfo('Bayn autonomous cycle pass completed').pipe(
    Effect.annotateLogs({
      outcome: result.outcome,
      signalSessionDate: result.signalSessionDate,
      executionSessionDate: result.executionSessionDate,
      observedAt: result.observedAt,
      calendarResponseHash: result.calendarResponseHash,
      calendarReadContentHash: result.calendarReadContentHash,
      ...(result.outcome === 'NOT_DUE'
        ? {}
        : {
            cycleId: result.receipt.cycle.identity.cycleId,
            cycleState: result.receipt.cycle.state,
            persistenceDeduplicated: !result.receipt.created,
          }),
    }),
  )

const runLoopPass = <E, R>(
  candidate: Effect.Effect<CycleCandidate | undefined, E, R>,
): Effect.Effect<void, CycleRunnerError, BrokerRead | CycleStore | R> =>
  candidate.pipe(
    Effect.mapError((cause) =>
      runnerError('load-candidate', 'candidate', 'autonomous cycle candidate discovery failed', cause),
    ),
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.void
        : runAutonomousCyclePass(value).pipe(Effect.tap(logCompletedPass), Effect.asVoid),
    ),
    Effect.withLogSpan('autonomous-cycle'),
  )

export const startAutonomousCycleLoop = <E, R>(
  options: AutonomousCycleLoopOptions<E, R>,
): Effect.Effect<Fiber.Fiber<void, CycleRunnerError>, CycleRunnerError, BrokerRead | CycleStore | R | Scope.Scope> => {
  if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    return Effect.fail(
      runnerError('configure', 'invalid-config', 'cycle loop interval must be a positive safe integer'),
    )
  }
  return runLoopPass(options.candidate).pipe(
    Effect.repeat(Schedule.spaced(Duration.millis(options.pollIntervalMs))),
    Effect.asVoid,
    Effect.forkScoped({ startImmediately: true }),
  )
}
