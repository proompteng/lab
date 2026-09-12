import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { operationalError, type OperationalError } from '../../errors'
import { persistIntradayRecordRows } from '../intraday/verification'
import type { IntradayMarketDataService } from '../intraday/model'
import { strictParseOptions } from '../../schemas'
import { SimulatedSnapshotSourceSchema } from './evidence-schema'
import type { HistoricalMarketCursor } from './historical'
import { reproduceSimulatedSnapshot } from './replay'
import { constructSimulatedSnapshot, type SimulatedSnapshotManifest } from './snapshot'

const VerifiedSimulationReferenceTypeId: unique symbol = Symbol('VerifiedSimulationReference')
export interface SimulatedSnapshotReference {
  readonly schemaVersion: 'bayn.simulated-snapshot-reference.v1'
  readonly manifest: SimulatedSnapshotManifest
  readonly [VerifiedSimulationReferenceTypeId]: true
}
const reference = (manifest: SimulatedSnapshotManifest): SimulatedSnapshotReference =>
  Object.freeze({
    schemaVersion: 'bayn.simulated-snapshot-reference.v1',
    manifest,
    [VerifiedSimulationReferenceTypeId]: true as const,
  })
const failure = (message: string, cause?: unknown) =>
  operationalError({
    component: 'market-data',
    operation: 'load',
    message,
    ...(cause === undefined ? {} : { cause }),
  })

/** The replay composition owns the source manifest and cursor; live Kafka and archive capabilities are absent. */
export const makeSimulatedMarketData = (
  input: typeof SimulatedSnapshotSourceSchema.Type,
  cursor: Effect.Effect<HistoricalMarketCursor, OperationalError>,
) =>
  Effect.gen(function* () {
    const source = yield* Schema.decodeUnknownEffect(
      SimulatedSnapshotSourceSchema,
      strictParseOptions,
    )(input).pipe(Effect.catch((cause) => failure('Invalid simulation source configuration', cause)))
    const sql = yield* PgClient.PgClient
    const observed = new Map<string, SimulatedSnapshotManifest>()
    const forbidden = () => failure('Archive access is unavailable in simulated market data')
    return {
      check: Effect.void,
      captureVersion: forbidden,
      loadSnapshot: forbidden,
      verifyArchiveSnapshot: forbidden,
      simulation: {
        runId: source.runId,
        loadSnapshot: (query) =>
          Effect.gen(function* () {
            const state = yield* cursor
            const snapshot = yield* Effect.fromResult(constructSimulatedSnapshot(state, source, query)).pipe(
              Effect.catch((cause) => failure('Simulated snapshot is unavailable', cause)),
            )
            observed.set(snapshot.manifest.snapshotId, snapshot.manifest)
            while (observed.size > 128) {
              const first = observed.keys().next().value
              if (first === undefined) break
              observed.delete(first)
            }
            return snapshot
          }),
        verifyReference: (snapshot) =>
          Effect.gen(function* () {
            const {
              schemaVersion: _version,
              positions: _positions,
              sequence: _sequence,
              records: _records,
              features: _features,
              ...provenance
            } = snapshot.manifest.streaming
            const sourceHash = canonicalHashV1Result(source)
            const suppliedHash = canonicalHashV1Result(provenance)
            if (
              Result.isFailure(sourceHash) ||
              Result.isFailure(suppliedHash) ||
              sourceHash.success !== suppliedHash.success
            )
              return yield* failure('Simulated snapshot belongs to another source manifest or replay run')
            const reproduced = persistIntradayRecordRows(snapshot).pipe(
              Result.flatMap((rows) => reproduceSimulatedSnapshot(snapshot.manifest, rows)),
            )
            if (Result.isFailure(reproduced))
              return yield* failure('Simulated snapshot does not reproduce', reproduced.failure)
            const cached = observed.get(snapshot.manifest.snapshotId)
            if (cached?.contentHash === snapshot.manifest.contentHash) return reference(cached)
            const rows = yield* sql<Record<string, unknown>>`
          SELECT EXISTS (SELECT 1 FROM simulated_snapshot_references
            WHERE snapshot_id = ${snapshot.manifest.snapshotId}
              AND content_hash = ${snapshot.manifest.contentHash}
              AND manifest = ${sql.json(snapshot.manifest)}) AS matches
        `.pipe(Effect.catch((cause) => failure('Simulated reference lookup failed', cause)))
            const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ matches: Schema.Boolean })))(
              rows,
            ).pipe(Effect.catch((cause) => failure('Simulated reference lookup returned invalid rows', cause)))
            if (decoded.length !== 1 || decoded[0]?.matches !== true)
              return yield* failure('Simulated snapshot was neither consumed by this run nor durably committed')
            return reference(snapshot.manifest)
          }),
      },
    } satisfies IntradayMarketDataService
  })
