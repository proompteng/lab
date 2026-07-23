import { Clock, Data, Duration, Effect, Fiber, Option, Schedule, Scope } from 'effect'

import {
  BrokerRead,
  type MarketCalendarObservation,
  type MarketCalendarQuery,
  type MarketCalendarSession,
} from './broker/alpaca'
import {
  CycleState,
  isTerminalCycleState,
  makeCycleDraft,
  makeCycleIdentity,
  makeCycleWindow,
  makeExecutionCalendarObservation,
  type AutonomousCycle,
  type CycleDraft,
  type CycleExecutionPolicy,
} from './cycle'
import {
  bindFinalizedCyclePublication,
  runCyclePublicationReadiness,
  type CyclePublicationReadiness,
  type CycleReadinessError,
} from './cycle-readiness'
import { selectCycleRecovery, type CycleRecoverySelection, type CycleRecoveryState } from './cycle-recovery'
import { CycleStore, type CycleAcquireReceipt } from './db/cycle-store'
import type { OperationalError } from './errors'
import { MarketData, type MarketDataInspection, type SignalSessionRow } from './market-data'
import type { ObserveShadowDecisionDocument } from './shadow-decision-contract'

const calendarRangeDays = 31
// This leaves at least 10 calendar days after the newest candidate inside Alpaca's 31-day observation bound.
const publicationCatchUpRangeDays = 21
const millisecondsPerDay = 86_400_000

type SignalCycleSession = Pick<SignalSessionRow, 'calendar_version' | 'session_date' | 'close_time' | 'timezone'>

export interface CycleRunContext {
  readonly qualificationRunId: string
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly executionPolicy: CycleExecutionPolicy
  readonly buildDecision: (cycle: AutonomousCycle) => Effect.Effect<ObserveShadowDecisionDocument, unknown>
}

export interface CycleCandidate {
  readonly qualificationRunId: string
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly signalSession: SignalCycleSession
  readonly executionPolicy: CycleExecutionPolicy
}

type CycleBindingResult = Exclude<CyclePublicationReadiness, { readonly outcome: 'WAITING' }>

export type CycleRunResult =
  | {
      readonly outcome: 'NO_PUBLICATION'
      readonly observedAt: string
    }
  | {
      readonly outcome: 'ALREADY_ACQUIRED'
      readonly signalSessionDate: string
      readonly observedAt: string
      readonly cycle: CycleBindingResult['cycle']
    }
  | {
      readonly outcome: 'ALREADY_TERMINAL'
      readonly signalSessionDate: string
      readonly observedAt: string
      readonly cycle: AutonomousCycle
    }
  | {
      readonly outcome: 'RESUMED'
      readonly signalSessionDate: string
      readonly observedAt: string
      readonly readiness: CycleBindingResult
    }
  | {
      readonly outcome: 'RECOVERED'
      readonly action:
        | 'ACTIVATED'
        | 'BLOCKED'
        | 'BOUND_DECISION'
        | 'BOUND_SNAPSHOT'
        | 'COMPLETED'
        | 'NO_TRADE'
        | 'WAITING'
      readonly observedAt: string
      readonly cycle: AutonomousCycle
    }
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
      readonly readiness: CycleBindingResult
    }

export class CycleRunnerError extends Data.TaggedError('CycleRunnerError')<{
  readonly operation:
    | 'acquire-cycle'
    | 'bind-publication'
    | 'build-decision'
    | 'build-cycle'
    | 'configure'
    | 'inspect-publication'
    | 'load-context'
    | 'market-calendar'
    | 'read-oldest-unfinished'
    | 'read-authority-slot'
    | 'recover-cycle'
    | 'select-session'
  readonly failure:
    | 'calendar-read'
    | 'calendar-unavailable'
    | 'context'
    | 'contract'
    | 'invalid-config'
    | 'market-data'
    | 'store'
  readonly message: string
  readonly cause?: unknown
}> {}

export type CyclePassObservation =
  | {
      readonly outcome: 'SUCCEEDED'
      readonly observedAt: string
      readonly result: CycleRunResult
    }
  | {
      readonly outcome: 'FAILED'
      readonly observedAt: string
      readonly error: CycleRunnerError
    }

export interface AutonomousCycleLoopOptions<E = never, R = never> {
  readonly context: Effect.Effect<CycleRunContext, E, R>
  readonly observePass: (observation: CyclePassObservation) => Effect.Effect<void>
  readonly pollIntervalMs: number
}

const runnerError = (
  operation: CycleRunnerError['operation'],
  failure: CycleRunnerError['failure'],
  message: string,
  cause?: unknown,
): CycleRunnerError => new CycleRunnerError({ operation, failure, message, cause })

const bindDiscoveredPublication = (
  cycle: AutonomousCycle,
  inspection: MarketDataInspection,
  observedAt: string,
): Effect.Effect<CycleBindingResult, CycleRunnerError, CycleStore> =>
  bindFinalizedCyclePublication(cycle, inspection, observedAt).pipe(
    Effect.mapError((cause: CycleReadinessError) =>
      runnerError(
        'bind-publication',
        cause.failure === 'store' ? 'store' : 'contract',
        'exact finalized Signal publication binding failed',
        cause,
      ),
    ),
    Effect.flatMap((readiness) =>
      readiness.outcome === 'WAITING'
        ? Effect.fail(
            runnerError(
              'bind-publication',
              'contract',
              'discovered finalized Signal publication unexpectedly remained waiting',
            ),
          )
        : Effect.succeed(readiness),
    ),
  )

const addUtcDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * millisecondsPerDay).toISOString().slice(0, 10)

export const marketCalendarQueryForSignal = (signalSessionDate: string): MarketCalendarQuery => ({
  start: signalSessionDate,
  end: addUtcDays(signalSessionDate, calendarRangeDays - 1),
})

export const marketCalendarQueryForPublications = (
  publications: readonly MarketDataInspection[],
): MarketCalendarQuery => {
  const sessionDates = publications.map((publication) => publication.signalSession.session_date).sort()
  const earliest = sessionDates[0]
  if (earliest === undefined) throw new TypeError('cycle publication discovery must contain at least one session')
  return marketCalendarQueryForSignal(earliest)
}

const boundedCyclePublications = (publications: readonly MarketDataInspection[]): readonly MarketDataInspection[] => {
  const ordered = [...publications].sort((left, right) =>
    right.signalSession.session_date.localeCompare(left.signalSession.session_date),
  )
  const latest = ordered[0]?.signalSession.session_date
  if (latest === undefined) throw new TypeError('cycle publication discovery must contain at least one publication')
  const earliest = addUtcDays(latest, -(publicationCatchUpRangeDays - 1))
  const sessionDates = new Set<string>()
  return ordered.filter((publication) => {
    const sessionDate = publication.signalSession.session_date
    if (sessionDates.has(sessionDate)) {
      throw new TypeError(`cycle publication discovery contains duplicate session ${sessionDate}`)
    }
    sessionDates.add(sessionDate)
    return sessionDate >= earliest
  })
}

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

export const discoverAutonomousCyclePass = (
  context: CycleRunContext,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData> =>
  Effect.gen(function* () {
    const broker = yield* BrokerRead
    const store = yield* CycleStore
    const marketData = yield* MarketData
    const discovery = yield* marketData.inspectCyclePublications.pipe(
      Effect.mapError((cause: OperationalError) =>
        runnerError(
          'inspect-publication',
          'market-data',
          'bounded finalized Signal publication discovery failed',
          cause,
        ),
      ),
    )
    if (discovery.outcome === 'MISSING') {
      return { outcome: 'NO_PUBLICATION', observedAt: discovery.observedAt }
    }
    const publications = yield* Effect.try({
      try: () => boundedCyclePublications(discovery.publications),
      catch: (cause) =>
        runnerError('inspect-publication', 'contract', 'bounded cycle publication discovery is invalid', cause),
    })
    const unclaimed: MarketDataInspection[] = []
    let latestTerminal: AutonomousCycle | undefined
    for (const publication of publications) {
      const signalSessionDate = publication.signalSession.session_date
      const existing = yield* store
        .readAuthoritySlot({
          qualificationRunId: context.qualificationRunId,
          accountId: context.accountId,
          signalSessionDate,
        })
        .pipe(
          Effect.mapError((cause) =>
            runnerError('read-authority-slot', 'store', 'durable autonomous cycle authority-slot read failed', cause),
          ),
        )
      if (Option.isNone(existing)) {
        unclaimed.push(publication)
        continue
      }
      if (isTerminalCycleState(existing.value.state)) {
        if (latestTerminal === undefined) latestTerminal = existing.value
        continue
      }
      if (existing.value.bindings.snapshotId === undefined) {
        const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
        const readiness = yield* bindDiscoveredPublication(existing.value, publication, observedAt)
        return {
          outcome: 'RESUMED',
          signalSessionDate,
          observedAt,
          readiness,
        }
      }
      return {
        outcome: 'ALREADY_ACQUIRED',
        signalSessionDate,
        observedAt: discovery.observedAt,
        cycle: existing.value,
      }
    }
    if (unclaimed.length === 0) {
      if (latestTerminal === undefined) {
        return yield* Effect.fail(
          runnerError(
            'read-authority-slot',
            'contract',
            'cycle discovery found no resumable or terminal authority slot',
          ),
        )
      }
      return {
        outcome: 'ALREADY_TERMINAL',
        signalSessionDate: latestTerminal.identity.signalSessionDate,
        observedAt: discovery.observedAt,
        cycle: latestTerminal,
      }
    }
    const query = yield* Effect.try({
      try: () => marketCalendarQueryForPublications(unclaimed),
      catch: (cause) => runnerError('market-calendar', 'contract', 'cycle calendar query construction failed', cause),
    })
    const calendar = yield* broker
      .marketCalendar(query)
      .pipe(
        Effect.mapError((cause) =>
          runnerError('market-calendar', 'calendar-read', 'authoritative broker calendar read failed', cause),
        ),
      )
    const calendarObservedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    let latestNotDue: Extract<CycleRunResult, { readonly outcome: 'NOT_DUE' }> | undefined
    for (const publication of unclaimed) {
      const candidate: CycleCandidate = {
        qualificationRunId: context.qualificationRunId,
        strategyProtocolHash: context.strategyProtocolHash,
        accountId: context.accountId,
        signalSession: publication.signalSession,
        executionPolicy: context.executionPolicy,
      }
      const signalSessionDate = candidate.signalSession.session_date
      const executionSession = selectNextExecutionSession(signalSessionDate, calendar.value)
      if (executionSession === undefined) {
        return yield* Effect.fail(
          runnerError(
            'select-session',
            'calendar-unavailable',
            `broker calendar has no trading session after ${signalSessionDate}`,
          ),
        )
      }
      const common = {
        signalSessionDate,
        executionSessionDate: executionSession.date,
        calendarResponseHash: calendar.value.normalizedResponseHash,
        calendarReadContentHash: calendar.evidence.contentHash,
      } as const
      const draft = yield* Effect.try({
        try: () => makeDueCycleDraft(candidate, calendar.value, executionSession),
        catch: (cause) => runnerError('build-cycle', 'contract', 'autonomous cycle draft construction failed', cause),
      })
      if (draft === undefined) {
        if (latestNotDue === undefined) {
          latestNotDue = { outcome: 'NOT_DUE', observedAt: calendarObservedAt, ...common }
        }
        continue
      }
      const acquiredAt = new Date(yield* Clock.currentTimeMillis).toISOString()
      const receipt = yield* store
        .acquire(draft, acquiredAt)
        .pipe(
          Effect.mapError((cause) =>
            runnerError('acquire-cycle', 'store', 'durable autonomous cycle acquisition failed', cause),
          ),
        )
      const bindingObservedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
      const readiness = yield* bindDiscoveredPublication(receipt.cycle, publication, bindingObservedAt)
      return {
        outcome: receipt.created ? 'ACQUIRED' : 'REACQUIRED',
        observedAt: bindingObservedAt,
        ...common,
        receipt,
        readiness,
      }
    }
    if (latestNotDue !== undefined) return latestNotDue
    return yield* Effect.fail(
      runnerError('inspect-publication', 'contract', 'bounded cycle publication discovery produced no candidates'),
    )
  })

const chooseRecovery = (state: CycleRecoveryState): Effect.Effect<CycleRecoverySelection, CycleRunnerError> =>
  Effect.try({
    try: () => selectCycleRecovery(state),
    catch: (cause) => runnerError('recover-cycle', 'contract', 'autonomous cycle recovery state is invalid', cause),
  })

const readinessFailure = (cause: CycleReadinessError): CycleRunnerError['failure'] => {
  switch (cause.failure) {
    case 'store':
      return 'store'
    case 'market-data':
      return 'market-data'
    case 'contract':
      return 'contract'
  }
}

const recoverCycle = (
  selection: CycleRecoverySelection,
  context: CycleRunContext,
  observedAt: string,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData> => {
  switch (selection.action) {
    case 'DISCOVER':
      return discoverAutonomousCyclePass(context)
    case 'BLOCK':
      return Effect.gen(function* () {
        const store = yield* CycleStore
        const blocked = yield* store
          .block(selection.cycleId, selection.reason, selection.observedAt)
          .pipe(
            Effect.mapError((cause) =>
              runnerError('recover-cycle', 'store', 'unfinished autonomous cycle blocking failed', cause),
            ),
          )
        return {
          outcome: 'RECOVERED',
          action: 'BLOCKED',
          observedAt: selection.observedAt,
          cycle: blocked.cycle,
        }
      })
    case 'READ_PUBLICATION':
      return runCyclePublicationReadiness(selection.cycle).pipe(
        Effect.mapError((cause: CycleReadinessError) =>
          runnerError('recover-cycle', readinessFailure(cause), 'unfinished cycle publication recovery failed', cause),
        ),
        Effect.flatMap((readiness) =>
          chooseRecovery({
            qualificationRunId: context.qualificationRunId,
            accountId: context.accountId,
            strategyProtocolHash: context.strategyProtocolHash,
            observedAt,
            cycle: selection.cycle,
            readiness,
          }),
        ),
        Effect.flatMap((next) => recoverCycle(next, context, observedAt)),
      )
    case 'RETURN_READINESS':
      return Effect.succeed({
        outcome: 'RECOVERED',
        action: selection.recoveryAction,
        observedAt: selection.result.observedAt,
        cycle: selection.result.cycle,
      })
    case 'ACTIVATE':
      return Effect.gen(function* () {
        const store = yield* CycleStore
        const activation = yield* store
          .activate(selection.cycleId, selection.observedAt)
          .pipe(
            Effect.mapError((cause) =>
              runnerError('recover-cycle', 'store', 'snapshot-bound cycle activation failed', cause),
            ),
          )
        return {
          outcome: 'RECOVERED',
          action: activation.cycle.state === CycleState.Blocked ? 'BLOCKED' : 'ACTIVATED',
          observedAt: selection.observedAt,
          cycle: activation.cycle,
        }
      })
    case 'BUILD_DECISION':
      return context.buildDecision(selection.cycle).pipe(
        Effect.mapError((cause) =>
          runnerError('build-decision', 'contract', 'OBSERVE shadow decision construction failed', cause),
        ),
        Effect.flatMap((document) =>
          Effect.gen(function* () {
            const store = yield* CycleStore
            const bindObservedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
            const binding = yield* store
              .bindDecision(selection.cycle.identity.cycleId, document, bindObservedAt)
              .pipe(
                Effect.mapError((cause) =>
                  runnerError('recover-cycle', 'store', 'durable shadow decision binding failed', cause),
                ),
              )
            return {
              outcome: 'RECOVERED',
              action: binding.cycle.state === CycleState.Blocked ? 'BLOCKED' : 'BOUND_DECISION',
              observedAt: binding.cycle.updatedAt,
              cycle: binding.cycle,
            }
          }),
        ),
      )
    case 'READ_DECISION':
      return Effect.gen(function* () {
        const store = yield* CycleStore
        const document = yield* store
          .readDecisionDocument(selection.cycle.identity.cycleId)
          .pipe(
            Effect.mapError((cause) =>
              runnerError('recover-cycle', 'store', 'durable shadow decision read failed', cause),
            ),
          )
        const next = yield* chooseRecovery({
          qualificationRunId: context.qualificationRunId,
          accountId: context.accountId,
          strategyProtocolHash: context.strategyProtocolHash,
          observedAt,
          cycle: selection.cycle,
          decisionDocument: Option.match(document, {
            onNone: () => null,
            onSome: (value) => value,
          }),
        })
        return yield* recoverCycle(next, context, observedAt)
      })
    case 'FINISH':
      return Effect.gen(function* () {
        const store = yield* CycleStore
        const finished = yield* store
          .finish(selection.cycleId, selection.state, selection.observedAt)
          .pipe(
            Effect.mapError((cause) =>
              runnerError('recover-cycle', 'store', 'shadow cycle terminal transition failed', cause),
            ),
          )
        let action: Extract<CycleRunResult, { readonly outcome: 'RECOVERED' }>['action']
        switch (finished.cycle.state) {
          case CycleState.Completed:
            action = 'COMPLETED'
            break
          case CycleState.NoTrade:
            action = 'NO_TRADE'
            break
          case CycleState.Blocked:
            action = 'BLOCKED'
            break
          default:
            return yield* Effect.fail(
              runnerError('recover-cycle', 'contract', 'cycle finish did not produce a terminal state'),
            )
        }
        return {
          outcome: 'RECOVERED',
          action,
          observedAt: selection.observedAt,
          cycle: finished.cycle,
        }
      })
  }
}

export const runAutonomousCyclePass = (
  context: CycleRunContext,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData> =>
  Effect.gen(function* () {
    const store = yield* CycleStore
    const unfinished = yield* store
      .readOldestUnfinished({
        qualificationRunId: context.qualificationRunId,
        accountId: context.accountId,
      })
      .pipe(
        Effect.mapError((cause) =>
          runnerError('read-oldest-unfinished', 'store', 'oldest unfinished autonomous cycle read failed', cause),
        ),
      )
    const cycle = Option.match(unfinished, {
      onNone: () => undefined,
      onSome: (value) => value,
    })
    const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const selection = yield* chooseRecovery({
      qualificationRunId: context.qualificationRunId,
      accountId: context.accountId,
      strategyProtocolHash: context.strategyProtocolHash,
      observedAt,
      cycle,
    })
    return yield* recoverCycle(selection, context, observedAt)
  })

const logCompletedPass = (result: CycleRunResult): Effect.Effect<void> => {
  switch (result.outcome) {
    case 'NO_PUBLICATION':
      return Effect.logInfo('Bayn autonomous cycle pass completed').pipe(
        Effect.annotateLogs({ outcome: result.outcome, observedAt: result.observedAt }),
      )
    case 'ALREADY_ACQUIRED':
      return Effect.logInfo('Bayn autonomous cycle pass completed').pipe(
        Effect.annotateLogs({
          outcome: result.outcome,
          signalSessionDate: result.signalSessionDate,
          observedAt: result.observedAt,
          cycleId: result.cycle.identity.cycleId,
          cycleState: result.cycle.state,
        }),
      )
    case 'ALREADY_TERMINAL':
      return Effect.logInfo('Bayn autonomous cycle pass completed').pipe(
        Effect.annotateLogs({
          outcome: result.outcome,
          signalSessionDate: result.signalSessionDate,
          observedAt: result.observedAt,
          cycleId: result.cycle.identity.cycleId,
          cycleState: result.cycle.state,
        }),
      )
    case 'RESUMED':
      return Effect.logInfo('Bayn autonomous cycle pass completed').pipe(
        Effect.annotateLogs({
          outcome: result.outcome,
          signalSessionDate: result.signalSessionDate,
          observedAt: result.observedAt,
          cycleId: result.readiness.cycle.identity.cycleId,
          cycleState: result.readiness.cycle.state,
          publicationReadiness: result.readiness.outcome,
        }),
      )
    case 'RECOVERED':
      return Effect.logInfo('Bayn autonomous cycle pass completed').pipe(
        Effect.annotateLogs({
          outcome: result.outcome,
          recoveryAction: result.action,
          observedAt: result.observedAt,
          cycleId: result.cycle.identity.cycleId,
          cycleState: result.cycle.state,
        }),
      )
    case 'NOT_DUE':
      return Effect.logInfo('Bayn autonomous cycle pass completed').pipe(
        Effect.annotateLogs({
          outcome: result.outcome,
          signalSessionDate: result.signalSessionDate,
          executionSessionDate: result.executionSessionDate,
          observedAt: result.observedAt,
          calendarResponseHash: result.calendarResponseHash,
          calendarReadContentHash: result.calendarReadContentHash,
        }),
      )
    case 'ACQUIRED':
    case 'REACQUIRED':
      return Effect.logInfo('Bayn autonomous cycle pass completed').pipe(
        Effect.annotateLogs({
          outcome: result.outcome,
          signalSessionDate: result.signalSessionDate,
          executionSessionDate: result.executionSessionDate,
          observedAt: result.observedAt,
          calendarResponseHash: result.calendarResponseHash,
          calendarReadContentHash: result.calendarReadContentHash,
          cycleId: result.readiness.cycle.identity.cycleId,
          cycleState: result.readiness.cycle.state,
          publicationReadiness: result.readiness.outcome,
          persistenceDeduplicated: !result.receipt.created,
        }),
      )
  }
}

const logFailedPass = (error: CycleRunnerError): Effect.Effect<void> =>
  Effect.logError('Bayn autonomous cycle pass failed').pipe(
    Effect.annotateLogs({
      operation: error.operation,
      failure: error.failure,
      message: error.message,
    }),
  )

const runLoopPass = <E, R>(
  context: Effect.Effect<CycleRunContext, E, R>,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData | R> =>
  context.pipe(
    Effect.mapError((cause) =>
      runnerError('load-context', 'context', 'autonomous cycle context loading failed', cause),
    ),
    Effect.flatMap(runAutonomousCyclePass),
    Effect.withLogSpan('autonomous-cycle'),
  )

const observationTime = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()))

export const startAutonomousCycleLoop = <E, R>(
  options: AutonomousCycleLoopOptions<E, R>,
): Effect.Effect<
  Fiber.Fiber<void, never>,
  CycleRunnerError,
  BrokerRead | CycleStore | MarketData | R | Scope.Scope
> => {
  if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    return Effect.fail(
      runnerError('configure', 'invalid-config', 'cycle loop interval must be a positive safe integer'),
    )
  }
  return runLoopPass(options.context).pipe(
    Effect.flatMap((result) =>
      observationTime.pipe(
        Effect.flatMap((observedAt) => options.observePass({ outcome: 'SUCCEEDED', observedAt, result })),
        Effect.andThen(logCompletedPass(result)),
      ),
    ),
    Effect.catch((error) =>
      observationTime.pipe(
        Effect.flatMap((observedAt) => options.observePass({ outcome: 'FAILED', observedAt, error })),
        Effect.andThen(logFailedPass(error)),
      ),
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(options.pollIntervalMs))),
    Effect.asVoid,
    Effect.forkScoped({ startImmediately: true }),
  )
}
