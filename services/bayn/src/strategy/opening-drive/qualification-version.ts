import { Result } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import type { IntradayMarketSnapshot, IntradaySnapshotRequest } from '../../market-data'
import type { IsoDate } from '../../types'
import { OpeningDriveQualificationFailure, type OpeningDriveReplaySessionInput } from './qualification-model'

export interface OpeningDriveReplayVersionSession {
  readonly sessionDate: IsoDate
  readonly openingRequestHash: string
  readonly exitRequestHash: string
}

const failure = (message: string, cause?: unknown): OpeningDriveQualificationFailure =>
  new OpeningDriveQualificationFailure({ reason: 'canonicalization', message, cause })

const requestFromSnapshot = (snapshot: IntradayMarketSnapshot): IntradaySnapshotRequest => {
  const manifest = snapshot.manifest
  return {
    sessionDate: manifest.sessionDate,
    calendar: manifest.calendar,
    rangeStartAt: manifest.rangeStartAt,
    rangeEndAt: manifest.rangeEndAt,
    observedAt: manifest.observedAt,
    universeId: manifest.universeId,
    universeSymbolHash: manifest.universeSymbolHash,
    universe: manifest.symbols,
    feed: manifest.feed,
    delayClass: manifest.delayClass,
    sourceTopics: manifest.sourceTopics,
    maximumQuoteAgeMs: manifest.maximumQuoteAgeMs,
    minimumWatermarkLagMs: manifest.minimumWatermarkLagMs,
    archiveWatermarks: manifest.archiveWatermarks,
  }
}

const hashRequest = (request: IntradaySnapshotRequest): Result.Result<string, OpeningDriveQualificationFailure> =>
  Result.mapError(canonicalHashV1Result(request), (cause) =>
    failure('opening-drive replay snapshot request is not canonically hashable', cause),
  )

/** Commits the complete query and archive version before the corresponding market rows are loaded. */
export const makeOpeningDriveReplayVersionSession = (
  sessionDate: IsoDate,
  opening: IntradaySnapshotRequest,
  exit: IntradaySnapshotRequest,
): Result.Result<OpeningDriveReplayVersionSession, OpeningDriveQualificationFailure> =>
  Result.all({
    sessionDate: Result.succeed(sessionDate),
    openingRequestHash: hashRequest(opening),
    exitRequestHash: hashRequest(exit),
  })

export const hashOpeningDriveReplayVersionGraph = (
  sessions: readonly OpeningDriveReplayVersionSession[],
): Result.Result<string, OpeningDriveQualificationFailure> =>
  Result.mapError(
    canonicalHashV1Result({ schemaVersion: 'bayn.opening-drive.replay-version-graph.v1', sessions }),
    (cause) => failure('opening-drive replay version graph is not canonically hashable', cause),
  )

export const hashOpeningDriveReplayVersionGraphFromInputs = (
  sessions: readonly OpeningDriveReplaySessionInput[],
): Result.Result<string, OpeningDriveQualificationFailure> =>
  Result.flatMap(
    Result.all(
      sessions.map((session) =>
        makeOpeningDriveReplayVersionSession(
          session.opening.session.sessionDate,
          requestFromSnapshot(session.opening.snapshot),
          requestFromSnapshot(session.exit),
        ),
      ),
    ),
    hashOpeningDriveReplayVersionGraph,
  )
