import { Data, Effect, Option, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import {
  decodeNativeArrivalChunk,
  nativeArrivalCaptureId,
  NativeArrivalEndSchema,
  NativeArrivalEpochSchema,
  type NativeArrivalChunkHeader,
} from '../market-data/streaming/native-arrival'
import { NonNegativeIntegerSchema, Sha256Schema, SourceRevisionSchema, strictParseOptions } from '../schemas'
import { CaptureDisposition } from '../market-data/streaming/transport-evidence'
import type { EvidenceArchive, EvidenceObject } from './evidence-archive'
import { evidenceObjectMaximumBytes } from './evidence-archive'
import { NativeArrivalArchivePageSchema, NativeArrivalArchiveReceiptSchema } from './native-arrival-archive-format'

export class NativeArrivalArchiveAuditFailure extends Data.TaggedError('NativeArrivalArchiveAuditFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

const decodeJson = <A>(schema: Schema.Codec<A>, body: Uint8Array) =>
  Effect.try({
    try: () => new TextDecoder('utf-8', { fatal: true }).decode(body),
    catch: (cause) => new NativeArrivalArchiveAuditFailure({ message: 'Archive metadata is not UTF-8', cause }),
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema), strictParseOptions)))

/** Reads one page and one decoded chunk at a time; never trusts a cursor or calls PostgreSQL. */
export const auditNativeArrivalArchive = (
  archive: Pick<EvidenceArchive, 'read'>,
  input: {
    readonly captureId: string
    readonly receiptHash: string
    readonly maximumPages: number
    readonly auditSourceRevision: string
  },
) =>
  Effect.gen(function* () {
    const request = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        captureId: Sha256Schema,
        receiptHash: Sha256Schema,
        auditSourceRevision: SourceRevisionSchema,
        maximumPages: NonNegativeIntegerSchema.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
      }),
      strictParseOptions,
    )(input)
    const prefix = `native-evidence/v1/arrivals/${request.captureId}/`
    const receiptKey = `${prefix}receipts/${request.receiptHash}.json`
    const stored = yield* archive.read(receiptKey, 64 * 1024)
    if (Option.isNone(stored))
      return yield* new NativeArrivalArchiveAuditFailure({ message: 'Pinned archive receipt is missing' })
    const receipt = yield* decodeJson(NativeArrivalArchiveReceiptSchema, stored.value.body)
    const { receiptHash, ...material } = receipt
    if (
      receiptHash !== request.receiptHash ||
      receipt.captureId !== request.captureId ||
      (yield* Effect.fromResult(canonicalHashV1Result(material))) !== receiptHash ||
      receipt.firstOrdinal > receipt.nextOrdinal ||
      receipt.pagesWritten > 256 ||
      Date.parse(receipt.startedAt) > Date.parse(receipt.finishedAt)
    )
      return yield* new NativeArrivalArchiveAuditFailure({
        message: 'Pinned archive receipt identity or bounds differ',
      })
    const read = (object: EvidenceObject, kind: 'epoch' | 'pages' | 'ends') =>
      Effect.gen(function* () {
        if (object.key !== `${prefix}${kind}/${object.sha256}.json` || object.bytes > evidenceObjectMaximumBytes)
          return yield* new NativeArrivalArchiveAuditFailure({
            message: 'Archive reference escapes its exact identity',
          })
        const value = yield* archive.read(object.key, object.bytes)
        if (
          Option.isNone(value) ||
          value.value.body.byteLength !== object.bytes ||
          sha256(value.value.body) !== object.sha256
        )
          return yield* new NativeArrivalArchiveAuditFailure({ message: 'Archive reference is missing or changed' })
        return value.value.body
      })
    const epoch = yield* decodeJson(NativeArrivalEpochSchema, yield* read(receipt.epoch, 'epoch'))
    if (
      epoch.captureId !== request.captureId ||
      (yield* Effect.fromResult(canonicalHashV1Result(epoch))) !== receipt.epoch.sha256 ||
      (yield* Effect.fromResult(nativeArrivalCaptureId(epoch.build, epoch.bootstrap, epoch.sources))) !==
        epoch.captureId
    )
      return yield* new NativeArrivalArchiveAuditFailure({ message: 'Archived epoch identity differs' })
    let reference = receipt.lastPage
    let nextOrdinal = receipt.nextOrdinal
    let newerHeader: NativeArrivalChunkHeader | undefined
    let lastHeader: NativeArrivalChunkHeader | undefined
    let lastChunkHash: string | null = null
    let pageCount = 0
    let runPageCount = 0
    let recordCount = 0
    let compressedBytes = 0
    let uncompressedBytes = 0
    const deliveries = epoch.bootstrap.partitions.map(({ topic, partition }) => ({
      topic,
      partition,
      records: 0,
      dispositions: {
        [CaptureDisposition.Accepted]: 0,
        [CaptureDisposition.Ignored]: 0,
        [CaptureDisposition.Rejected]: 0,
      },
      tombstones: 0,
      assignmentInvalidated: 0,
    }))
    const topics = new Map<string, Map<number, (typeof deliveries)[number]>>()
    for (const delivery of deliveries) {
      const partitions = topics.get(delivery.topic) ?? new Map()
      if (partitions.has(delivery.partition))
        return yield* new NativeArrivalArchiveAuditFailure({ message: 'Archived bootstrap repeats a partition' })
      partitions.set(delivery.partition, delivery)
      topics.set(delivery.topic, partitions)
    }
    while (reference !== null) {
      if (pageCount >= request.maximumPages)
        return yield* new NativeArrivalArchiveAuditFailure({ message: 'Full prefix exceeds the explicit page budget' })
      const page = yield* decodeJson(NativeArrivalArchivePageSchema, yield* read(reference, 'pages'))
      if (page.captureId !== epoch.captureId || page.epochHash !== receipt.epoch.sha256)
        return yield* new NativeArrivalArchiveAuditFailure({ message: 'Archive page belongs to a different epoch' })
      const first = page.chunks[0]
      if (first === undefined)
        return yield* new NativeArrivalArchiveAuditFailure({ message: 'Archive page has no original chunks' })
      if (first.header.ordinal >= receipt.firstOrdinal) runPageCount++
      else if (page.chunks.some((chunk) => chunk.header.ordinal >= receipt.firstOrdinal))
        return yield* new NativeArrivalArchiveAuditFailure({ message: 'Receipt begins inside a retained page' })
      for (const chunk of page.chunks.toReversed()) {
        const header = chunk.header
        if (
          header.captureId !== epoch.captureId ||
          header.ordinal !== nextOrdinal - 1 ||
          (newerHeader !== undefined &&
            (newerHeader.previousHash !== chunk.contentHash ||
              newerHeader.firstConsumerSequence !== header.lastConsumerSequence + 1 ||
              newerHeader.firstAvailableAtMs < header.lastAvailableAtMs))
        )
          return yield* new NativeArrivalArchiveAuditFailure({
            message: 'Archive omits or substitutes an original chunk',
          })
        const compressed = Buffer.from(chunk.compressedBase64, 'base64')
        if (compressed.toString('base64') !== chunk.compressedBase64)
          return yield* new NativeArrivalArchiveAuditFailure({ message: 'Archived chunk base64 is not canonical' })
        const records = yield* Effect.fromResult(
          decodeNativeArrivalChunk({ header, contentHash: chunk.contentHash, compressed }),
        )
        for (const record of records) {
          if (record.receipt.consumerEpoch !== epoch.bootstrap.epoch)
            return yield* new NativeArrivalArchiveAuditFailure({
              message: 'Archived delivery belongs to another consumer epoch',
            })
          const counts = topics.get(record.record.topic)?.get(record.record.partition)
          if (counts === undefined)
            return yield* new NativeArrivalArchiveAuditFailure({
              message: 'Archived delivery is outside its original partition inventory',
            })
          counts.records++
          counts.dispositions[record.receipt.disposition]++
          if (record.receipt.tombstone) counts.tombstones++
          if (record.receipt.reason === 'assignment-invalidated') counts.assignmentInvalidated++
        }
        recordCount += records.length
        compressedBytes += compressed.byteLength
        uncompressedBytes += header.uncompressedBytes
        if (lastHeader === undefined) {
          lastHeader = header
          lastChunkHash = chunk.contentHash
        }
        newerHeader = header
        nextOrdinal--
      }
      pageCount++
      reference = page.previousPage
      yield* Effect.yieldNow
    }
    if (
      nextOrdinal !== 0 ||
      runPageCount !== receipt.pagesWritten ||
      (newerHeader !== undefined && (newerHeader.previousHash !== null || newerHeader.firstConsumerSequence !== 1)) ||
      (lastHeader?.lastConsumerSequence ?? 0) !== recordCount
    )
      return yield* new NativeArrivalArchiveAuditFailure({
        message: 'Archive does not contain the full declared consumer prefix',
      })
    const end =
      receipt.end === null ? null : yield* decodeJson(NativeArrivalEndSchema, yield* read(receipt.end, 'ends'))
    if (
      end !== null &&
      (end.captureId !== epoch.captureId ||
        end.observedConsumerSequence < end.durableConsumerSequence ||
        end.durableConsumerSequence < recordCount ||
        (end.durableConsumerSequence === recordCount && end.lastChunkHash !== lastChunkHash) ||
        (end.status === 'STOPPED' &&
          (end.observedConsumerSequence !== end.durableConsumerSequence || end.reason !== null)) ||
        (receipt.caughtUpToReadCut && end.durableConsumerSequence !== recordCount))
    )
      return yield* new NativeArrivalArchiveAuditFailure({
        message: 'Archived end receipt conflicts with the retained prefix',
      })
    const report = {
      schemaVersion: 'bayn.native-arrival-archive-audit.v1',
      captureId: epoch.captureId,
      receiptHash,
      receiptBytesHash: sha256(stored.value.body),
      auditSourceRevision: request.auditSourceRevision,
      sourceRevision: epoch.build.sourceRevision,
      consumerEpoch: epoch.bootstrap.epoch,
      pages: pageCount,
      chunks: receipt.nextOrdinal,
      records: recordCount,
      compressedBytes,
      uncompressedBytes,
      firstAvailableAtMs: newerHeader?.firstAvailableAtMs ?? null,
      lastAvailableAtMs: lastHeader?.lastAvailableAtMs ?? null,
      deliveries: deliveries.toSorted((a, b) =>
        a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : a.partition - b.partition,
      ),
      end,
      caughtUpToExportReadCut: receipt.caughtUpToReadCut,
      completeRetainedPrefixBytesVerified: true,
      completeSessionCoverage: false,
      controllerCoverage: 'UNKNOWN',
      qualification: 'UNQUALIFIED',
    } as const
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof NativeArrivalArchiveAuditFailure
        ? cause
        : new NativeArrivalArchiveAuditFailure({ message: 'Native archive audit failed', cause }),
    ),
  )
