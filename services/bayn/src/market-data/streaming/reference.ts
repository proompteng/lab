import { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { operationalError } from '../../errors'
import { marketDataOperationError } from '../errors'
import type { StreamingSnapshotManifest, StreamingVerifiedMarketSnapshot } from './snapshot'

const VerifiedReferenceTypeId: unique symbol = Symbol('StreamingVerifiedReference')
export interface StreamingVerifiedSnapshotReference {
  readonly schemaVersion: 'bayn.streaming-snapshot-reference.v1'
  readonly manifest: StreamingSnapshotManifest
  readonly [VerifiedReferenceTypeId]: true
}
const reference = (manifest: StreamingSnapshotManifest): StreamingVerifiedSnapshotReference =>
  Object.freeze({
    schemaVersion: 'bayn.streaming-snapshot-reference.v1',
    manifest,
    [VerifiedReferenceTypeId]: true as const,
  })
export const streamingSnapshotReference = (snapshot: StreamingVerifiedMarketSnapshot) => reference(snapshot.manifest)

/** Recover only an exact reference previously committed under the append-only decision transaction. */
export const recoverStreamingSnapshotReference = (manifest: StreamingSnapshotManifest) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const result = yield* sql<Record<string, unknown>>`
    SELECT EXISTS (
      SELECT 1 FROM streaming_snapshot_references
      WHERE snapshot_id = ${manifest.snapshotId}
        AND schema_version = 'bayn.streaming-snapshot-reference.v1'
        AND content_hash = ${manifest.contentHash}
        AND observed_at = ${manifest.observedAt}::timestamptz
        AND manifest = ${sql.json(manifest)}
    ) AS matches
  `.pipe(
      Effect.mapError((cause) => marketDataOperationError('load', 'Streaming snapshot reference lookup failed', cause)),
    )
    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ matches: Schema.Boolean })))(
      result,
    ).pipe(
      Effect.mapError((cause) =>
        marketDataOperationError('load', 'Streaming reference lookup returned invalid rows', cause),
      ),
    )
    if (rows.length !== 1 || rows[0]?.matches !== true)
      return yield* operationalError({
        component: 'market-data',
        operation: 'load',
        message: 'Streaming snapshot was neither observed by this worker nor durably committed',
      })
    return reference(manifest)
  })
