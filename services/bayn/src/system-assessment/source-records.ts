import { PgClient } from '@effect/sql-pg'
import { Effect, Result, Schema } from 'effect'

import { canonicalJsonV1Result, sha256 } from '../hash'
import { Sha256Schema, StrictNonEmptyStringSchema, strictParseOptions } from '../schemas'
import { SystemAssessmentError } from './economics'

export enum SystemSourceRecordKind {
  Decision = 'DECISION',
  Controller = 'CONTROLLER',
}

const SourceRecordTextSchema = Schema.Struct({
  recordHash: Sha256Schema,
  kind: Schema.Enum(SystemSourceRecordKind),
  payloadText: StrictNonEmptyStringSchema,
})
type SourceRecordText = typeof SourceRecordTextSchema.Type

export const makeSystemSourceRecord = (kind: SystemSourceRecordKind, payload: unknown) =>
  canonicalJsonV1Result(payload).pipe(
    Result.map((payloadText) => ({
      recordHash: sha256(`bayn.system-source-record.v1:${kind}:${payloadText}`),
      kind,
      payloadText,
    })),
  )

const decodeSystemSourceRecord = (record: SourceRecordText) =>
  Result.gen(function* () {
    const payload = yield* Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))(record.payloadText)
    const canonical = yield* canonicalJsonV1Result(payload)
    if (
      canonical !== record.payloadText ||
      sha256(`bayn.system-source-record.v1:${record.kind}:${canonical}`) !== record.recordHash
    )
      return yield* Result.fail(new SystemAssessmentError({ message: 'Archived source record digest differs' }))
    return { recordHash: record.recordHash, kind: record.kind, payload }
  })

export const readSystemSourceRecord = (hash: string) =>
  Effect.gen(function* () {
    const recordHash = yield* Schema.decodeUnknownEffect(Sha256Schema)(hash)
    const sql = yield* PgClient.PgClient
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(SourceRecordTextSchema),
      strictParseOptions,
    )(
      yield* sql`SELECT record_hash AS "recordHash", kind, payload_text AS "payloadText"
        FROM system_source_records WHERE record_hash=${recordHash}`,
    )
    const record = rows[0]
    if (rows.length !== 1 || record === undefined)
      return yield* new SystemAssessmentError({ message: 'Archived source record is missing' })
    return yield* Effect.fromResult(decodeSystemSourceRecord(record))
  }).pipe(
    Effect.mapError((cause) => new SystemAssessmentError({ message: 'Archived source record read failed', cause })),
  )

export const persistSystemSourceRecord = (record: SourceRecordText) =>
  Effect.gen(function* () {
    yield* Effect.fromResult(decodeSystemSourceRecord(record))
    const sql = yield* PgClient.PgClient
    yield* sql`INSERT INTO system_source_records(record_hash, kind, payload_text)
      VALUES (${record.recordHash}, ${record.kind}, ${record.payloadText}) ON CONFLICT (record_hash) DO NOTHING`
    return yield* readSystemSourceRecord(record.recordHash)
  }).pipe(
    Effect.mapError(
      (cause) => new SystemAssessmentError({ message: 'Archived source record persistence failed', cause }),
    ),
  )
