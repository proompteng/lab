import { pipe, Result } from 'effect'

import type { MarketCalendarObservation } from '../../broker/alpaca'
import type { FinalizedPublicationDiscovery, MarketDataInspection } from '../../market-data'
import type { CycleConstructionFailure } from '../construction'
import type { CycleDraft } from '../model'
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
  CycleNotDueReason,
  type CycleCandidate,
  type CycleRunContext,
  type CycleRunnerError,
  type CycleRunResult,
} from './model'
type CycleNotDueResult = Extract<CycleRunResult, { readonly outcome: 'NOT_DUE' }>

export interface CycleAcquireMaterial {
  readonly publication: MarketDataInspection
  readonly draft: CycleDraft
  readonly signalSessionDate: string
  readonly executionSessionDate: string
  readonly calendarResponseHash: string
  readonly calendarReadContentHash: string
}

export type CycleCalendarCandidateDecision =
  | { readonly _tag: 'NOT_DUE'; readonly result: CycleNotDueResult }
  | { readonly _tag: 'ACQUIRE'; readonly material: CycleAcquireMaterial }

type CycleCalendarCandidateFailure =
  | { readonly _tag: 'CycleExecutionSessionUnavailable'; readonly signalSessionDate: string }
  | {
      readonly _tag: 'CycleDraftConstructionFailed'
      readonly signalSessionDate: string
      readonly cause: CycleConstructionFailure
    }

const stalePaperBootstrapResult = (material: CycleAcquireMaterial, observedAt: string): CycleNotDueResult => ({
  outcome: 'NOT_DUE',
  reason: CycleNotDueReason.StalePaperBootstrap,
  signalSessionDate: material.signalSessionDate,
  executionSessionDate: material.executionSessionDate,
  observedAt,
  calendarResponseHash: material.calendarResponseHash,
  calendarReadContentHash: material.calendarReadContentHash,
})

export const selectCycleAcquisition = (
  cadence: CycleRunContext['cadence'],
  material: CycleAcquireMaterial,
  acquiredAt: string,
): CycleCalendarCandidateDecision =>
  cadence === 'PAPER_BOOTSTRAP' && acquiredAt >= material.draft.window.publicationDeadlineAt
    ? { _tag: 'NOT_DUE', result: stalePaperBootstrapResult(material, acquiredAt) }
    : { _tag: 'ACQUIRE', material }

const selectCycleCalendarPublication = <R>(
  context: CycleRunContext<R>,
  publication: MarketDataInspection,
  observation: MarketCalendarObservation,
  calendarReadContentHash: string,
  observedAt: string,
  knownMissedPaperBootstrap: boolean,
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
    (draft): CycleCalendarCandidateDecision => {
      if (draft === undefined) {
        return {
          _tag: 'NOT_DUE',
          result: { outcome: 'NOT_DUE', reason: CycleNotDueReason.MonthEndCadence, observedAt, ...common },
        }
      }
      const material = { publication, draft, ...common }
      if (context.cadence === 'PAPER_BOOTSTRAP' && knownMissedPaperBootstrap) {
        return { _tag: 'NOT_DUE', result: stalePaperBootstrapResult(material, observedAt) }
      }
      return selectCycleAcquisition(context.cadence, material, observedAt)
    },
  )
}

const selectCycleCalendarCandidateDataFirst = <R>(
  context: CycleRunContext<R>,
  publications: NonEmptyPublications,
  observation: MarketCalendarObservation,
  calendarReadContentHash: string,
  observedAt: string,
  knownMissedPaperBootstrap = false,
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
                selectCycleCalendarPublication(
                  context,
                  publication,
                  observation,
                  calendarReadContentHash,
                  observedAt,
                  knownMissedPaperBootstrap,
                ),
                Result.map((next) => (next._tag === 'ACQUIRE' ? next : current)),
              ),
        ),
      ),
    selectCycleCalendarPublication(
      context,
      first,
      observation,
      calendarReadContentHash,
      observedAt,
      knownMissedPaperBootstrap,
    ),
  )
}

export const selectCycleCalendarCandidate = selectCycleCalendarCandidateDataFirst

export const publicationFailureError = (cause: CyclePublicationFailure): CycleRunnerError =>
  runnerError({
    operation: 'inspect-publication',
    failure: 'contract',
    message: 'bounded cycle publication discovery is invalid',
    cause,
  })

export const calendarQueryFailureError = (cause: CycleCalendarQueryFailure): CycleRunnerError =>
  runnerError({
    operation: 'market-calendar',
    failure: 'contract',
    message: 'cycle calendar query construction failed',
    cause,
  })

export const calendarCandidateFailureError = (cause: CycleCalendarCandidateFailure): CycleRunnerError => {
  switch (cause._tag) {
    case 'CycleExecutionSessionUnavailable':
      return runnerError({
        operation: 'select-session',
        failure: 'calendar-unavailable',
        message: `broker calendar has no trading session after ${cause.signalSessionDate}`,
        cause,
      })
    case 'CycleDraftConstructionFailed':
      return runnerError({
        operation: 'build-cycle',
        failure: 'contract',
        message: 'autonomous cycle draft construction failed',
        cause,
      })
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
      runnerError({
        operation: 'inspect-publication',
        failure: 'contract',
        message: 'FINALIZED cycle publication discovery must contain a publication',
      }),
    )
  }
  return pipe(
    boundedCyclePublications([firstPublication, ...remainingPublications]),
    Result.mapError(publicationFailureError),
    Result.map((publications) => ({ _tag: 'PUBLICATIONS' as const, observedAt: discovery.observedAt, publications })),
  )
}
