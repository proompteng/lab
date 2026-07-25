import { Clock, Data, Duration, Effect, Option, Result, Schedule } from 'effect'

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
  type CycleConstructionFailure,
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

export class CycleDecisionBuildError extends Data.TaggedError('CycleDecisionBuildError')<{
  readonly failure: 'contract' | 'database' | 'market-data' | 'operational' | 'store'
  readonly message: string
  readonly cause?: unknown
}> {}

export interface CycleRunContext {
  readonly qualificationRunId: string
  readonly strategyProtocolHash: string
  readonly accountId: string
  readonly executionPolicy: CycleExecutionPolicy
  readonly buildDecision: (
    cycle: AutonomousCycle,
  ) => Effect.Effect<ObserveShadowDecisionDocument, CycleDecisionBuildError>
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
    | 'database'
    | 'invalid-config'
    | 'market-data'
    | 'operational'
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

type NonEmptyReadonlyArray<A> = readonly [A, ...A[]]
type NonEmptyPublications = NonEmptyReadonlyArray<MarketDataInspection>

interface CyclePublicationDateInput {
  readonly signalSession: {
    readonly session_date: string
  }
}

type IsoDateShiftFailure = {
  readonly _tag: 'IsoDateShiftOutOfRange'
  readonly date: string
  readonly days: number
  readonly cause: unknown
}

type CyclePublicationFailure =
  | {
      readonly _tag: 'CyclePublicationDateInvalid'
      readonly signalSessionDate: string
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CyclePublicationDuplicate'
      readonly signalSessionDate: string
    }
  | {
      readonly _tag: 'CyclePublicationRangeOutOfRange'
      readonly signalSessionDate: string
      readonly offsetDays: number
      readonly cause: unknown
    }

type CycleCalendarQueryFailure = {
  readonly _tag: 'CycleCalendarQueryRangeOutOfRange'
  readonly signalSessionDate: string
  readonly offsetDays: number
  readonly cause: unknown
}

const shiftIsoDate = (date: string, days: number): Result.Result<string, IsoDateShiftFailure> => {
  const failure = (cause: unknown): IsoDateShiftFailure => ({
    _tag: 'IsoDateShiftOutOfRange',
    date,
    days,
    cause,
  })
  return Result.flatMap(
    Result.try({
      try: () => {
        const input = new Date(`${date}T00:00:00.000Z`).toISOString()
        if (input !== `${date}T00:00:00.000Z`) {
          return {
            _tag: 'INVALID' as const,
            cause: { _tag: 'IsoDateInputNotCanonical', date, normalized: input } as const,
          }
        }
        const shifted = new Date(Date.parse(input) + days * millisecondsPerDay).toISOString()
        const shiftedDate = shifted.slice(0, 10)
        return /^\d{4}-\d{2}-\d{2}$/.test(shiftedDate) && shifted === `${shiftedDate}T00:00:00.000Z`
          ? { _tag: 'VALID' as const, shiftedDate }
          : {
              _tag: 'INVALID' as const,
              cause: { _tag: 'IsoDateShiftResultOutOfRange', date, days, shifted } as const,
            }
      },
      catch: failure,
    }),
    (outcome) => (outcome._tag === 'VALID' ? Result.succeed(outcome.shiftedDate) : Result.fail(failure(outcome.cause))),
  )
}

export const marketCalendarQueryForSignal = (
  signalSessionDate: string,
): Result.Result<MarketCalendarQuery, CycleCalendarQueryFailure> =>
  Result.mapError(
    Result.map(shiftIsoDate(signalSessionDate, calendarRangeDays - 1), (end) => ({
      start: signalSessionDate,
      end,
    })),
    (failure) => ({
      _tag: 'CycleCalendarQueryRangeOutOfRange',
      signalSessionDate,
      offsetDays: calendarRangeDays - 1,
      cause: failure.cause,
    }),
  )

export const marketCalendarQueryForPublications = (
  publications: NonEmptyPublications,
): Result.Result<MarketCalendarQuery, CycleCalendarQueryFailure> =>
  marketCalendarQueryForSignal(
    publications.reduce((earliest, publication) =>
      publication.signalSession.session_date < earliest.signalSession.session_date ? publication : earliest,
    ).signalSession.session_date,
  )

export const boundedCyclePublications = <Publication extends CyclePublicationDateInput>(
  publications: NonEmptyReadonlyArray<Publication>,
): Result.Result<NonEmptyReadonlyArray<Publication>, CyclePublicationFailure> => {
  for (const publication of publications) {
    const signalSessionDate = publication.signalSession.session_date
    const validation = shiftIsoDate(signalSessionDate, 0)
    if (Result.isFailure(validation)) {
      return Result.fail({
        _tag: 'CyclePublicationDateInvalid',
        signalSessionDate,
        cause: validation.failure.cause,
      })
    }
  }
  const sessionDates = new Set<string>()
  for (const publication of publications) {
    const signalSessionDate = publication.signalSession.session_date
    if (sessionDates.has(signalSessionDate)) {
      return Result.fail({ _tag: 'CyclePublicationDuplicate', signalSessionDate })
    }
    sessionDates.add(signalSessionDate)
  }
  const latestPublication = publications.reduce((latest, publication) =>
    publication.signalSession.session_date > latest.signalSession.session_date ? publication : latest,
  )
  const latest = latestPublication.signalSession.session_date
  const offsetDays = -(publicationCatchUpRangeDays - 1)
  return Result.mapError(
    Result.map(
      shiftIsoDate(latest, offsetDays),
      (earliest): NonEmptyReadonlyArray<Publication> => [
        latestPublication,
        ...publications
          .filter((publication) => {
            const sessionDate = publication.signalSession.session_date
            return sessionDate !== latest && sessionDate >= earliest
          })
          .sort((left, right) => right.signalSession.session_date.localeCompare(left.signalSession.session_date)),
      ],
    ),
    (failure) => ({
      _tag: 'CyclePublicationRangeOutOfRange',
      signalSessionDate: latest,
      offsetDays,
      cause: failure.cause,
    }),
  )
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
): Result.Result<CycleDraft | undefined, CycleConstructionFailure> =>
  !isMonthEndCycleDue(candidate.signalSession.session_date, executionSession.date)
    ? Result.succeed(undefined)
    : Result.flatMap(
        makeExecutionCalendarObservation({
          schemaVersion: observation.schemaVersion,
          source: observation.source,
          ...executionSession,
        }),
        (executionCalendar) =>
          Result.flatMap(
            makeCycleIdentity({
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
            }),
            (identity) =>
              Result.flatMap(
                makeCycleWindow(candidate.signalSession, executionCalendar, candidate.executionPolicy),
                (window) => makeCycleDraft(identity, window),
              ),
          ),
      )

type CycleAuthoritySlotDecision =
  | {
      readonly _tag: 'UNCLAIMED'
      readonly publication: MarketDataInspection
    }
  | {
      readonly _tag: 'TERMINAL'
      readonly cycle: AutonomousCycle
    }
  | {
      readonly _tag: 'RESUME'
      readonly publication: MarketDataInspection
      readonly cycle: AutonomousCycle
    }
  | {
      readonly _tag: 'ALREADY_ACQUIRED'
      readonly publication: MarketDataInspection
      readonly cycle: AutonomousCycle
    }

interface CycleAuthoritySlot {
  readonly publication: MarketDataInspection
  readonly existing: AutonomousCycle | undefined
}

type NonEmptyAuthoritySlots = readonly [CycleAuthoritySlot, ...CycleAuthoritySlot[]]

type CycleAuthoritySelection =
  | Extract<CycleAuthoritySlotDecision, { readonly _tag: 'RESUME' | 'ALREADY_ACQUIRED' }>
  | {
      readonly _tag: 'READ_CALENDAR'
      readonly publications: NonEmptyPublications
    }
  | {
      readonly _tag: 'ALREADY_TERMINAL'
      readonly cycle: AutonomousCycle
    }

type CycleAuthoritySelectionState =
  | {
      readonly _tag: 'UNCLAIMED'
      readonly publications: NonEmptyPublications
      readonly latestTerminal: AutonomousCycle | undefined
    }
  | {
      readonly _tag: 'TERMINAL'
      readonly latestTerminal: AutonomousCycle
    }

type CycleAuthoritySelectionReduction =
  | {
      readonly _tag: 'CONTINUE'
      readonly state: CycleAuthoritySelectionState
    }
  | Extract<CycleAuthoritySelection, { readonly _tag: 'RESUME' | 'ALREADY_ACQUIRED' }>

const classifyCycleAuthoritySlot = (
  publication: MarketDataInspection,
  existing: AutonomousCycle | undefined,
): CycleAuthoritySlotDecision => {
  if (existing === undefined) {
    return { _tag: 'UNCLAIMED', publication }
  }
  if (isTerminalCycleState(existing.state)) {
    return { _tag: 'TERMINAL', cycle: existing }
  }
  return existing.bindings.snapshotId === undefined
    ? { _tag: 'RESUME', publication, cycle: existing }
    : { _tag: 'ALREADY_ACQUIRED', publication, cycle: existing }
}

const beginCycleAuthoritySelection = (slot: CycleAuthoritySlot): CycleAuthoritySelectionReduction => {
  const decision = classifyCycleAuthoritySlot(slot.publication, slot.existing)
  switch (decision._tag) {
    case 'UNCLAIMED':
      return {
        _tag: 'CONTINUE',
        state: { _tag: 'UNCLAIMED', publications: [decision.publication], latestTerminal: undefined },
      }
    case 'TERMINAL':
      return { _tag: 'CONTINUE', state: { _tag: 'TERMINAL', latestTerminal: decision.cycle } }
    case 'RESUME':
    case 'ALREADY_ACQUIRED':
      return decision
  }
}

const reduceCycleAuthoritySelection = (
  state: CycleAuthoritySelectionState,
  slot: CycleAuthoritySlot,
): CycleAuthoritySelectionReduction => {
  const decision = classifyCycleAuthoritySlot(slot.publication, slot.existing)
  switch (decision._tag) {
    case 'UNCLAIMED':
      return {
        _tag: 'CONTINUE',
        state:
          state._tag === 'UNCLAIMED'
            ? { ...state, publications: [...state.publications, decision.publication] }
            : { _tag: 'UNCLAIMED', publications: [decision.publication], latestTerminal: state.latestTerminal },
      }
    case 'TERMINAL':
      return {
        _tag: 'CONTINUE',
        state:
          state._tag === 'UNCLAIMED' && state.latestTerminal === undefined
            ? { ...state, latestTerminal: decision.cycle }
            : state,
      }
    case 'RESUME':
    case 'ALREADY_ACQUIRED':
      return decision
  }
}

const completeCycleAuthoritySelection = (state: CycleAuthoritySelectionState): CycleAuthoritySelection =>
  state._tag === 'UNCLAIMED'
    ? { _tag: 'READ_CALENDAR', publications: state.publications }
    : { _tag: 'ALREADY_TERMINAL', cycle: state.latestTerminal }

export const selectCycleAuthoritySlots = (slots: NonEmptyAuthoritySlots): CycleAuthoritySelection => {
  const [first, ...remaining] = slots
  const initial = beginCycleAuthoritySelection(first)
  if (initial._tag !== 'CONTINUE') return initial
  let state = initial.state
  for (const slot of remaining) {
    const reduction = reduceCycleAuthoritySelection(state, slot)
    if (reduction._tag !== 'CONTINUE') return reduction
    state = reduction.state
  }
  return completeCycleAuthoritySelection(state)
}

type CycleNotDueResult = Extract<CycleRunResult, { readonly outcome: 'NOT_DUE' }>

interface CycleAcquireMaterial {
  readonly publication: MarketDataInspection
  readonly draft: CycleDraft
  readonly signalSessionDate: string
  readonly executionSessionDate: string
  readonly calendarResponseHash: string
  readonly calendarReadContentHash: string
}

type CycleCalendarCandidateDecision =
  | {
      readonly _tag: 'NOT_DUE'
      readonly result: CycleNotDueResult
    }
  | {
      readonly _tag: 'ACQUIRE'
      readonly material: CycleAcquireMaterial
    }

type CycleCalendarCandidateFailure =
  | {
      readonly _tag: 'CycleExecutionSessionUnavailable'
      readonly signalSessionDate: string
    }
  | {
      readonly _tag: 'CycleDraftConstructionFailed'
      readonly signalSessionDate: string
      readonly cause: CycleConstructionFailure
    }

const selectCycleCalendarPublication = (
  context: CycleRunContext,
  publication: MarketDataInspection,
  observation: MarketCalendarObservation,
  calendarReadContentHash: string,
  observedAt: string,
): Result.Result<CycleCalendarCandidateDecision, CycleCalendarCandidateFailure> => {
  const candidate: CycleCandidate = {
    qualificationRunId: context.qualificationRunId,
    strategyProtocolHash: context.strategyProtocolHash,
    accountId: context.accountId,
    signalSession: publication.signalSession,
    executionPolicy: context.executionPolicy,
  }
  const signalSessionDate = candidate.signalSession.session_date
  const executionSession = selectNextExecutionSession(signalSessionDate, observation)
  if (executionSession === undefined) {
    return Result.fail({ _tag: 'CycleExecutionSessionUnavailable', signalSessionDate })
  }
  const common = {
    signalSessionDate,
    executionSessionDate: executionSession.date,
    calendarResponseHash: observation.normalizedResponseHash,
    calendarReadContentHash,
  } as const
  return Result.map(
    Result.mapError(
      makeDueCycleDraft(candidate, observation, executionSession),
      (cause): CycleCalendarCandidateFailure => ({
        _tag: 'CycleDraftConstructionFailed',
        signalSessionDate,
        cause,
      }),
    ),
    (draft): CycleCalendarCandidateDecision =>
      draft === undefined
        ? { _tag: 'NOT_DUE', result: { outcome: 'NOT_DUE', observedAt, ...common } }
        : { _tag: 'ACQUIRE', material: { publication, draft, ...common } },
  )
}

export const selectCycleCalendarCandidate = (
  context: CycleRunContext,
  publications: NonEmptyPublications,
  observation: MarketCalendarObservation,
  calendarReadContentHash: string,
  observedAt: string,
): Result.Result<CycleCalendarCandidateDecision, CycleCalendarCandidateFailure> => {
  const [first, ...remaining] = publications
  const firstDecision = selectCycleCalendarPublication(context, first, observation, calendarReadContentHash, observedAt)
  if (Result.isFailure(firstDecision) || firstDecision.success._tag === 'ACQUIRE') return firstDecision
  for (const publication of remaining) {
    const decision = selectCycleCalendarPublication(
      context,
      publication,
      observation,
      calendarReadContentHash,
      observedAt,
    )
    if (Result.isFailure(decision) || decision.success._tag === 'ACQUIRE') return decision
  }
  return firstDecision
}

const publicationFailureError = (cause: CyclePublicationFailure): CycleRunnerError =>
  runnerError('inspect-publication', 'contract', 'bounded cycle publication discovery is invalid', cause)

const calendarQueryFailureError = (cause: CycleCalendarQueryFailure): CycleRunnerError =>
  runnerError('market-calendar', 'contract', 'cycle calendar query construction failed', cause)

const calendarCandidateFailureError = (cause: CycleCalendarCandidateFailure): CycleRunnerError => {
  switch (cause._tag) {
    case 'CycleExecutionSessionUnavailable':
      return runnerError(
        'select-session',
        'calendar-unavailable',
        `broker calendar has no trading session after ${cause.signalSessionDate}`,
        cause,
      )
    case 'CycleDraftConstructionFailed':
      return runnerError('build-cycle', 'contract', 'autonomous cycle draft construction failed', cause)
  }
}

const readCycleAuthoritySlots = (
  context: CycleRunContext,
  publications: NonEmptyPublications,
): Effect.Effect<CycleAuthoritySelection, CycleRunnerError, CycleStore> =>
  Effect.gen(function* () {
    const store = yield* CycleStore
    const readSlot = (publication: MarketDataInspection) => {
      const signalSessionDate = publication.signalSession.session_date
      return store
        .readAuthoritySlot({
          qualificationRunId: context.qualificationRunId,
          accountId: context.accountId,
          signalSessionDate,
        })
        .pipe(
          Effect.mapError((cause) =>
            runnerError('read-authority-slot', 'store', 'durable autonomous cycle authority-slot read failed', cause),
          ),
          Effect.map(
            (existing): CycleAuthoritySlot => ({
              publication,
              existing: Option.match(existing, {
                onNone: () => undefined,
                onSome: (cycle) => cycle,
              }),
            }),
          ),
        )
    }

    const [firstPublication, ...remainingPublications] = publications
    const initial = beginCycleAuthoritySelection(yield* readSlot(firstPublication))
    if (initial._tag !== 'CONTINUE') return initial

    let state = initial.state
    for (const publication of remainingPublications) {
      const reduction = reduceCycleAuthoritySelection(state, yield* readSlot(publication))
      if (reduction._tag !== 'CONTINUE') return reduction
      state = reduction.state
    }
    return completeCycleAuthoritySelection(state)
  })

const resumeDiscoveredPublication = (
  selection: Extract<CycleAuthoritySelection, { readonly _tag: 'RESUME' }>,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore> =>
  Effect.gen(function* () {
    const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const readiness = yield* bindDiscoveredPublication(selection.cycle, selection.publication, observedAt)
    return {
      outcome: 'RESUMED',
      signalSessionDate: selection.publication.signalSession.session_date,
      observedAt,
      readiness,
    }
  })

const acquireCycleCandidate = (
  material: CycleAcquireMaterial,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore> =>
  Effect.gen(function* () {
    const store = yield* CycleStore
    const acquiredAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const receipt = yield* store
      .acquire(material.draft, acquiredAt)
      .pipe(
        Effect.mapError((cause) =>
          runnerError('acquire-cycle', 'store', 'durable autonomous cycle acquisition failed', cause),
        ),
      )
    const bindingObservedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    const readiness = yield* bindDiscoveredPublication(receipt.cycle, material.publication, bindingObservedAt)
    return {
      outcome: receipt.created ? 'ACQUIRED' : 'REACQUIRED',
      signalSessionDate: material.signalSessionDate,
      executionSessionDate: material.executionSessionDate,
      observedAt: bindingObservedAt,
      calendarResponseHash: material.calendarResponseHash,
      calendarReadContentHash: material.calendarReadContentHash,
      receipt,
      readiness,
    }
  })

const interpretCycleCalendar = (
  context: CycleRunContext,
  publications: NonEmptyPublications,
  observation: MarketCalendarObservation,
  calendarReadContentHash: string,
  observedAt: string,
): Effect.Effect<CycleRunResult, CycleRunnerError, CycleStore> =>
  Effect.fromResult(
    selectCycleCalendarCandidate(context, publications, observation, calendarReadContentHash, observedAt),
  ).pipe(
    Effect.mapError(calendarCandidateFailureError),
    Effect.flatMap((decision) =>
      decision._tag === 'NOT_DUE' ? Effect.succeed(decision.result) : acquireCycleCandidate(decision.material),
    ),
  )

const readCycleCalendar = (
  context: CycleRunContext,
  publications: NonEmptyPublications,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore> =>
  Effect.gen(function* () {
    const query = yield* Effect.fromResult(marketCalendarQueryForPublications(publications)).pipe(
      Effect.mapError(calendarQueryFailureError),
    )
    const broker = yield* BrokerRead
    const calendar = yield* broker
      .marketCalendar(query)
      .pipe(
        Effect.mapError((cause) =>
          runnerError('market-calendar', 'calendar-read', 'authoritative broker calendar read failed', cause),
        ),
      )
    const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
    return yield* interpretCycleCalendar(
      context,
      publications,
      calendar.value,
      calendar.evidence.contentHash,
      observedAt,
    )
  })

const interpretCycleAuthoritySelection = (
  context: CycleRunContext,
  selection: CycleAuthoritySelection,
  discoveryObservedAt: string,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore> => {
  switch (selection._tag) {
    case 'RESUME':
      return resumeDiscoveredPublication(selection)
    case 'ALREADY_ACQUIRED':
      return Effect.succeed({
        outcome: 'ALREADY_ACQUIRED',
        signalSessionDate: selection.publication.signalSession.session_date,
        observedAt: discoveryObservedAt,
        cycle: selection.cycle,
      })
    case 'ALREADY_TERMINAL':
      return Effect.succeed({
        outcome: 'ALREADY_TERMINAL',
        signalSessionDate: selection.cycle.identity.signalSessionDate,
        observedAt: discoveryObservedAt,
        cycle: selection.cycle,
      })
    case 'READ_CALENDAR':
      return readCycleCalendar(context, selection.publications)
  }
}

export const discoverAutonomousCyclePass = (
  context: CycleRunContext,
): Effect.Effect<CycleRunResult, CycleRunnerError, BrokerRead | CycleStore | MarketData> =>
  Effect.gen(function* () {
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
    const firstPublication = discovery.publications[0]
    if (firstPublication === undefined) {
      return yield* Effect.fail(
        runnerError(
          'inspect-publication',
          'contract',
          'FINALIZED cycle publication discovery must contain a publication',
        ),
      )
    }
    const publications = yield* Effect.fromResult(
      boundedCyclePublications([firstPublication, ...discovery.publications.slice(1)]),
    ).pipe(Effect.mapError(publicationFailureError))
    const selection = yield* readCycleAuthoritySlots(context, publications)
    return yield* interpretCycleAuthoritySelection(context, selection, discovery.observedAt)
  })

const chooseRecovery = (state: CycleRecoveryState): Effect.Effect<CycleRecoverySelection, CycleRunnerError> =>
  Effect.fromResult(selectCycleRecovery(state)).pipe(
    Effect.mapError((cause) =>
      runnerError('recover-cycle', 'contract', 'autonomous cycle recovery state is invalid', cause),
    ),
  )

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
    case 'WAIT':
      return Effect.succeed({
        outcome: 'RECOVERED',
        action: 'WAITING',
        observedAt: selection.observedAt,
        cycle: selection.cycle,
      })
    case 'BUILD_DECISION':
      return context.buildDecision(selection.cycle).pipe(
        Effect.mapError((cause) => runnerError('build-decision', cause.failure, cause.message, cause)),
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
        const decisionObservedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
        const next = yield* chooseRecovery({
          qualificationRunId: context.qualificationRunId,
          accountId: context.accountId,
          strategyProtocolHash: context.strategyProtocolHash,
          observedAt: decisionObservedAt,
          cycle: selection.cycle,
          decisionDocument: Option.match(document, {
            onNone: () => null,
            onSome: (value) => value,
          }),
        })
        return yield* recoverCycle(next, context, decisionObservedAt)
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

interface CyclePassLogFacts {
  readonly level: 'INFO' | 'ERROR'
  readonly message: string
  readonly annotations: Readonly<Partial<Record<string, string | boolean>>>
}

export const cyclePassLogFacts = (observation: CyclePassObservation): CyclePassLogFacts => {
  if (observation.outcome === 'FAILED') {
    return {
      level: 'ERROR',
      message: 'Bayn autonomous cycle pass failed',
      annotations: {
        operation: observation.error.operation,
        failure: observation.error.failure,
        message: observation.error.message,
      },
    }
  }
  const result = observation.result
  switch (result.outcome) {
    case 'NO_PUBLICATION':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: { outcome: result.outcome, observedAt: result.observedAt },
      }
    case 'ALREADY_ACQUIRED':
    case 'ALREADY_TERMINAL':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          signalSessionDate: result.signalSessionDate,
          observedAt: result.observedAt,
          cycleId: result.cycle.identity.cycleId,
          cycleState: result.cycle.state,
        },
      }
    case 'RESUMED':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          signalSessionDate: result.signalSessionDate,
          observedAt: result.observedAt,
          cycleId: result.readiness.cycle.identity.cycleId,
          cycleState: result.readiness.cycle.state,
          publicationReadiness: result.readiness.outcome,
        },
      }
    case 'RECOVERED':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          recoveryAction: result.action,
          observedAt: result.observedAt,
          cycleId: result.cycle.identity.cycleId,
          cycleState: result.cycle.state,
        },
      }
    case 'NOT_DUE':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
          outcome: result.outcome,
          signalSessionDate: result.signalSessionDate,
          executionSessionDate: result.executionSessionDate,
          observedAt: result.observedAt,
          calendarResponseHash: result.calendarResponseHash,
          calendarReadContentHash: result.calendarReadContentHash,
        },
      }
    case 'ACQUIRED':
    case 'REACQUIRED':
      return {
        level: 'INFO',
        message: 'Bayn autonomous cycle pass completed',
        annotations: {
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
        },
      }
  }
}

const logCyclePass = (observation: CyclePassObservation): Effect.Effect<void> => {
  const facts = cyclePassLogFacts(observation)
  const log = facts.level === 'INFO' ? Effect.logInfo(facts.message) : Effect.logError(facts.message)
  return log.pipe(Effect.annotateLogs(facts.annotations))
}

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
): Effect.Effect<Effect.Effect<void, never, BrokerRead | CycleStore | MarketData | R>, CycleRunnerError> => {
  if (!Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    return Effect.fail(
      runnerError('configure', 'invalid-config', 'cycle loop interval must be a positive safe integer'),
    )
  }
  return Effect.succeed(
    runLoopPass(options.context).pipe(
      Effect.flatMap((result) =>
        observationTime.pipe(
          Effect.flatMap((observedAt) => {
            const observation: CyclePassObservation = { outcome: 'SUCCEEDED', observedAt, result }
            return options.observePass(observation).pipe(Effect.andThen(logCyclePass(observation)))
          }),
        ),
      ),
      Effect.catch((error) =>
        observationTime.pipe(
          Effect.flatMap((observedAt) => {
            const observation: CyclePassObservation = { outcome: 'FAILED', observedAt, error }
            return options.observePass(observation).pipe(Effect.andThen(logCyclePass(observation)))
          }),
        ),
      ),
      Effect.repeat(Schedule.spaced(Duration.millis(options.pollIntervalMs))),
      Effect.asVoid,
    ),
  )
}
