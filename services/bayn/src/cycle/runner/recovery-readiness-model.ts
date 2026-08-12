import { Result } from 'effect'

import type { MarketDataInspection } from '../../market-data'
import { Pipeable } from '../../pipeable'
import { signalSessionCloseAt, type CycleConstructionFailure } from '../construction'
import type { AutonomousCycle } from '../model'

export interface PublicationFreshness {
  readonly dataAgeMs: number
  readonly publicationDelayMs: number
}

export type CyclePublicationReadiness =
  | {
      readonly outcome: 'WAITING'
      readonly reason: 'SIGNAL_SESSION_OPEN' | 'PUBLICATION_MISSING'
      readonly observedAt: string
      readonly cycle: AutonomousCycle
    }
  | {
      readonly outcome: 'BOUND' | 'ALREADY_BOUND'
      readonly observedAt: string
      readonly cycle: AutonomousCycle
      readonly snapshotId: string
      readonly freshness?: PublicationFreshness
    }
  | {
      readonly outcome: 'BLOCKED'
      readonly observedAt: string
      readonly cycle: AutonomousCycle
    }

export type PublicationFreshnessFailure =
  | {
      readonly _tag: 'PublicationSessionMismatch'
      readonly expectedSessionDate: string
      readonly observedAsOfSession: string
      readonly observedLastSession: string
    }
  | {
      readonly _tag: 'PublicationCalendarMismatch'
      readonly expectedCalendarVersion: string
      readonly observedCalendarVersion: string
    }
  | {
      readonly _tag: 'PublicationSignalSessionMismatch'
      readonly expectedSessionDate: string
      readonly expectedCalendarVersion: string
      readonly observedSessionDate: string
      readonly observedCalendarVersion: string
    }
  | {
      readonly _tag: 'PublicationSignalCloseInvalid'
      readonly cause: CycleConstructionFailure
    }
  | {
      readonly _tag: 'PublicationSignalCloseMismatch'
      readonly expectedSignalCloseAt: string
      readonly observedSignalCloseAt: string
    }
  | {
      readonly _tag: 'PublicationElapsedInvalid'
      readonly measurement: 'data-age' | 'publication-delay'
      readonly later: string
      readonly earlier: string
      readonly milliseconds: number
    }

const elapsed = (
  later: string,
  earlier: string,
  measurement: Extract<PublicationFreshnessFailure, { readonly _tag: 'PublicationElapsedInvalid' }>['measurement'],
): Result.Result<number, PublicationFreshnessFailure> => {
  const milliseconds = Date.parse(later) - Date.parse(earlier)
  return !Number.isSafeInteger(milliseconds) || milliseconds < 0
    ? Result.fail({ _tag: 'PublicationElapsedInvalid', measurement, later, earlier, milliseconds })
    : Result.succeed(milliseconds)
}

const measurePublicationFreshnessDataFirst = (
  cycle: AutonomousCycle,
  inspection: MarketDataInspection,
  observedAt: string,
): Result.Result<PublicationFreshness, PublicationFreshnessFailure> => {
  const snapshot = inspection.manifest.finalizedSnapshot
  if (
    snapshot.asOfSession !== cycle.identity.signalSessionDate ||
    snapshot.lastSession !== cycle.identity.signalSessionDate
  ) {
    return Result.fail({
      _tag: 'PublicationSessionMismatch',
      expectedSessionDate: cycle.identity.signalSessionDate,
      observedAsOfSession: snapshot.asOfSession,
      observedLastSession: snapshot.lastSession,
    })
  }
  if (snapshot.calendarVersion !== cycle.identity.signalCalendarVersion) {
    return Result.fail({
      _tag: 'PublicationCalendarMismatch',
      expectedCalendarVersion: cycle.identity.signalCalendarVersion,
      observedCalendarVersion: snapshot.calendarVersion,
    })
  }
  if (
    inspection.signalSession.session_date !== cycle.identity.signalSessionDate ||
    inspection.signalSession.calendar_version !== cycle.identity.signalCalendarVersion
  ) {
    return Result.fail({
      _tag: 'PublicationSignalSessionMismatch',
      expectedSessionDate: cycle.identity.signalSessionDate,
      expectedCalendarVersion: cycle.identity.signalCalendarVersion,
      observedSessionDate: inspection.signalSession.session_date,
      observedCalendarVersion: inspection.signalSession.calendar_version,
    })
  }
  return Result.flatMap(
    Result.mapError(
      signalSessionCloseAt(inspection.signalSession),
      (cause): PublicationFreshnessFailure => ({ _tag: 'PublicationSignalCloseInvalid', cause }),
    ),
    (observedSignalCloseAt) =>
      observedSignalCloseAt !== cycle.window.signalCloseAt
        ? Result.fail({
            _tag: 'PublicationSignalCloseMismatch',
            expectedSignalCloseAt: cycle.window.signalCloseAt,
            observedSignalCloseAt,
          })
        : Result.flatMap(elapsed(observedAt, snapshot.finalizedAt, 'data-age'), (dataAgeMs) =>
            Result.map(
              elapsed(snapshot.finalizedAt, cycle.window.signalCloseAt, 'publication-delay'),
              (publicationDelayMs) => ({ dataAgeMs, publicationDelayMs }),
            ),
          ),
  )
}

export const measurePublicationFreshness = Pipeable.dual(3, measurePublicationFreshnessDataFirst)
