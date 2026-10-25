import { gzipSync, gunzipSync } from 'node:zlib'
import { Data, Result, Schema } from 'effect'

import { EmbeddedBuildMetadataSchema } from '../../build'
import { canonicalHashV1Result, sha256 } from '../../hash'
import { ImageDigestSchema, NonNegativeIntegerSchema, Sha256Schema, strictParseOptions } from '../../schemas'
import type { KafkaBootstrapEvidence } from './bootstrap'
import { StreamingSnapshotEvidenceSchema } from './evidence-schema'
import { HistoricalMarketArrivalSchema, type HistoricalMarketArrival } from './historical'
import type { KafkaConsumedRecord } from './kafka'
import { MarketSourcesSchema, type MarketSources } from './raw-events'
import { captureKafkaTransport, CaptureDisposition } from './transport-evidence'

export class NativeArrivalCaptureError extends Data.TaggedError('NativeArrivalCaptureError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const NativeArrivalEpochSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.native-arrival-epoch.v1'),
  captureId: Sha256Schema,
  build: Schema.Struct({
    ...EmbeddedBuildMetadataSchema.fields,
    imageDigest: ImageDigestSchema,
    verification: Schema.Literals(['embedded', 'development-configured']),
  }),
  bootstrap: StreamingSnapshotEvidenceSchema.fields.bootstrap,
  sources: MarketSourcesSchema,
})
export type NativeArrivalEpoch = typeof NativeArrivalEpochSchema.Type

export const nativeArrivalCaptureId = (
  build: NativeArrivalEpoch['build'],
  bootstrap: KafkaBootstrapEvidence,
  sources: MarketSources,
) =>
  canonicalHashV1Result({ schemaVersion: 'bayn.native-arrival-epoch-identity.v1', build, bootstrap, sources }).pipe(
    Result.mapError(
      (cause) => new NativeArrivalCaptureError({ message: 'Native arrival epoch identity is invalid', cause }),
    ),
  )

export interface NativeArrivalObservation {
  readonly record: KafkaConsumedRecord
  readonly availableAtMs: number
  readonly consumerSequence: number
  readonly projectionSequence: number
  readonly disposition: CaptureDisposition
  readonly assignmentInvalidated: boolean
}

export const NativeArrivalChunkHeaderSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.native-arrival-chunk.v1'),
  captureId: Sha256Schema,
  ordinal: NonNegativeIntegerSchema,
  previousHash: Schema.NullOr(Sha256Schema),
  firstConsumerSequence: NonNegativeIntegerSchema,
  lastConsumerSequence: NonNegativeIntegerSchema,
  firstAvailableAtMs: NonNegativeIntegerSchema,
  lastAvailableAtMs: NonNegativeIntegerSchema,
  uncompressedBytes: NonNegativeIntegerSchema,
  recordsHash: Sha256Schema,
  compressedHash: Sha256Schema,
})
export type NativeArrivalChunkHeader = typeof NativeArrivalChunkHeaderSchema.Type
export interface NativeArrivalChunk {
  readonly header: NativeArrivalChunkHeader
  readonly contentHash: string
  readonly compressed: Uint8Array
}
export type NativeArrival = Extract<HistoricalMarketArrival, { schemaVersion: 'bayn.original-market-arrival.v2' }>

export const nativeArrival = (epoch: NativeArrivalEpoch, input: NativeArrivalObservation): NativeArrival => ({
  schemaVersion: 'bayn.original-market-arrival.v2',
  availableAtMs: input.availableAtMs,
  record: {
    topic: input.record.topic,
    partition: input.record.partition,
    offset: input.record.offset,
    value: input.record.value,
  },
  originalTransport: captureKafkaTransport(input.record.timestampMs),
  rawValueBase64: input.record.rawValue === null ? null : Buffer.from(input.record.rawValue ?? []).toString('base64'),
  receipt: {
    captureId: epoch.captureId,
    consumerEpoch: epoch.bootstrap.epoch,
    sequence: input.consumerSequence,
    consumerSequence: input.consumerSequence,
    projectionSequence: input.projectionSequence,
    disposition: input.disposition,
    tombstone: input.record.tombstone === true,
    rawValueSha256: input.record.rawValueSha256 ?? null,
    rawByteLength: input.record.rawByteLength ?? null,
    ...(input.assignmentInvalidated ? { reason: 'assignment-invalidated' } : {}),
  },
})

export const makeNativeArrivalChunk = (
  epoch: NativeArrivalEpoch,
  ordinal: number,
  previousHash: string | null,
  records: readonly NativeArrival[],
): Result.Result<NativeArrivalChunk, NativeArrivalCaptureError> =>
  Result.gen(function* () {
    const first = records[0]
    const last = records.at(-1)
    if (first === undefined || last === undefined)
      return yield* Result.fail(new NativeArrivalCaptureError({ message: 'Cannot retain an empty arrival chunk' }))
    let previousAvailableAtMs = first.availableAtMs
    for (const [index, record] of records.entries()) {
      if (
        !Number.isSafeInteger(record.availableAtMs) ||
        record.availableAtMs < 0 ||
        record.availableAtMs < previousAvailableAtMs ||
        !Number.isSafeInteger(record.receipt.consumerSequence) ||
        record.receipt.consumerSequence < 1 ||
        record.receipt.consumerSequence !== first.receipt.consumerSequence + index ||
        record.receipt.sequence !== record.receipt.consumerSequence
      )
        return yield* Result.fail(
          new NativeArrivalCaptureError({ message: 'Native arrival chunk is not an ordered consumer prefix' }),
        )
      previousAvailableAtMs = record.availableAtMs
    }
    const text = records.map((record) => JSON.stringify(record) + '\n').join('')
    const compressed = yield* Result.try({
      try: () => gzipSync(text, { level: 1 }),
      catch: (cause) => new NativeArrivalCaptureError({ message: 'Native arrival compression failed', cause }),
    })
    const header: NativeArrivalChunkHeader = {
      schemaVersion: 'bayn.native-arrival-chunk.v1',
      captureId: epoch.captureId,
      ordinal,
      previousHash,
      firstConsumerSequence: first.receipt.consumerSequence,
      lastConsumerSequence: last.receipt.consumerSequence,
      firstAvailableAtMs: first.availableAtMs,
      lastAvailableAtMs: last.availableAtMs,
      uncompressedBytes: Buffer.byteLength(text),
      recordsHash: sha256(text),
      compressedHash: sha256(compressed),
    }
    const contentHash = yield* canonicalHashV1Result(header)
    return { header, contentHash, compressed }
  }).pipe(Result.mapError((cause) => new NativeArrivalCaptureError({ message: 'Invalid native arrival chunk', cause })))

export const decodeNativeArrivalChunk = (chunk: NativeArrivalChunk) =>
  Result.gen(function* () {
    const header = yield* Schema.decodeUnknownResult(NativeArrivalChunkHeaderSchema, strictParseOptions)(chunk.header)
    if (
      (yield* canonicalHashV1Result(header)) !== chunk.contentHash ||
      sha256(chunk.compressed) !== header.compressedHash ||
      header.uncompressedBytes > 4 * 1024 * 1024
    )
      return yield* Result.fail(new NativeArrivalCaptureError({ message: 'Native arrival chunk identity differs' }))
    const bytes = yield* Result.try({
      try: () => gunzipSync(chunk.compressed, { maxOutputLength: 4 * 1024 * 1024 }),
      catch: (cause) => new NativeArrivalCaptureError({ message: 'Native arrival decompression failed', cause }),
    })
    if (bytes.byteLength !== header.uncompressedBytes || sha256(bytes) !== header.recordsHash)
      return yield* Result.fail(new NativeArrivalCaptureError({ message: 'Native arrival bytes differ' }))
    const text = bytes.toString('utf8')
    if (!text.endsWith('\n'))
      return yield* Result.fail(
        new NativeArrivalCaptureError({ message: 'Native arrival chunk has no final delimiter' }),
      )
    const records: NativeArrival[] = []
    for (const line of text.slice(0, -1).split('\n')) {
      const raw = yield* Result.try({ try: (): unknown => JSON.parse(line), catch: (cause) => cause })
      const record = yield* Schema.decodeUnknownResult(HistoricalMarketArrivalSchema, strictParseOptions)(raw)
      if (!('schemaVersion' in record) || record.schemaVersion !== 'bayn.original-market-arrival.v2')
        return yield* Result.fail(
          new NativeArrivalCaptureError({ message: 'Native chunk contains an unreceipted arrival' }),
        )
      const previous = records.at(-1)
      const rawBytes = record.rawValueBase64 === null ? null : Buffer.from(record.rawValueBase64, 'base64')
      if (
        record.receipt.captureId !== header.captureId ||
        record.receipt.consumerSequence !== header.firstConsumerSequence + records.length ||
        record.receipt.sequence !== record.receipt.consumerSequence ||
        record.record.timestampMs !== undefined ||
        (previous !== undefined &&
          (record.availableAtMs < previous.availableAtMs ||
            record.receipt.consumerEpoch !== previous.receipt.consumerEpoch)) ||
        (rawBytes === null
          ? !record.receipt.tombstone ||
            record.record.value !== '' ||
            record.receipt.rawValueSha256 !== null ||
            record.receipt.rawByteLength !== null
          : record.receipt.tombstone ||
            rawBytes.toString('base64') !== record.rawValueBase64 ||
            sha256(rawBytes) !== record.receipt.rawValueSha256 ||
            rawBytes.byteLength !== record.receipt.rawByteLength ||
            rawBytes.toString('utf8') !== record.record.value)
      )
        return yield* Result.fail(
          new NativeArrivalCaptureError({ message: 'Native arrival lost its bytes, epoch, sequence or timing' }),
        )
      records.push(record)
    }
    if (
      records.length !== header.lastConsumerSequence - header.firstConsumerSequence + 1 ||
      records[0]?.availableAtMs !== header.firstAvailableAtMs ||
      records.at(-1)?.availableAtMs !== header.lastAvailableAtMs
    )
      return yield* Result.fail(new NativeArrivalCaptureError({ message: 'Native arrival chunk bounds differ' }))
    return records
  }).pipe(
    Result.mapError(
      (cause) => new NativeArrivalCaptureError({ message: 'Native arrival chunk verification failed', cause }),
    ),
  )
