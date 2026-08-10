import { Result, pipe } from 'effect'

import type { FinalizedPublicationRequest, MarketDataContract, MarketDataInspection } from '../model'
import type { SignalManifestRow, SignalSessionRow, SnapshotRows } from '../rows'
import { publicationSnapshotRequest, verifyFinalizedCalendar } from './calendar'
import type { MarketDataVerificationError } from './errors'
import { fail } from './shared'
import { Pipeable } from '../../pipeable'

const verifyFinalizedPublicationDataFirst = (
  rows: Pick<SnapshotRows, 'sessions' | 'manifests'>,
  input: FinalizedPublicationRequest,
  contract: MarketDataContract,
  observedAt: string,
): Result.Result<MarketDataInspection | undefined, MarketDataVerificationError> => {
  const manifests = rows.manifests.filter((manifest) => manifest.calendar_version === input.signalCalendarVersion)
  if (manifests.length === 0) return Result.succeed(undefined)
  return manifests.length !== 1 || manifests[0] === undefined
    ? fail({
        _tag: 'PublicationManifestCountMismatch',
        signalSessionDate: input.signalSessionDate,
        calendarVersion: input.signalCalendarVersion,
        count: manifests.length,
      })
    : verifyFinalizedCalendar(
        { sessions: rows.sessions, manifests },
        publicationSnapshotRequest(manifests[0], input, contract, observedAt),
      )
}

export const verifyFinalizedPublication = Pipeable.dual(4, verifyFinalizedPublicationDataFirst)

const selectPublicationManifestDataFirst = (
  manifests: readonly SignalManifestRow[],
  expectedSnapshotId?: string,
): Result.Result<SignalManifestRow | undefined, MarketDataVerificationError> => {
  const observedSnapshotIds = manifests.map((manifest) => manifest.snapshot_id)
  return expectedSnapshotId !== undefined && observedSnapshotIds.some((snapshotId) => snapshotId !== expectedSnapshotId)
    ? fail({
        _tag: 'BoundSnapshotMismatch',
        phase: 'manifest-query',
        expectedSnapshotId,
        observedSnapshotIds,
      })
    : Result.succeed(manifests[0])
}

export const selectPublicationManifest = Pipeable.by<
  (
    expectedSnapshotId?: string,
  ) => (manifests: readonly SignalManifestRow[]) => ReturnType<typeof selectPublicationManifestDataFirst>,
  typeof selectPublicationManifestDataFirst
>((arguments_) => Array.isArray(arguments_[0]), selectPublicationManifestDataFirst)

const verifyBoundFinalizedPublicationDataFirst = (
  rows: Pick<SnapshotRows, 'sessions' | 'manifests'>,
  input: FinalizedPublicationRequest,
  contract: MarketDataContract,
  observedAt: string,
  expectedSnapshotId?: string,
): Result.Result<MarketDataInspection, MarketDataVerificationError> =>
  pipe(
    verifyFinalizedPublication(rows, input, contract, observedAt),
    Result.flatMap((inspection) =>
      inspection === undefined
        ? fail({
            _tag: 'PublicationVerificationMissing',
            snapshotId: expectedSnapshotId ?? rows.manifests[0]?.snapshot_id ?? 'unknown',
            publicationAsOf: input.signalSessionDate,
            calendarVersion: input.signalCalendarVersion,
          })
        : expectedSnapshotId !== undefined && inspection.manifest.finalizedSnapshot.snapshotId !== expectedSnapshotId
          ? fail({
              _tag: 'BoundSnapshotMismatch',
              phase: 'publication-verification',
              expectedSnapshotId,
              observedSnapshotIds: [inspection.manifest.finalizedSnapshot.snapshotId],
            })
          : Result.succeed(inspection),
    ),
  )

export const verifyBoundFinalizedPublication = Pipeable.by<
  (
    input: FinalizedPublicationRequest,
    contract: MarketDataContract,
    observedAt: string,
    expectedSnapshotId?: string,
  ) => (
    rows: Pick<SnapshotRows, 'sessions' | 'manifests'>,
  ) => ReturnType<typeof verifyBoundFinalizedPublicationDataFirst>,
  typeof verifyBoundFinalizedPublicationDataFirst
>(
  (arguments_) => typeof arguments_[0] === 'object' && arguments_[0] !== null && 'sessions' in arguments_[0],
  verifyBoundFinalizedPublicationDataFirst,
)

const selectCyclePublicationManifestsDataFirst = (
  manifests: readonly SignalManifestRow[],
  maximum: number,
): Result.Result<readonly SignalManifestRow[], MarketDataVerificationError> => {
  const ordered = [...manifests].sort((left, right) =>
    left.publication_asof !== right.publication_asof
      ? right.publication_asof.localeCompare(left.publication_asof)
      : left.finalized_at !== right.finalized_at
        ? right.finalized_at.localeCompare(left.finalized_at)
        : right.snapshot_id.localeCompare(left.snapshot_id),
  )
  const duplicate = ordered.find(
    (manifest, index) => index > 0 && ordered[index - 1]?.publication_asof === manifest.publication_asof,
  )
  return manifests.length > maximum
    ? fail({ _tag: 'CyclePublicationCountExceeded', maximum, observed: manifests.length })
    : duplicate !== undefined
      ? fail({
          _tag: 'DuplicatePublicationDate',
          publicationAsOf: duplicate.publication_asof,
          snapshotIds: ordered
            .filter((manifest) => manifest.publication_asof === duplicate.publication_asof)
            .map((manifest) => manifest.snapshot_id),
        })
      : Result.succeed(ordered)
}

export const selectCyclePublicationManifests = Pipeable.dual(2, selectCyclePublicationManifestsDataFirst)

const verifyCyclePublicationsDataFirst = (
  manifests: readonly SignalManifestRow[],
  sessions: readonly SignalSessionRow[],
  contract: MarketDataContract,
  observedAt: string,
): Result.Result<readonly MarketDataInspection[], MarketDataVerificationError> => {
  const expectedSnapshotIds = new Set(manifests.map((manifest) => manifest.snapshot_id))
  const unexpectedSnapshotIds = [
    ...new Set(
      sessions.filter((session) => !expectedSnapshotIds.has(session.snapshot_id)).map((session) => session.snapshot_id),
    ),
  ].sort()
  return unexpectedSnapshotIds.length > 0
    ? fail({
        _tag: 'BoundSnapshotMismatch',
        phase: 'session-query',
        expectedSnapshotId: manifests.map((manifest) => manifest.snapshot_id).join(','),
        observedSnapshotIds: unexpectedSnapshotIds,
      })
    : Result.all(
        manifests.map((manifest) =>
          verifyBoundFinalizedPublication(
            {
              manifests: [manifest],
              sessions: sessions.filter((session) => session.snapshot_id === manifest.snapshot_id),
            },
            {
              signalSessionDate: manifest.publication_asof,
              signalCalendarVersion: manifest.calendar_version,
            },
            contract,
            observedAt,
            manifest.snapshot_id,
          ),
        ),
      )
}

export const verifyCyclePublications = Pipeable.dual(4, verifyCyclePublicationsDataFirst)
