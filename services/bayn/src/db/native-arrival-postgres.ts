import type { PgClient } from '@effect/sql-pg'
import { Effect, Schema } from 'effect'

import { canonicalJsonV1Result, sha256 } from '../hash'
import {
  decodeNativeArrivalChunk,
  NativeArrivalCaptureError,
  NativeArrivalChunkHeaderSchema,
  NativeArrivalEpochSchema,
  NativeArrivalEndSchema,
  nativeArrivalCaptureId,
  type NativeArrivalChunk,
} from '../market-data/streaming/native-arrival'
import type { NativeArrivalStore } from '../market-data/streaming/native-arrival-journal'
import { Sha256Schema, strictParseOptions } from '../schemas'

const PersistedChunk = Schema.Struct({
  content_hash: Sha256Schema,
  header: Schema.String,
  compressed: Schema.Uint8Array,
})
const error = (cause: unknown) =>
  new NativeArrivalCaptureError({ message: 'Native arrival PostgreSQL evidence write failed', cause })
const matches = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ matches: Schema.Literal(true) })]),
  strictParseOptions,
)

export const makeNativeArrivalStore = (sql: PgClient.PgClient): NativeArrivalStore => ({
  begin: (input) =>
    Effect.gen(function* () {
      const epoch = yield* Schema.decodeUnknownEffect(NativeArrivalEpochSchema, strictParseOptions)(input)
      if (
        (yield* Effect.fromResult(nativeArrivalCaptureId(epoch.build, epoch.bootstrap, epoch.sources))) !==
        epoch.captureId
      )
        return yield* error('Native capture ID differs from its build, bootstrap and sources')
      const payload = yield* Effect.fromResult(canonicalJsonV1Result(epoch))
      const hash = sha256(payload)
      yield* sql`INSERT INTO native_arrival_epochs (capture_id,content_hash,payload)
      VALUES (${epoch.captureId},${hash},${payload}) ON CONFLICT DO NOTHING`
      yield* matches(
        yield* sql`SELECT content_hash=${hash} AND payload=${payload} AS matches
      FROM native_arrival_epochs WHERE capture_id=${epoch.captureId}`,
      )
    }).pipe(Effect.mapError(error), Effect.asVoid),
  append: (chunks) =>
    Effect.gen(function* () {
      if (chunks.length === 0) return
      const first = chunks[0]
      if (first === undefined || chunks.some((chunk) => chunk.header.captureId !== first.header.captureId))
        return yield* error('Arrival batch spans more than one epoch')
      const material: { readonly chunk: NativeArrivalChunk; readonly header: string }[] = []
      for (const chunk of chunks) {
        material.push({ chunk, header: yield* Effect.fromResult(canonicalJsonV1Result(chunk.header)) })
      }
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${first.header.captureId},49181))`
          const prior = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ ordinal: Schema.String, content_hash: Sha256Schema, header: Schema.String })),
            strictParseOptions,
          )(
            yield* sql`SELECT ordinal::text,content_hash,header FROM native_arrival_chunks
            WHERE capture_id=${first.header.captureId} AND ordinal IN ${sql.in(material.map(({ chunk }) => chunk.header.ordinal))}`,
          )
          const existing = new Map(prior.map((row) => [row.ordinal, row]))
          const additions: {
            capture_id: string
            ordinal: number
            content_hash: string
            header: string
            compressed: Buffer
          }[] = []
          for (const { chunk, header } of material) {
            const stored = existing.get(String(chunk.header.ordinal))
            if (stored !== undefined) {
              if (stored.content_hash !== chunk.contentHash || stored.header !== header)
                return yield* error('Existing native arrival ordinal differs from its exact content')
            } else
              additions.push({
                capture_id: chunk.header.captureId,
                ordinal: chunk.header.ordinal,
                content_hash: chunk.contentHash,
                header,
                compressed: Buffer.from(chunk.compressed),
              })
          }
          let batch: typeof additions = []
          let bytes = 0
          for (const addition of additions) {
            if (batch.length > 0 && (batch.length >= 16 || bytes + addition.compressed.byteLength > 1024 * 1024)) {
              yield* sql`INSERT INTO native_arrival_chunks ${sql.insert(batch)}`
              batch = []
              bytes = 0
            }
            batch.push(addition)
            bytes += addition.compressed.byteLength
          }
          if (batch.length > 0) yield* sql`INSERT INTO native_arrival_chunks ${sql.insert(batch)}`
        }),
      )
    }).pipe(Effect.mapError(error)),
  end: (end) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${end.captureId},49181))`
          const prior = yield* sql`SELECT capture_id FROM native_arrival_ends WHERE capture_id=${end.captureId}`
          if (prior.length === 0)
            yield* sql`INSERT INTO native_arrival_ends (capture_id,payload) VALUES (${end.captureId},${sql.json(end)})`
          yield* matches(
            yield* sql`SELECT payload=${sql.json(end)} AS matches FROM native_arrival_ends WHERE capture_id=${end.captureId}`,
          )
        }),
      )
      .pipe(Effect.mapError(error), Effect.asVoid),
})

export const readNativeArrivalEpochRecord = (sql: PgClient.PgClient, captureId: string) =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(Sha256Schema)(captureId)
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([Schema.Struct({ content_hash: Sha256Schema, payload: Schema.String })]),
      strictParseOptions,
    )(yield* sql`SELECT content_hash,payload FROM native_arrival_epochs WHERE capture_id=${id}`)
    const row = rows[0]
    const epoch = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(NativeArrivalEpochSchema),
      strictParseOptions,
    )(row.payload)
    if (
      sha256(row.payload) !== row.content_hash ||
      epoch.captureId !== id ||
      (yield* Effect.fromResult(nativeArrivalCaptureId(epoch.build, epoch.bootstrap, epoch.sources))) !== id
    )
      return yield* error('Native capture epoch content or identity differs')
    return { epoch, payload: row.payload, contentHash: row.content_hash }
  }).pipe(Effect.mapError(error))

/** Each read bounds memory; callers retain the exact last verified ordinal between pages. */
export const readNativeArrivalChunks = (
  sql: PgClient.PgClient,
  captureId: string,
  afterOrdinal: number,
  maximumChunks: number,
) =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(Sha256Schema)(captureId)
    const { epoch } = yield* readNativeArrivalEpochRecord(sql, id)
    const after = yield* Schema.decodeUnknownEffect(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
    )(afterOrdinal)
    const limit = yield* Schema.decodeUnknownEffect(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })))(
      maximumChunks,
    )
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(PersistedChunk),
      strictParseOptions,
    )(
      yield* sql`SELECT content_hash,header,compressed FROM native_arrival_chunks
        WHERE capture_id=${id} AND ordinal>${after} ORDER BY ordinal LIMIT ${limit}`,
    )
    const chunks: NativeArrivalChunk[] = []
    for (const row of rows) {
      const header = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(NativeArrivalChunkHeaderSchema),
        strictParseOptions,
      )(row.header)
      const chunk = { header, contentHash: row.content_hash, compressed: row.compressed }
      const records = yield* Effect.fromResult(decodeNativeArrivalChunk(chunk))
      if (records.some((record) => record.receipt.consumerEpoch !== epoch.bootstrap.epoch))
        return yield* error('Native chunk belongs to a different consumer epoch')
      chunks.push(chunk)
    }
    return chunks
  }).pipe(Effect.mapError(error))

export const readNativeArrivalEnd = (sql: PgClient.PgClient, captureId: string) =>
  Effect.gen(function* () {
    const id = yield* Schema.decodeUnknownEffect(Sha256Schema)(captureId)
    const rows = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ payload: NativeArrivalEndSchema })).check(Schema.isMaxLength(1)),
      strictParseOptions,
    )(yield* sql`SELECT payload FROM native_arrival_ends WHERE capture_id=${id}`)
    const end = rows[0]?.payload ?? null
    if (end !== null && end.captureId !== id) return yield* error('Native end receipt capture identity differs')
    return end
  }).pipe(Effect.mapError(error))
