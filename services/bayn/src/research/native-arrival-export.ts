import { Data, Effect, Option, Result, Schema } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result, sha256 } from '../hash'
import {
  NativeArrivalCaptureError,
  NativeArrivalEpochSchema,
  nativeArrivalCaptureId,
  type NativeArrivalChunk,
} from '../market-data/streaming/native-arrival'
import { NativeArrivalEndSchema } from '../market-data/streaming/native-arrival'
import { NonNegativeIntegerSchema, Sha256Schema, strictParseOptions } from '../schemas'
import { currentUtcInstant } from '../time'
import type { EvidenceArchive } from './evidence-archive'
import { EvidenceObjectSchema, NativeArrivalArchivePageSchema } from './native-arrival-archive-format'

export class NativeArrivalExportFailure extends Data.TaggedError('NativeArrivalExportFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const CursorMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.native-arrival-export-cursor.v1'),
  captureId: Sha256Schema,
  epochHash: Sha256Schema,
  nextOrdinal: NonNegativeIntegerSchema,
  lastChunkHash: Schema.NullOr(Sha256Schema),
  lastConsumerSequence: NonNegativeIntegerSchema,
  lastAvailableAtMs: NonNegativeIntegerSchema,
  lastPage: Schema.NullOr(EvidenceObjectSchema),
})
const CursorSchema = Schema.Struct({ ...CursorMaterialSchema.fields, cursorHash: Sha256Schema })
type Cursor = typeof CursorMaterialSchema.Type
export interface NativeArrivalExportSource {
  readonly epoch: Effect.Effect<
    {
      readonly epoch: typeof NativeArrivalEpochSchema.Type
      readonly payload: string
      readonly contentHash: string
    },
    NativeArrivalCaptureError
  >
  readonly chunks: (afterOrdinal: number) => Effect.Effect<readonly NativeArrivalChunk[], NativeArrivalCaptureError>
  readonly end: Effect.Effect<typeof NativeArrivalEndSchema.Type | null, NativeArrivalCaptureError>
}
const encode = (value: unknown) =>
  canonicalJsonV1Result(value).pipe(Result.map((text) => new TextEncoder().encode(text)))
const utf8 = (bytes: Uint8Array) =>
  Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    catch: (cause) => new NativeArrivalExportFailure({ message: 'Retained arrival metadata is not UTF-8', cause }),
  })

export const exportNativeArrivalPrefix = (
  source: NativeArrivalExportSource,
  archive: EvidenceArchive,
  maximumPages: number,
) =>
  Effect.gen(function* () {
    const pages = yield* Schema.decodeUnknownEffect(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 256 })))(
      maximumPages,
    )
    const startedAt = yield* currentUtcInstant
    const record = yield* source.epoch
    const epoch = yield* Schema.decodeUnknownEffect(NativeArrivalEpochSchema, strictParseOptions)(record.epoch)
    if (
      sha256(record.payload) !== record.contentHash ||
      (yield* Effect.fromResult(nativeArrivalCaptureId(epoch.build, epoch.bootstrap, epoch.sources))) !==
        epoch.captureId ||
      (yield* Effect.fromResult(canonicalHashV1Result(epoch))) !== record.contentHash
    )
      return yield* new NativeArrivalExportFailure({
        message: 'Native epoch bytes, content or capture identity differ',
      })
    const prefix = `native-evidence/v1/arrivals/${epoch.captureId}/`
    const epochObject = yield* archive.retain(
      `${prefix}epoch/${record.contentHash}.json`,
      new TextEncoder().encode(record.payload),
    )
    const checkpointKey = `${prefix}cursor.json`
    const stored = yield* archive.read(checkpointKey, 4096)
    let cursor: Cursor = {
      schemaVersion: 'bayn.native-arrival-export-cursor.v1',
      captureId: epoch.captureId,
      epochHash: record.contentHash,
      nextOrdinal: 0,
      lastChunkHash: null,
      lastConsumerSequence: 0,
      lastAvailableAtMs: 0,
      lastPage: null,
    }
    let etag: string | null = null
    if (Option.isSome(stored)) {
      const { cursorHash, ...material } = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(CursorSchema),
        strictParseOptions,
      )(yield* utf8(stored.value.body))
      if (
        (yield* Effect.fromResult(canonicalHashV1Result(material))) !== cursorHash ||
        material.captureId !== epoch.captureId ||
        material.epochHash !== record.contentHash ||
        material.nextOrdinal < 1 ||
        material.lastChunkHash === null ||
        material.lastPage === null ||
        !material.lastPage.key.startsWith(`${prefix}pages/`)
      )
        return yield* new NativeArrivalExportFailure({
          message: 'Retained arrival checkpoint has a different identity or invalid boundary',
        })
      const anchor = yield* source.chunks(material.nextOrdinal - 2)
      if (
        anchor[0]?.header.ordinal !== material.nextOrdinal - 1 ||
        anchor[0]?.contentHash !== material.lastChunkHash ||
        anchor[0]?.header.lastConsumerSequence !== material.lastConsumerSequence ||
        anchor[0]?.header.lastAvailableAtMs !== material.lastAvailableAtMs
      )
        return yield* new NativeArrivalExportFailure({
          message: 'Arrival checkpoint does not match its exact database anchor',
        })
      const previousPage = yield* archive.read(material.lastPage.key, material.lastPage.bytes)
      if (Option.isNone(previousPage) || sha256(previousPage.value.body) !== material.lastPage.sha256)
        return yield* new NativeArrivalExportFailure({
          message: 'Arrival checkpoint refers to a missing or changed page',
        })
      const page = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(NativeArrivalArchivePageSchema),
        strictParseOptions,
      )(yield* utf8(previousPage.value.body))
      if (
        page.captureId !== material.captureId ||
        page.epochHash !== material.epochHash ||
        page.chunks.at(-1)?.contentHash !== material.lastChunkHash ||
        page.chunks.at(-1)?.header.ordinal !== material.nextOrdinal - 1
      )
        return yield* new NativeArrivalExportFailure({
          message: 'Arrival checkpoint does not bind its retained page boundary',
        })
      cursor = material
      etag = stored.value.etag
    }
    const firstOrdinal = cursor.nextOrdinal
    let writtenPages = 0
    let caughtUpToReadCut = false
    for (; writtenPages < pages; writtenPages++) {
      const chunks = yield* source.chunks(cursor.nextOrdinal - 1)
      if (chunks.length === 0) {
        caughtUpToReadCut = true
        break
      }
      if (chunks.length > 8)
        return yield* new NativeArrivalExportFailure({ message: 'Arrival source exceeded the eight-chunk page bound' })
      let next = cursor
      for (const chunk of chunks) {
        if (
          chunk.header.captureId !== epoch.captureId ||
          chunk.header.ordinal !== next.nextOrdinal ||
          chunk.header.previousHash !== next.lastChunkHash ||
          chunk.header.firstConsumerSequence !== next.lastConsumerSequence + 1 ||
          chunk.header.firstAvailableAtMs < next.lastAvailableAtMs
        )
          return yield* new NativeArrivalExportFailure({
            message: 'Native arrival page skips or substitutes the retained chain',
          })
        next = {
          ...next,
          nextOrdinal: next.nextOrdinal + 1,
          lastChunkHash: chunk.contentHash,
          lastConsumerSequence: chunk.header.lastConsumerSequence,
          lastAvailableAtMs: chunk.header.lastAvailableAtMs,
        }
      }
      const body = yield* Effect.fromResult(
        encode({
          schemaVersion: 'bayn.native-arrival-export-page.v1',
          captureId: epoch.captureId,
          epochHash: record.contentHash,
          previousPage: cursor.lastPage,
          chunks: chunks.map((chunk) => ({
            header: chunk.header,
            contentHash: chunk.contentHash,
            compressedBase64: Buffer.from(chunk.compressed).toString('base64'),
          })),
        }),
      )
      const page = yield* archive.retain(`${prefix}pages/${sha256(body)}.json`, body)
      next = { ...next, lastPage: page }
      const cursorHash = yield* Effect.fromResult(canonicalHashV1Result(next))
      const checkpoint = yield* Effect.fromResult(encode({ ...next, cursorHash }))
      etag = yield* archive.checkpoint(checkpointKey, checkpoint, etag)
      cursor = next
    }
    const end = yield* source.end
    if (
      end !== null &&
      (end.captureId !== epoch.captureId ||
        end.observedConsumerSequence < end.durableConsumerSequence ||
        end.durableConsumerSequence < cursor.lastConsumerSequence ||
        (end.durableConsumerSequence === cursor.lastConsumerSequence && end.lastChunkHash !== cursor.lastChunkHash) ||
        (end.status === 'STOPPED' &&
          (end.observedConsumerSequence !== end.durableConsumerSequence || end.reason !== null)))
    )
      return yield* new NativeArrivalExportFailure({ message: 'Native end receipt conflicts with the exported prefix' })
    const endObject =
      end === null
        ? null
        : yield* Effect.gen(function* () {
            const body = yield* Effect.fromResult(encode(end))
            return yield* archive.retain(`${prefix}ends/${sha256(body)}.json`, body)
          })
    const material = {
      schemaVersion: 'bayn.native-arrival-export.v1',
      captureId: epoch.captureId,
      epoch: epochObject,
      startedAt,
      finishedAt: yield* currentUtcInstant,
      firstOrdinal,
      nextOrdinal: cursor.nextOrdinal,
      pagesWritten: writtenPages,
      lastPage: cursor.lastPage,
      end: endObject,
      caughtUpToReadCut:
        caughtUpToReadCut && (end === null || end.durableConsumerSequence === cursor.lastConsumerSequence),
      qualification: 'UNQUALIFIED',
      sourceCoverage: 'RETAINED_NATIVE_PREFIX',
      completeSessionCoverage: false,
      limitations: [
        'Cursor is a resumable checkpoint, not a qualification seal. Independently verify every retained page and source/session denominator.',
        'Missing end receipts, interrupted consumer scopes, source gaps and incomplete sessions remain missing evidence.',
      ],
    } as const
    const receiptHash = yield* Effect.fromResult(canonicalHashV1Result(material))
    const receipt = { ...material, receiptHash }
    yield* archive.retain(`${prefix}receipts/${receiptHash}.json`, yield* Effect.fromResult(encode(receipt)))
    return receipt
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof NativeArrivalExportFailure
        ? cause
        : new NativeArrivalExportFailure({
            message: 'Native arrival export did not complete; retained pages remain available',
            cause,
          }),
    ),
  )
