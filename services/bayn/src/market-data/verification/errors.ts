import { Result, pipe } from 'effect'

import type { EvaluationBounds } from '../../contracts'
import type { CanonicalHashFailure } from '../../hash'

export type BoundField = Exclude<keyof EvaluationBounds, 'schemaVersion'>
export type ManifestField =
  | 'barCount'
  | 'calendarVersion'
  | 'dataBounds'
  | 'evaluationBounds'
  | 'historyStart'
  | 'manifestContentHash'
  | 'publicationAsOf'
  | 'snapshotId'
  | 'symbolCount'
  | 'universeId'
  | 'universeSymbolHash'
export type SessionField =
  | 'calendarVersion'
  | 'closeTime'
  | 'count'
  | 'firstSession'
  | 'lastSession'
  | 'provider'
  | 'sessionsContentHash'
  | 'snapshotId'
export type BarField =
  | 'barCount'
  | 'barsContentHash'
  | 'boundedBarCount'
  | 'publicationAsOf'
  | 'provenance'
  | 'snapshotId'
  | 'universe'

export type MarketDataVerificationError =
  | {
      readonly _tag: 'RowDecodeFailed'
      readonly rows: 'bars' | 'finalized-snapshot' | 'manifests' | 'sessions'
      readonly cause: unknown
    }
  | {
      readonly _tag: 'CountInvalid'
      readonly field: 'bar_count' | 'session_count' | 'symbol_count'
      readonly value: string | number
    }
  | {
      readonly _tag: 'UniverseInvalid'
      readonly reason: 'empty-or-duplicate' | 'not-canonical'
      readonly universe: readonly string[]
    }
  | {
      readonly _tag: 'DecimalInvalid'
      readonly field: 'adjusted_close' | 'adjusted_high' | 'adjusted_low' | 'adjusted_open' | 'adjusted_volume'
      readonly requirement: 'non-negative' | 'positive'
      readonly value: string
      readonly symbol: string
      readonly sessionDate: string
    }
  | {
      readonly _tag: 'OhlcInvalid'
      readonly symbol: string
      readonly sessionDate: string
      readonly open: number
      readonly high: number
      readonly low: number
      readonly close: number
    }
  | {
      readonly _tag: 'BoundSessionMissing'
      readonly field: BoundField
      readonly value: string
    }
  | {
      readonly _tag: 'ManifestCountMismatch'
      readonly snapshotId: string
      readonly count: number
    }
  | {
      readonly _tag: 'ManifestFieldMismatch'
      readonly field: ManifestField
      readonly expected: unknown
      readonly observed: unknown
      readonly snapshotId: string
    }
  | {
      readonly _tag: 'SnapshotFinalizedInFuture'
      readonly snapshotId: string
      readonly finalizedAt: string
      readonly observedAt: string
    }
  | {
      readonly _tag: 'ManifestCardinalityInvalid'
      readonly snapshotId: string
      readonly symbolCount: number
      readonly sessionCount: number
      readonly barCount: number
    }
  | {
      readonly _tag: 'CanonicalizationFailed'
      readonly target: 'bars' | 'input-manifest' | 'manifest' | 'sessions' | 'snapshot-identity'
      readonly snapshotId: string
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'SessionFieldMismatch'
      readonly field: SessionField
      readonly expected: unknown
      readonly observed: unknown
      readonly snapshotId: string
      readonly sessionDate: string | null
    }
  | {
      readonly _tag: 'SessionHoursInvalid'
      readonly snapshotId: string
      readonly sessionDate: string
      readonly openTime: string
      readonly closeTime: string
    }
  | {
      readonly _tag: 'DuplicateSession'
      readonly snapshotId: string
      readonly sessionDate: string
    }
  | {
      readonly _tag: 'BoundedSessionsEmpty'
      readonly snapshotId: string
      readonly dataStart: string
      readonly dataEnd: string
    }
  | {
      readonly _tag: 'SignalSessionMissing'
      readonly snapshotId: string
    }
  | {
      readonly _tag: 'PublicationManifestCountMismatch'
      readonly signalSessionDate: string
      readonly calendarVersion: string
      readonly count: number
    }
  | {
      readonly _tag: 'BoundSnapshotMismatch'
      readonly phase: 'manifest-query' | 'publication-verification' | 'session-query'
      readonly expectedSnapshotId: string
      readonly observedSnapshotIds: readonly string[]
    }
  | {
      readonly _tag: 'CyclePublicationCountExceeded'
      readonly maximum: number
      readonly observed: number
    }
  | {
      readonly _tag: 'DuplicatePublicationDate'
      readonly publicationAsOf: string
      readonly snapshotIds: readonly string[]
    }
  | {
      readonly _tag: 'PublicationVerificationMissing'
      readonly snapshotId: string
      readonly publicationAsOf: string
      readonly calendarVersion: string
    }
  | {
      readonly _tag: 'BarFieldMismatch'
      readonly field: BarField
      readonly expected: unknown
      readonly observed: unknown
      readonly snapshotId: string
      readonly symbol: string | null
      readonly sessionDate: string | null
    }
  | {
      readonly _tag: 'BarOutsideCalendar'
      readonly snapshotId: string
      readonly symbol: string
      readonly sessionDate: string
    }
  | {
      readonly _tag: 'DuplicateBar'
      readonly snapshotId: string
      readonly symbol: string
      readonly sessionDate: string
    }
  | {
      readonly _tag: 'SnapshotCellMissing'
      readonly snapshotId: string
      readonly symbol: string
      readonly sessionDate: string
    }

export const isMarketDataVerificationError = (cause: unknown): cause is MarketDataVerificationError => {
  if (typeof cause !== 'object' || cause === null || !('_tag' in cause)) return false
  switch (cause._tag) {
    case 'RowDecodeFailed':
    case 'CountInvalid':
    case 'UniverseInvalid':
    case 'DecimalInvalid':
    case 'OhlcInvalid':
    case 'BoundSessionMissing':
    case 'ManifestCountMismatch':
    case 'ManifestFieldMismatch':
    case 'SnapshotFinalizedInFuture':
    case 'ManifestCardinalityInvalid':
    case 'CanonicalizationFailed':
    case 'SessionFieldMismatch':
    case 'SessionHoursInvalid':
    case 'DuplicateSession':
    case 'BoundedSessionsEmpty':
    case 'SignalSessionMissing':
    case 'PublicationManifestCountMismatch':
    case 'BoundSnapshotMismatch':
    case 'CyclePublicationCountExceeded':
    case 'DuplicatePublicationDate':
    case 'PublicationVerificationMissing':
    case 'BarFieldMismatch':
    case 'BarOutsideCalendar':
    case 'DuplicateBar':
    case 'SnapshotCellMissing':
      return true
    default:
      return false
  }
}

const renderFact = (value: unknown): string =>
  pipe(
    Result.try(() => (typeof value === 'string' ? value : JSON.stringify(value))),
    Result.getOrElse(() => '[unrenderable]'),
  )

export const renderMarketDataVerificationError = (error: MarketDataVerificationError): string => {
  switch (error._tag) {
    case 'RowDecodeFailed':
      return `failed to decode Signal ${error.rows}`
    case 'CountInvalid':
      return `${error.field} is not a safe non-negative integer: ${String(error.value)}`
    case 'UniverseInvalid':
      return `evaluation universe is ${error.reason}: ${error.universe.join(',')}`
    case 'DecimalInvalid':
      return `${error.symbol} ${error.sessionDate} ${error.field} must be finite and ${error.requirement}: ${error.value}`
    case 'OhlcInvalid':
      return `${error.symbol} ${error.sessionDate} has invalid OHLC: open=${error.open} high=${error.high} low=${error.low} close=${error.close}`
    case 'BoundSessionMissing':
      return `${error.field} ${error.value} is not an exchange session in the snapshot`
    case 'ManifestCountMismatch':
      return `snapshot ${error.snapshotId} has ${error.count} manifests; expected exactly one`
    case 'ManifestFieldMismatch':
      return `snapshot ${error.snapshotId} manifest ${error.field} mismatch: expected=${renderFact(error.expected)} observed=${renderFact(error.observed)}`
    case 'SnapshotFinalizedInFuture':
      return `snapshot ${error.snapshotId} finalized at ${error.finalizedAt} after observation ${error.observedAt}`
    case 'ManifestCardinalityInvalid':
      return `snapshot ${error.snapshotId} cardinality is invalid: symbols=${error.symbolCount} sessions=${error.sessionCount} bars=${error.barCount}`
    case 'CanonicalizationFailed':
      return `snapshot ${error.snapshotId} ${error.target} canonicalization failed`
    case 'SessionFieldMismatch':
      return `snapshot ${error.snapshotId} session ${error.sessionDate ?? 'summary'} ${error.field} mismatch: expected=${renderFact(error.expected)} observed=${renderFact(error.observed)}`
    case 'SessionHoursInvalid':
      return `snapshot ${error.snapshotId} session ${error.sessionDate} has invalid hours ${error.openTime}-${error.closeTime}`
    case 'DuplicateSession':
      return `snapshot ${error.snapshotId} duplicates session ${error.sessionDate}`
    case 'BoundedSessionsEmpty':
      return `snapshot ${error.snapshotId} has no sessions in ${error.dataStart}..${error.dataEnd}`
    case 'SignalSessionMissing':
      return `snapshot ${error.snapshotId} has no terminal Signal session`
    case 'PublicationManifestCountMismatch':
      return `Signal session ${error.signalSessionDate} calendar ${error.calendarVersion} has ${error.count} manifests; expected one`
    case 'BoundSnapshotMismatch':
      return `bound snapshot ${error.expectedSnapshotId} mismatched during ${error.phase}: ${error.observedSnapshotIds.join(',')}`
    case 'CyclePublicationCountExceeded':
      return `cycle publication discovery returned ${error.observed} manifests; expected at most ${error.maximum}`
    case 'DuplicatePublicationDate':
      return `cycle publication ${error.publicationAsOf} has duplicate snapshots ${error.snapshotIds.join(',')}`
    case 'PublicationVerificationMissing':
      return `snapshot ${error.snapshotId} publication ${error.publicationAsOf}/${error.calendarVersion} disappeared during verification`
    case 'BarFieldMismatch':
      return `snapshot ${error.snapshotId} bar ${error.symbol ?? 'summary'} ${error.sessionDate ?? ''} ${error.field} mismatch: expected=${renderFact(error.expected)} observed=${renderFact(error.observed)}`
    case 'BarOutsideCalendar':
      return `snapshot ${error.snapshotId} bar ${error.symbol} ${error.sessionDate} is outside the calendar`
    case 'DuplicateBar':
      return `snapshot ${error.snapshotId} duplicates bar ${error.symbol} ${error.sessionDate}`
    case 'SnapshotCellMissing':
      return `snapshot ${error.snapshotId} is missing ${error.symbol} ${error.sessionDate}`
  }
}
