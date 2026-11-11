import type { PgClient } from '@effect/sql-pg'
import { Clock, DateTime, Effect, Schema } from 'effect'

import { MarketReadySchema, type MarketReadyWakeup } from '../execution/events'
import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from '../hash'
import { Sha256Schema, strictParseOptions } from '../schemas'
import {
  decodeNativeArrivalChunk,
  NativeArrivalCaptureError,
  NativeArrivalChunkHeaderSchema,
  type NativeArrival,
  type NativeArrivalChunk,
  type NativeArrivalEpoch,
} from '../market-data/streaming/native-arrival'
import { CaptureDisposition } from '../market-data/streaming/transport-evidence'

const PersistedEvent = Schema.Struct({
  position: Schema.String,
  content_hash: Sha256Schema,
  payload: Schema.String,
})
const failed = (cause: unknown) =>
  new NativeArrivalCaptureError({ message: 'Durable market readiness handoff failed', cause })

export interface PendingMarketReady {
  readonly position: string
  readonly event: MarketReadyWakeup
}

/** The cursor acknowledges a prefix, so a burst occupies one publisher slot regardless of quote count. */
export const makeMarketReadyStore = (sql: PgClient.PgClient, controllerKey: string, sourceRevision: string) => {
  const decode = (row: typeof PersistedEvent.Type) =>
    Effect.gen(function* () {
      if (sha256(row.payload) !== row.content_hash) return yield* failed('Market readiness payload hash differs')
      const event = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(MarketReadySchema),
        strictParseOptions,
      )(row.payload)
      if (event.sourceRevision !== sourceRevision) return yield* failed('Market readiness source revision differs')
      if (event.readyAt < event.originalAvailableAt)
        return yield* failed('Stored market readiness clock precedes source availability')
      return { position: row.position, event }
    }).pipe(Effect.mapError(failed))

  const retain = (epoch: NativeArrivalEpoch, chunks: readonly NativeArrivalChunk[], phase: 'input' | 'bootstrap') =>
    Effect.gen(function* () {
      if (epoch.build.sourceRevision !== sourceRevision) return yield* failed('Market readiness epoch source differs')
      let selection: { readonly chunk: NativeArrivalChunk; readonly last: NativeArrival } | undefined
      for (const chunk of chunks.toReversed()) {
        if (chunk.header.captureId !== epoch.captureId) return yield* failed('Market readiness capture differs')
        const records = yield* Effect.fromResult(decodeNativeArrivalChunk(chunk))
        const last = records.findLast(
          (record) => record.receipt.disposition === CaptureDisposition.Accepted && record.receipt.reason === undefined,
        )
        if (last !== undefined) {
          selection = { chunk, last }
          break
        }
      }
      if (selection === undefined) return
      const { chunk, last } = selection
      if (last.receipt.consumerEpoch !== epoch.bootstrap.epoch)
        return yield* failed('Market readiness input belongs to another consumer epoch')
      // Serializing allocation with commit prevents a later cursor from skipping an earlier uncommitted row.
      yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${controllerKey + ':' + sourceRevision},49193))`
      const eventId = yield* Effect.fromResult(
        canonicalHashV1Result({
          schemaVersion: 'bayn.market-ready-identity.v1',
          controllerKey,
          captureId: epoch.captureId,
          chunkHash: chunk.contentHash,
          phase,
        }),
      )
      const material = {
        _tag: 'MarketReady',
        schemaVersion: 'bayn.execution-wakeup.v1',
        sourceRevision,
        eventId,
        captureId: epoch.captureId,
        sourceEpoch: epoch.bootstrap.epoch,
        consumerSequence: last.receipt.consumerSequence,
        projectionSequence: last.receipt.projectionSequence,
        originalAvailableAt: DateTime.formatIso(DateTime.makeUnsafe(last.availableAtMs)),
      } as const
      const readyAtMs = yield* Clock.currentTimeMillis
      if (readyAtMs < last.availableAtMs) return yield* failed('Market readiness clock precedes original availability')
      const readyAt = DateTime.formatIso(DateTime.makeUnsafe(readyAtMs))
      const payload = yield* Effect.fromResult(canonicalJsonV1Result({ ...material, readyAt }))
      yield* sql`INSERT INTO market_ready_events
        (event_id,controller_key,source_revision,capture_id,content_hash,payload)
        VALUES (${eventId},${controllerKey},${sourceRevision},${epoch.captureId},${sha256(payload)},${payload})
        ON CONFLICT(event_id) DO NOTHING`
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Tuple([PersistedEvent]),
        strictParseOptions,
      )(
        yield* sql`SELECT position::text,content_hash,payload FROM market_ready_events
          WHERE event_id=${eventId} AND controller_key=${controllerKey} AND source_revision=${sourceRevision}`,
      )
      const stored = yield* decode(rows[0])
      // A retry keeps the first ready clock, including after a lost COMMIT acknowledgement.
      const { readyAt: _readyAt, ...storedMaterial } = stored.event
      if (
        (yield* Effect.fromResult(canonicalJsonV1Result(storedMaterial))) !==
        (yield* Effect.fromResult(canonicalJsonV1Result(material)))
      )
        return yield* failed('Existing market readiness identity has different immutable source content')
    }).pipe(Effect.mapError(failed))

  return {
    retain: (epoch: NativeArrivalEpoch, chunks: readonly NativeArrivalChunk[]) => retain(epoch, chunks, 'input'),
    bootstrap: (epoch: NativeArrivalEpoch) => {
      let checkpoint: NativeArrivalChunk | undefined
      return sql
        .withTransaction(
          Effect.gen(function* () {
            if (checkpoint === undefined) {
              const rows = yield* Schema.decodeUnknownEffect(
                Schema.Array(
                  Schema.Struct({ header: Schema.String, compressed: Schema.Uint8Array, content_hash: Sha256Schema }),
                ),
                strictParseOptions,
              )(
                yield* sql`SELECT header,compressed,content_hash FROM native_arrival_chunks
          WHERE capture_id=${epoch.captureId} ORDER BY ordinal DESC LIMIT 1`,
              )
              const row = rows[0]
              if (row === undefined) return
              const header = yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(NativeArrivalChunkHeaderSchema),
                strictParseOptions,
              )(row.header)
              checkpoint = { header, compressed: row.compressed, contentHash: row.content_hash }
            }
            yield* retain(epoch, [checkpoint], 'bootstrap')
          }),
        )
        .pipe(Effect.mapError(failed))
    },
    next: Effect.gen(function* () {
      const rows = yield* Schema.decodeUnknownEffect(
        Schema.Array(PersistedEvent),
        strictParseOptions,
      )(
        yield* sql`SELECT position::text,content_hash,payload FROM market_ready_events e
          WHERE controller_key=${controllerKey} AND source_revision=${sourceRevision}
            AND position>COALESCE((SELECT position FROM market_ready_delivery_cursors
              WHERE controller_key=${controllerKey} AND source_revision=${sourceRevision}),0)
          ORDER BY position DESC LIMIT 1`,
      )
      const row = rows[0]
      return row === undefined ? undefined : yield* decode(row)
    }).pipe(Effect.mapError(failed)),
    acknowledge: (pending: PendingMarketReady) =>
      sql`INSERT INTO market_ready_delivery_cursors(controller_key,source_revision,position)
        SELECT ${controllerKey},${sourceRevision},position FROM market_ready_events
          WHERE position=${pending.position}::bigint AND event_id=${pending.event.eventId}
            AND controller_key=${controllerKey} AND source_revision=${sourceRevision}
        ON CONFLICT(controller_key,source_revision) DO UPDATE
          SET position=GREATEST(market_ready_delivery_cursors.position,EXCLUDED.position)`.pipe(
        Effect.mapError(failed),
        Effect.asVoid,
      ),
  }
}
