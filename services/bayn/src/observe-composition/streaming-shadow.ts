import { Result, Schema } from 'effect'
import { IsoDateSchema } from '../contracts'
import { makeExecutionCalendarObservation } from '../cycle/construction'
import { canonicalHashV1 } from '../hash'
import type { ArchiveVerifiedIntradayMarketSnapshot } from '../market-data/intraday/model'
import type { StreamingVerifiedMarketSnapshot } from '../market-data/streaming/snapshot'
import { decideIntradayMomentum } from '../strategy/intraday-momentum/decision'
import { defaultIntradayMomentumProtocolDocument } from '../strategy/intraday-momentum/protocol'

/** Differences in receipt timing must be distinguished from differences in strategy calculation. */
export const compareStreamingShadowSnapshots = (
  archive: ArchiveVerifiedIntradayMarketSnapshot,
  streaming: StreamingVerifiedMarketSnapshot,
) => {
  const identity = { streamingSnapshotId: streaming.manifest.snapshotId }
  const rawFields = ['barsContentHash', 'quotesContentHash', 'tradesContentHash'] as const
  const differentInputs = rawFields.filter((field) => archive.manifest[field] !== streaming.manifest[field])
  if (differentInputs.length > 0) return { ...identity, outcome: 'different-input-cut', differentInputs }
  if (archive.manifest.purpose !== undefined) return { ...identity, outcome: 'pricing-match' }
  const session = archive.manifest.calendar.sessions.find((value) => value.date === archive.manifest.sessionDate)
  if (session === undefined) return { ...identity, outcome: 'calendar-unavailable' }
  const calendar = makeExecutionCalendarObservation({
    ...session,
    schemaVersion: archive.manifest.calendar.schemaVersion,
    source: archive.manifest.calendar.source,
  })
  const date = Schema.decodeUnknownResult(IsoDateSchema)(session.date)
  if (Result.isFailure(calendar) || Result.isFailure(date)) return { ...identity, outcome: 'calendar-invalid' }
  const boundSession = {
    sessionDate: date.success,
    openAt: session.openAt,
    closeAt: session.closeAt,
    calendarHash: calendar.success.executionCalendarHash,
  }
  const archivedDecision = decideIntradayMomentum(
    { snapshot: archive, session: boundSession },
    defaultIntradayMomentumProtocolDocument,
  )
  const streamedDecision = decideIntradayMomentum(
    { snapshot: streaming, session: boundSession },
    defaultIntradayMomentumProtocolDocument,
  )
  if (Result.isFailure(archivedDecision) || Result.isFailure(streamedDecision))
    return {
      ...identity,
      outcome: 'decision-invalid',
      archiveFailure: Result.isFailure(archivedDecision) ? archivedDecision.failure.message : undefined,
      streamingFailure: Result.isFailure(streamedDecision) ? streamedDecision.failure.message : undefined,
    }
  const { snapshotId: archiveSnapshotId, ...archiveResult } = archivedDecision.success
  const { snapshotId: streamingSnapshotId, ...streamingResult } = streamedDecision.success
  const archiveDecisionHash = canonicalHashV1(archiveResult)
  const streamingDecisionHash = canonicalHashV1(streamingResult)
  return {
    archiveSnapshotId,
    streamingSnapshotId,
    archiveDecisionHash,
    streamingDecisionHash,
    outcome: archiveDecisionHash === streamingDecisionHash ? 'decision-match' : 'decision-mismatch',
  }
}
