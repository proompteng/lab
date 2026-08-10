import { pipe, Result } from 'effect'

import type { MarketCalendarObservation } from '../broker/alpaca'
import type { CycleConstructionFailure, CycleDraft } from '../cycle'
import type { FinalizedPublicationDiscovery, MarketDataInspection } from '../market-data'
import {
  boundedCyclePublications,
  makeDueCycleDraft,
  selectNextExecutionSession,
  type CycleCalendarQueryFailure,
  type CyclePublicationFailure,
  type NonEmptyPublications,
} from './calendar-decisions'
import {
  runnerError,
  type CycleCandidate,
  type CycleRunContext,
  type CycleRunnerError,
  type CycleRunResult,
} from './model'
import { Pipeable } from '../pipeable'

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
  | { readonly _tag: 'NOT_DUE'; readonly result: CycleNotDueResult }
  | { readonly _tag: 'ACQUIRE'; readonly material: CycleAcquireMaterial }

type CycleCalendarCandidateFailure =
  | { readonly _tag: 'CycleExecutionSessionUnavailable'; readonly signalSessionDate: string }
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
    ...(context.cadence === undefined ? {} : { cadence: context.cadence }),
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
      (cause): CycleCalendarCandidateFailure => ({ _tag: 'CycleDraftConstructionFailed', signalSessionDate, cause }),
    ),
    (draft): CycleCalendarCandidateDecision =>
      draft === undefined
        ? { _tag: 'NOT_DUE', result: { outcome: 'NOT_DUE', observedAt, ...common } }
        : { _tag: 'ACQUIRE', material: { publication, draft, ...common } },
  )
}

const selectCycleCalendarCandidateDataFirst = <R>(
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

export const selectCycleCalendarCandidate = Pipeable.generic<
  <R>(
    publications: NonEmptyPublications,
    observation: MarketCalendarObservation,
    calendarReadContentHash: string,
    observedAt: string,
  ) => (context: CycleRunContext<R>) => Result.Result<CycleCalendarCandidateDecision, CycleCalendarCandidateFailure>,
  typeof selectCycleCalendarCandidateDataFirst
>(5, selectCycleCalendarCandidateDataFirst)

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
  | { readonly _tag: 'PUBLICATIONS'; readonly observedAt: string; readonly publications: NonEmptyPublications }

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
    Result.map((publications) => ({ _tag: 'PUBLICATIONS' as const, observedAt: discovery.observedAt, publications })),
  )
}
