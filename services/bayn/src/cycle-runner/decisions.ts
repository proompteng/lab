import { HashSet, pipe, Result } from 'effect'

import type { MarketCalendarObservation, MarketCalendarQuery, MarketCalendarSession } from '../broker/alpaca'
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
} from '../cycle'
import type { CycleReadinessError } from '../cycle-readiness'
import type { CycleRecoverySelection } from '../cycle-recovery'
import type { FinalizedPublicationDiscovery, MarketDataInspection } from '../market-data'
import {
  runnerError,
  type CycleCandidate,
  type CyclePassObservation,
  type CycleRunContext,
  type CycleRunnerError,
  type CycleRunResult,
} from './model'

const calendarRangeDays = 31
// This leaves at least 10 calendar days after the newest candidate inside Alpaca's 31-day observation bound.
const publicationCatchUpRangeDays = 21
const millisecondsPerDay = 86_400_000

export type NonEmptyReadonlyArray<A> = readonly [A, ...A[]]
export type NonEmptyPublications = NonEmptyReadonlyArray<MarketDataInspection>

interface CyclePublicationDateInput {
  readonly signalSession: {
    readonly session_date: string
  }
}

type IsoDateShiftCause =
  | {
      readonly _tag: 'IsoDateInputInvalid'
      readonly date: string
      readonly epochMillis: number
    }
  | {
      readonly _tag: 'IsoDateInputNotCanonical'
      readonly date: string
      readonly normalized: string
    }
  | {
      readonly _tag: 'IsoDateOffsetInvalid'
      readonly date: string
      readonly days: number
    }
  | {
      readonly _tag: 'IsoDateShiftEpochOutOfRange'
      readonly date: string
      readonly days: number
      readonly epochMillis: number
    }
  | {
      readonly _tag: 'IsoDateShiftResultOutOfRange'
      readonly date: string
      readonly days: number
      readonly shifted: string
    }

type IsoDateShiftFailure = {
  readonly _tag: 'IsoDateShiftOutOfRange'
  readonly date: string
  readonly days: number
  readonly cause: IsoDateShiftCause
}

type CyclePublicationFailure =
  | {
      readonly _tag: 'CyclePublicationDateInvalid'
      readonly signalSessionDate: string
      readonly cause: IsoDateShiftCause
    }
  | {
      readonly _tag: 'CyclePublicationDuplicate'
      readonly signalSessionDate: string
    }
  | {
      readonly _tag: 'CyclePublicationRangeOutOfRange'
      readonly signalSessionDate: string
      readonly offsetDays: number
      readonly cause: IsoDateShiftCause
    }

type CycleCalendarQueryFailure = {
  readonly _tag: 'CycleCalendarQueryRangeOutOfRange'
  readonly signalSessionDate: string
  readonly offsetDays: number
  readonly cause: IsoDateShiftCause
}

const shiftIsoDate = (date: string, days: number): Result.Result<string, IsoDateShiftFailure> => {
  const failure = (cause: IsoDateShiftCause): Result.Result<never, IsoDateShiftFailure> =>
    Result.fail({
      _tag: 'IsoDateShiftOutOfRange',
      date,
      days,
      cause,
    })

  if (!Number.isSafeInteger(days)) return failure({ _tag: 'IsoDateOffsetInvalid', date, days })

  const inputDate = new Date(`${date}T00:00:00.000Z`)
  const inputEpochMillis = inputDate.getTime()
  if (!Number.isFinite(inputEpochMillis)) {
    return failure({ _tag: 'IsoDateInputInvalid', date, epochMillis: inputEpochMillis })
  }

  const input = inputDate.toISOString()
  if (input !== `${date}T00:00:00.000Z`) {
    return failure({ _tag: 'IsoDateInputNotCanonical', date, normalized: input })
  }

  const shiftedEpochMillis = inputEpochMillis + days * millisecondsPerDay
  const shiftedDateValue = new Date(shiftedEpochMillis)
  if (!Number.isFinite(shiftedDateValue.getTime())) {
    return failure({ _tag: 'IsoDateShiftEpochOutOfRange', date, days, epochMillis: shiftedEpochMillis })
  }

  const shifted = shiftedDateValue.toISOString()
  const shiftedDate = shifted.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(shiftedDate) && shifted === `${shiftedDate}T00:00:00.000Z`
    ? Result.succeed(shiftedDate)
    : failure({ _tag: 'IsoDateShiftResultOutOfRange', date, days, shifted })
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
  const validated = Result.all(
    publications.map((publication): Result.Result<Publication, CyclePublicationFailure> => {
      const signalSessionDate = publication.signalSession.session_date
      return pipe(
        shiftIsoDate(signalSessionDate, 0),
        Result.mapError(
          (failure): CyclePublicationFailure => ({
            _tag: 'CyclePublicationDateInvalid',
            signalSessionDate,
            cause: failure.cause,
          }),
        ),
        Result.map(() => publication),
      )
    }),
  )
  return pipe(
    validated,
    Result.flatMap((validated) =>
      validated.reduce<Result.Result<HashSet.HashSet<string>, CyclePublicationFailure>>(
        (seen, publication) =>
          pipe(
            seen,
            Result.flatMap((sessionDates) => {
              const signalSessionDate = publication.signalSession.session_date
              return HashSet.has(sessionDates, signalSessionDate)
                ? Result.fail({
                    _tag: 'CyclePublicationDuplicate',
                    signalSessionDate,
                  } satisfies CyclePublicationFailure)
                : Result.succeed(HashSet.add(sessionDates, signalSessionDate))
            }),
          ),
        Result.succeed(HashSet.empty()),
      ),
    ),
    Result.flatMap(() => {
      const latestPublication = publications.reduce((latest, publication) =>
        publication.signalSession.session_date > latest.signalSession.session_date ? publication : latest,
      )
      const latest = latestPublication.signalSession.session_date
      const offsetDays = -(publicationCatchUpRangeDays - 1)
      return pipe(
        shiftIsoDate(latest, offsetDays),
        Result.map(
          (earliest): NonEmptyReadonlyArray<Publication> => [
            latestPublication,
            ...publications
              .filter((publication) => {
                const sessionDate = publication.signalSession.session_date
                return sessionDate !== latest && sessionDate >= earliest
              })
              .toSorted((left, right) =>
                right.signalSession.session_date.localeCompare(left.signalSession.session_date),
              ),
          ],
        ),
        Result.mapError(
          (failure): CyclePublicationFailure => ({
            _tag: 'CyclePublicationRangeOutOfRange',
            signalSessionDate: latest,
            offsetDays,
            cause: failure.cause,
          }),
        ),
      )
    }),
  )
}

export const selectNextExecutionSession = (
  signalSessionDate: string,
  observation: MarketCalendarObservation,
): MarketCalendarSession | undefined =>
  observation.sessions.reduce<MarketCalendarSession | undefined>(
    (selected, session) =>
      session.date > signalSessionDate && (selected === undefined || session.date < selected.date) ? session : selected,
    undefined,
  )

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

export interface CycleAuthoritySlot {
  readonly publication: MarketDataInspection
  readonly existing: AutonomousCycle | undefined
}

type NonEmptyAuthoritySlots = readonly [CycleAuthoritySlot, ...CycleAuthoritySlot[]]

export type CycleAuthoritySelection =
  | Extract<CycleAuthoritySlotDecision, { readonly _tag: 'RESUME' | 'ALREADY_ACQUIRED' }>
  | {
      readonly _tag: 'READ_CALENDAR'
      readonly publications: NonEmptyPublications
    }
  | {
      readonly _tag: 'ALREADY_TERMINAL'
      readonly cycle: AutonomousCycle
    }

export type CycleAuthoritySelectionState =
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

export const beginCycleAuthoritySelection = (slot: CycleAuthoritySlot): CycleAuthoritySelectionReduction => {
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

export const reduceCycleAuthoritySelection = (
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

export const completeCycleAuthoritySelection = (state: CycleAuthoritySelectionState): CycleAuthoritySelection =>
  state._tag === 'UNCLAIMED'
    ? { _tag: 'READ_CALENDAR', publications: state.publications }
    : { _tag: 'ALREADY_TERMINAL', cycle: state.latestTerminal }

export const selectCycleAuthoritySlots = (slots: NonEmptyAuthoritySlots): CycleAuthoritySelection => {
  const [first, ...remaining] = slots
  const reduction = remaining.reduce<CycleAuthoritySelectionReduction>(
    (current, slot) => (current._tag === 'CONTINUE' ? reduceCycleAuthoritySelection(current.state, slot) : current),
    beginCycleAuthoritySelection(first),
  )
  return reduction._tag === 'CONTINUE' ? completeCycleAuthoritySelection(reduction.state) : reduction
}

type CycleNotDueResult = Extract<CycleRunResult, { readonly outcome: 'NOT_DUE' }>

export interface CycleAcquireMaterial {
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

const selectCycleCalendarPublication = <R>(
  context: CycleRunContext<R>,
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

export const selectCycleCalendarCandidate = <R>(
  context: CycleRunContext<R>,
  publications: NonEmptyPublications,
  observation: MarketCalendarObservation,
  calendarReadContentHash: string,
  observedAt: string,
): Result.Result<CycleCalendarCandidateDecision, CycleCalendarCandidateFailure> => {
  const [first, ...remaining] = publications
  return remaining.reduce<Result.Result<CycleCalendarCandidateDecision, CycleCalendarCandidateFailure>>(
    (decision, publication) =>
      pipe(
        decision,
        Result.flatMap((current) =>
          current._tag === 'ACQUIRE'
            ? Result.succeed(current)
            : pipe(
                selectCycleCalendarPublication(context, publication, observation, calendarReadContentHash, observedAt),
                Result.map((next) => (next._tag === 'ACQUIRE' ? next : current)),
              ),
        ),
      ),
    selectCycleCalendarPublication(context, first, observation, calendarReadContentHash, observedAt),
  )
}

export const publicationFailureError = (cause: CyclePublicationFailure): CycleRunnerError =>
  runnerError('inspect-publication', 'contract', 'bounded cycle publication discovery is invalid', cause)

export const calendarQueryFailureError = (cause: CycleCalendarQueryFailure): CycleRunnerError =>
  runnerError('market-calendar', 'contract', 'cycle calendar query construction failed', cause)

export const calendarCandidateFailureError = (cause: CycleCalendarCandidateFailure): CycleRunnerError => {
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

export type CycleDiscoveryDecision =
  | {
      readonly _tag: 'NO_PUBLICATION'
      readonly result: Extract<CycleRunResult, { readonly outcome: 'NO_PUBLICATION' }>
    }
  | {
      readonly _tag: 'PUBLICATIONS'
      readonly observedAt: string
      readonly publications: NonEmptyPublications
    }

export const selectDiscoveredPublications = (
  discovery: FinalizedPublicationDiscovery,
): Result.Result<CycleDiscoveryDecision, CycleRunnerError> => {
  if (discovery.outcome === 'MISSING') {
    return Result.succeed({
      _tag: 'NO_PUBLICATION',
      result: { outcome: 'NO_PUBLICATION', observedAt: discovery.observedAt },
    })
  }
  const [firstPublication, ...remainingPublications] = discovery.publications
  if (firstPublication === undefined) {
    return Result.fail(
      runnerError(
        'inspect-publication',
        'contract',
        'FINALIZED cycle publication discovery must contain a publication',
      ),
    )
  }
  return pipe(
    boundedCyclePublications([firstPublication, ...remainingPublications]),
    Result.mapError(publicationFailureError),
    Result.map((publications) => ({
      _tag: 'PUBLICATIONS' as const,
      observedAt: discovery.observedAt,
      publications,
    })),
  )
}

export const readinessFailure = (cause: CycleReadinessError): CycleRunnerError['failure'] => {
  switch (cause.failure) {
    case 'store':
      return 'store'
    case 'market-data':
      return 'market-data'
    case 'contract':
      return 'contract'
  }
}

export const finishRecoveryResult = (
  selection: Extract<CycleRecoverySelection, { readonly action: 'FINISH' }>,
  cycle: AutonomousCycle,
): Result.Result<CycleRunResult, CycleRunnerError> => {
  const result = (
    action: Extract<CycleRunResult, { readonly outcome: 'RECOVERED' }>['action'],
  ): Result.Result<CycleRunResult, CycleRunnerError> =>
    Result.succeed({
      outcome: 'RECOVERED',
      action,
      observedAt: selection.observedAt,
      cycle,
    })
  switch (cycle.state) {
    case CycleState.Completed:
      return result('COMPLETED')
    case CycleState.NoTrade:
      return result('NO_TRADE')
    case CycleState.Blocked:
      return result('BLOCKED')
    default:
      return Result.fail(runnerError('recover-cycle', 'contract', 'cycle finish did not produce a terminal state'))
  }
}

export interface CyclePassLogFacts {
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

export const validateCycleLoopInterval = (pollIntervalMs: number): Result.Result<number, CycleRunnerError> =>
  Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0
    ? Result.succeed(pollIntervalMs)
    : Result.fail(runnerError('configure', 'invalid-config', 'cycle loop interval must be a positive safe integer'))
