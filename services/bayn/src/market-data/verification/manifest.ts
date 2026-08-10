import { Result, Schema, pipe } from 'effect'

import { type FinalizedSnapshotProvenance, FinalizedSnapshotProvenanceSchema } from '../../contracts'
import { sha256 } from '../../hash'
import { strictParseOptions } from '../../schemas'
import type { SnapshotRequest } from '../model'
import type { SignalManifestRow } from '../rows'
import type { MarketDataVerificationError, ManifestField } from './errors'
import {
  canonicalHashResult,
  canonicalUniverse,
  requireCondition,
  toUtcInstant,
  validateAll,
  withoutManifestHash,
} from './shared'
import { Pipeable } from '../../pipeable'

export interface VerifiedManifest {
  readonly manifest: SignalManifestRow
  readonly finalizedSnapshot: FinalizedSnapshotProvenance
  readonly universe: readonly string[]
}

const onlyManifest = (
  manifests: readonly SignalManifestRow[],
  request: SnapshotRequest,
): Result.Result<SignalManifestRow, MarketDataVerificationError> =>
  manifests.length === 1 && manifests[0] !== undefined
    ? Result.succeed(manifests[0])
    : Result.fail({
        _tag: 'ManifestCountMismatch',
        snapshotId: request.snapshotId,
        count: manifests.length,
      })

const manifestMismatch = (
  field: ManifestField,
  expected: unknown,
  observed: unknown,
  snapshotId: string,
): MarketDataVerificationError => ({
  _tag: 'ManifestFieldMismatch',
  field,
  expected,
  observed,
  snapshotId,
})

const verifyManifestDataFirst = (
  manifests: readonly SignalManifestRow[],
  request: SnapshotRequest,
): Result.Result<VerifiedManifest, MarketDataVerificationError> =>
  pipe(
    Result.all({
      universe: canonicalUniverse(request.universe),
      manifest: onlyManifest(manifests, request),
    }),
    Result.flatMap(({ manifest, universe }) => {
      const finalizedAt = toUtcInstant(manifest.finalized_at)
      const snapshotIdentity = {
        schemaVersion: manifest.schema_version,
        provider: manifest.provider,
        feed: manifest.source_feed,
        adjustment: manifest.adjustment,
        calendarVersion: manifest.calendar_version,
        requestedStart: manifest.requested_start,
        publicationAsOf: manifest.publication_asof,
        symbols: universe,
        barsContentHash: manifest.bars_content_hash,
        sessionsContentHash: manifest.sessions_content_hash,
      } as const
      return pipe(
        Result.all({
          expectedManifestHash: canonicalHashResult('manifest', request.snapshotId, withoutManifestHash(manifest)),
          expectedSnapshotId: canonicalHashResult('snapshot-identity', request.snapshotId, {
            ...snapshotIdentity,
            universeId: manifest.universe_id,
            universeSymbolHash: manifest.universe_symbol_hash,
          }),
        }),
        Result.flatMap(({ expectedManifestHash, expectedSnapshotId }) =>
          validateAll([
            requireCondition(
              manifest.snapshot_id === request.snapshotId,
              manifestMismatch('snapshotId', request.snapshotId, manifest.snapshot_id, request.snapshotId),
            ),
            requireCondition(
              manifest.calendar_version === request.calendarVersion,
              manifestMismatch(
                'calendarVersion',
                request.calendarVersion,
                manifest.calendar_version,
                request.snapshotId,
              ),
            ),
            requireCondition(
              manifest.publication_asof === request.publicationAsOf,
              manifestMismatch(
                'publicationAsOf',
                request.publicationAsOf,
                manifest.publication_asof,
                request.snapshotId,
              ),
            ),
            requireCondition(finalizedAt <= request.observedAt, {
              _tag: 'SnapshotFinalizedInFuture',
              snapshotId: request.snapshotId,
              finalizedAt,
              observedAt: request.observedAt,
            }),
            requireCondition(
              manifest.manifest_content_hash === expectedManifestHash,
              manifestMismatch(
                'manifestContentHash',
                expectedManifestHash,
                manifest.manifest_content_hash,
                request.snapshotId,
              ),
            ),
            requireCondition(
              manifest.symbol_count === universe.length,
              manifestMismatch('symbolCount', universe.length, manifest.symbol_count, request.snapshotId),
            ),
            requireCondition(manifest.bar_count === manifest.session_count * manifest.symbol_count, {
              _tag: 'ManifestCardinalityInvalid',
              snapshotId: request.snapshotId,
              symbolCount: manifest.symbol_count,
              sessionCount: manifest.session_count,
              barCount: manifest.bar_count,
            }),
            requireCondition(
              manifest.snapshot_id === expectedSnapshotId,
              manifestMismatch('snapshotId', expectedSnapshotId, manifest.snapshot_id, request.snapshotId),
            ),
            requireCondition(
              request.bounds.dataStart >= manifest.first_session && request.bounds.dataEnd <= manifest.last_session,
              manifestMismatch(
                'dataBounds',
                { firstSession: manifest.first_session, lastSession: manifest.last_session },
                { dataStart: request.bounds.dataStart, dataEnd: request.bounds.dataEnd },
                request.snapshotId,
              ),
            ),
            requireCondition(
              manifest.universe_id === request.universeId,
              manifestMismatch('universeId', request.universeId, manifest.universe_id, request.snapshotId),
            ),
            requireCondition(
              manifest.universe_symbol_hash === request.universeSymbolHash,
              manifestMismatch(
                'universeSymbolHash',
                request.universeSymbolHash,
                manifest.universe_symbol_hash,
                request.snapshotId,
              ),
            ),
            requireCondition(
              sha256(universe.join(',')) === request.universeSymbolHash,
              manifestMismatch(
                'universeSymbolHash',
                sha256(universe.join(',')),
                request.universeSymbolHash,
                request.snapshotId,
              ),
            ),
            requireCondition(
              manifest.requested_start === request.historyStart && manifest.first_session === request.historyStart,
              manifestMismatch(
                'historyStart',
                request.historyStart,
                { requestedStart: manifest.requested_start, firstSession: manifest.first_session },
                request.snapshotId,
              ),
            ),
            requireCondition(
              request.bounds.dataStart === request.historyStart &&
                request.bounds.lookbackStart === request.historyStart &&
                request.bounds.evaluationStart === request.evaluationStart,
              manifestMismatch(
                'evaluationBounds',
                { historyStart: request.historyStart, evaluationStart: request.evaluationStart },
                request.bounds,
                request.snapshotId,
              ),
            ),
            requireCondition(
              request.bounds.dataEnd === request.publicationAsOf &&
                request.bounds.evaluationEnd === request.publicationAsOf,
              manifestMismatch(
                'evaluationBounds',
                { publicationAsOf: request.publicationAsOf },
                request.bounds,
                request.snapshotId,
              ),
            ),
          ]),
        ),
        Result.flatMap(() => {
          const commonSnapshot = {
            snapshotId: manifest.snapshot_id,
            publicationId: manifest.manifest_content_hash,
            publicationSchemaVersion: manifest.schema_version,
            source: manifest.provider,
            sourceFeed: manifest.source_feed,
            adjustment: manifest.adjustment,
            calendarVersion: manifest.calendar_version,
            publisherSourceRevision: manifest.publisher_source_revision,
            publisherImage: {
              repository: manifest.publisher_image_repository,
              digest: manifest.publisher_image_digest,
            },
            finalizedAt,
            requestedStart: manifest.requested_start,
            firstSession: manifest.first_session,
            lastSession: manifest.last_session,
            asOfSession: manifest.publication_asof,
            symbols: universe,
            rowCount: manifest.bar_count,
            sessionCount: manifest.session_count,
            contentHash: manifest.bars_content_hash,
            sessionsContentHash: manifest.sessions_content_hash,
          } as const
          return pipe(
            Schema.decodeUnknownResult(
              FinalizedSnapshotProvenanceSchema,
              strictParseOptions,
            )({
              schemaVersion: 'bayn.finalized-snapshot.v3',
              universeId: manifest.universe_id,
              universeSymbolHash: manifest.universe_symbol_hash,
              ...commonSnapshot,
            }),
            Result.mapError(
              (cause): MarketDataVerificationError => ({
                _tag: 'RowDecodeFailed',
                rows: 'finalized-snapshot',
                cause,
              }),
            ),
            Result.map((finalizedSnapshot) => ({ manifest, universe, finalizedSnapshot })),
          )
        }),
      )
    }),
  )

export const verifyManifest = Pipeable.dual(2, verifyManifestDataFirst)

const verifyFinalizedManifestDataFirst = (
  manifests: readonly SignalManifestRow[],
  request: SnapshotRequest,
): Result.Result<FinalizedSnapshotProvenance, MarketDataVerificationError> =>
  Result.map(verifyManifest(manifests, request), ({ finalizedSnapshot }) => finalizedSnapshot)

export const verifyFinalizedManifest = Pipeable.dual(2, verifyFinalizedManifestDataFirst)
