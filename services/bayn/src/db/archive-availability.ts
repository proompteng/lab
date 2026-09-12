import type { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import {
  archiveAvailabilityOperationalError,
  archiveRecordReferences,
  ArchiveAvailabilityFailure,
  verifyArchiveAvailabilityReceipt,
  verifyRecordedArchiveAvailability,
  type ArchiveAvailabilityReceipt,
  type ReplayMarketDataService,
} from '../market-data/intraday/availability'
import { canonicalJsonV1Result } from '../hash'
import type { WriterFenceService } from '../execution/writer-fence'
import { Sha256Schema, strictParseOptions } from '../schemas'

const StoredReceiptsSchema = Schema.Array(Schema.Struct({ receipt: Schema.Json }))
const StoredRecordSchema = Schema.Array(Schema.Struct({ record_id: Sha256Schema, record_content_hash: Sha256Schema }))

/** Immutable first-observed upper bounds, not a claim of earliest visibility or visibility on every replica. */
export const makeArchiveAvailabilityRecorder =
  (sql: PgClient.PgClient, fence: WriterFenceService) => (receipts: readonly ArchiveAvailabilityReceipt[]) =>
    Effect.gen(function* () {
      if (receipts.length === 0) return
      const verified = yield* Effect.fromResult(
        // Validate at the persistence boundary even when the producer was our own archive reader.
        Schema.decodeUnknownResult(Schema.Array(Schema.Json))(receipts),
      )
      const decoded = yield* Effect.forEach(verified, (receipt) =>
        Effect.fromResult(verifyArchiveAvailabilityReceipt(receipt)),
      )
      const first = decoded[0]
      if (first === undefined) return
      if (
        decoded.some(
          (receipt) =>
            receipt.reader.endpointHash !== first.reader.endpointHash ||
            receipt.reader.verification !== first.reader.verification,
        ) ||
        new Set(decoded.map((receipt) => receipt.recordId)).size !== decoded.length
      ) {
        return yield* new ArchiveAvailabilityFailure({
          reason: 'identity',
          message: 'archive receipt batch mixes readers or record identities',
        })
      }
      const payload = yield* Effect.fromResult(canonicalJsonV1Result(decoded))
      yield* fence.transaction(
        Effect.gen(function* () {
          yield* sql`
            INSERT INTO intraday_archive_availability (
              reader_endpoint_hash, record_id, record_content_hash, verification,
              read_started_at, available_at, receipt_hash, receipt
            )
            SELECT
              value -> 'reader' ->> 'endpointHash', value ->> 'recordId', value ->> 'recordContentHash',
              value -> 'reader' ->> 'verification', (value ->> 'readStartedAt')::timestamptz,
              (value ->> 'availableAt')::timestamptz, value ->> 'receiptHash', value
            FROM jsonb_array_elements(${payload}::jsonb)
            ON CONFLICT (reader_endpoint_hash, record_id, verification) DO NOTHING
          `
          const stored = yield* Schema.decodeUnknownEffect(
            StoredRecordSchema,
            strictParseOptions,
          )(
            yield* sql`
            SELECT record_id, record_content_hash
            FROM intraday_archive_availability
            WHERE reader_endpoint_hash = ${first.reader.endpointHash}
              AND verification = ${first.reader.verification}
              AND record_id IN (SELECT value ->> 'recordId' FROM jsonb_array_elements(${payload}::jsonb))
          `,
          )
          const byId = new Map(stored.map((record) => [record.record_id, record.record_content_hash]))
          if (
            stored.length !== decoded.length ||
            decoded.some((receipt) => byId.get(receipt.recordId) !== receipt.recordContentHash)
          ) {
            return yield* new ArchiveAvailabilityFailure({
              reason: 'identity',
              message: 'a retained Kafka identity has conflicting archive content',
            })
          }
        }),
      )
    }).pipe(Effect.mapError(archiveAvailabilityOperationalError))

/** Uses SELECT only: research must never mint or backdate availability evidence. */
export const makeArchiveAvailabilityReader =
  (sql: PgClient.PgClient, endpointHash: string): NonNullable<ReplayMarketDataService['recordedAvailability']> =>
  (snapshot, availableBy) =>
    Effect.gen(function* () {
      const references = yield* Effect.fromResult(archiveRecordReferences(snapshot))
      const ids = yield* Effect.fromResult(canonicalJsonV1Result(references.map((reference) => reference.recordId)))
      const rows = yield* Schema.decodeUnknownEffect(
        StoredReceiptsSchema,
        strictParseOptions,
      )(
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET TRANSACTION READ ONLY`
            yield* sql`SET LOCAL statement_timeout = '30s'`
            return yield* sql`
            SELECT receipt
            FROM intraday_archive_availability
            WHERE reader_endpoint_hash = ${endpointHash}
              AND verification = 'embedded'
              AND record_id IN (SELECT jsonb_array_elements_text(${ids}::jsonb))
            ORDER BY record_id
          `
          }),
        ),
      )
      return yield* Effect.fromResult(
        verifyRecordedArchiveAvailability(
          snapshot,
          endpointHash,
          rows.map((row) => row.receipt),
          availableBy,
        ),
      )
    }).pipe(Effect.mapError(archiveAvailabilityOperationalError))
