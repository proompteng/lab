import { createHash } from 'node:crypto'
import { DateTime, Effect, FileSystem, Path, Schema, Stream } from 'effect'

import { canonicalHashV1Result, sha256 } from '../hash'
import {
  decodeNativeArrivalChunk,
  nativeArrivalCaptureId,
  NativeArrivalEpochSchema,
  type NativeArrivalChunk,
  type NativeArrivalEpoch,
} from '../market-data/streaming/native-arrival'
import { NonNegativeIntegerSchema, Sha256Schema } from '../schemas'
import {
  openBacktestSource,
  ReplaySourceFailure,
  validateBacktestSourceManifest,
  validateBacktestSourceReceipt,
} from './source'

export const NativeArrivalExportManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.native-arrival-export.v1'),
  epoch: NativeArrivalEpochSchema,
  throughOrdinal: NonNegativeIntegerSchema,
  finalChunkHash: Sha256Schema,
  dataSha256: Sha256Schema,
})

/** Export one immutable consumer prefix. Never filter markets, reset sequence numbers or stitch epochs. */
export const exportNativeArrivalPrefix = <E, R>(input: {
  readonly epoch: NativeArrivalEpoch
  readonly throughOrdinal: number
  readonly chunks: Stream.Stream<NativeArrivalChunk, E, R>
  readonly outputPath: string
}) =>
  Effect.gen(function* () {
    const { epoch, outputPath } = input
    const throughOrdinal = yield* Schema.decodeUnknownEffect(NonNegativeIntegerSchema)(input.throughOrdinal)
    if (
      (yield* Effect.fromResult(nativeArrivalCaptureId(epoch.build, epoch.bootstrap, epoch.sources))) !==
      epoch.captureId
    )
      return yield* new ReplaySourceFailure({ message: 'Export epoch identity differs' })
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(outputPath, { mode: 0o700 })
    const arrivalsPath = path.join(outputPath, 'arrivals.ndjson.gz')
    const file = yield* fs.open(arrivalsPath, { flag: 'wx', mode: 0o600 })
    const digest = createHash('sha256')
    const positions = new Map(
      epoch.bootstrap.partitions.map(({ topic, partition, startOffset }) => [
        `${topic}:${partition}`,
        { topic, partition, startOffset, endOffsetExclusive: startOffset },
      ]),
    )
    let previous: NativeArrivalChunk | undefined
    let firstAvailableAtMs: number | undefined
    yield* Stream.runForEach(input.chunks, (chunk) =>
      Effect.gen(function* () {
        const { header } = chunk
        if (
          header.captureId !== epoch.captureId ||
          header.ordinal !== (previous?.header.ordinal ?? -1) + 1 ||
          header.ordinal > throughOrdinal ||
          header.previousHash !== (previous?.contentHash ?? null) ||
          header.firstConsumerSequence !== (previous?.header.lastConsumerSequence ?? 0) + 1 ||
          header.firstAvailableAtMs < (previous?.header.lastAvailableAtMs ?? 0)
        )
          return yield* new ReplaySourceFailure({ message: 'Export chunks are not one complete ordered prefix' })
        const records = yield* Effect.fromResult(decodeNativeArrivalChunk(chunk))
        for (const record of records) {
          const position = positions.get(`${record.record.topic}:${record.record.partition}`)
          if (record.receipt.consumerEpoch !== epoch.bootstrap.epoch || position === undefined)
            return yield* new ReplaySourceFailure({
              message: 'Export record is outside the original consumer inventory',
            })
          if (BigInt(record.record.offset) < BigInt(position.startOffset))
            return yield* new ReplaySourceFailure({ message: 'Export record precedes the original bootstrap offset' })
          position.endOffsetExclusive = String(BigInt(record.record.offset) + 1n)
        }
        // Concatenated gzip members preserve the journal's exact compressed bytes and NDJSON delimiters.
        yield* file.writeAll(chunk.compressed)
        digest.update(chunk.compressed)
        firstAvailableAtMs ??= header.firstAvailableAtMs
        previous = chunk
      }),
    )
    if (previous === undefined || previous.header.ordinal !== throughOrdinal || firstAvailableAtMs === undefined)
      return yield* new ReplaySourceFailure({ message: 'Export ended before the pinned final chunk' })
    yield* file.sync
    const final = previous
    const dataSha256 = digest.digest('hex')
    const inventory = [...positions.values()].sort((a, b) =>
      a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : a.partition - b.partition,
    )
    const exportManifest: typeof NativeArrivalExportManifestSchema.Type = {
      schemaVersion: 'bayn.native-arrival-export.v1',
      epoch,
      throughOrdinal,
      finalChunkHash: final.contentHash,
      dataSha256,
    }
    const exportManifestHash = yield* Effect.fromResult(canonicalHashV1Result(exportManifest))
    const interval = {
      schemaVersion: 'bayn.native-arrival-export-interval.v1',
      exportManifestHash,
      firstConsumerSequence: 1,
      finalConsumerSequence: final.header.lastConsumerSequence,
      firstAvailableAtMs,
      lastAvailableAtMs: final.header.lastAvailableAtMs,
      positions: inventory,
    }
    const deliveryModel = {
      schemaVersion: 'bayn.original-capture-arrivals.v1',
      description: 'Complete original consumer prefix, including every captured market and disposition.',
      tieBreak: 'availability-receipt-sequence',
      captureId: epoch.captureId,
      consumerEpoch: epoch.bootstrap.epoch,
      exportManifestHash,
      intervalReceiptHash: yield* Effect.fromResult(canonicalHashV1Result(interval)),
      finalConsumerSequence: final.header.lastConsumerSequence,
    } as const
    const source = yield* Effect.fromResult(
      validateBacktestSourceManifest({
        schemaVersion: 'bayn.backtest-source.v2',
        encoding: 'ndjson-gzip',
        transport: 'original-capture',
        dataSha256,
        recordCount: final.header.lastConsumerSequence,
        coverageStartMs: firstAvailableAtMs,
        coverageEndMs: final.header.lastAvailableAtMs,
        firstAvailableAtMs,
        lastAvailableAtMs: final.header.lastAvailableAtMs,
        origin: `bayn-native-arrival:${epoch.captureId}`,
        positions: inventory,
        nativeVisiblePartitions: inventory.map(({ topic, partition }) => ({ topic, partition })),
        marketSources: epoch.sources,
        deliveryModel,
      }),
    )
    const receiptText =
      JSON.stringify({
        schemaVersion: 'bayn.original-capture-replay-receipt.v2',
        recordedAt: DateTime.formatIso(yield* DateTime.now),
        origin: source.origin,
        coverageStartMs: source.coverageStartMs,
        coverageEndMs: source.coverageEndMs,
        marketSources: source.marketSources,
        positions: source.positions,
        nativeVisiblePartitions: source.nativeVisiblePartitions,
        deliveryModel,
        sourceDataSha256: dataSha256,
      }) + '\n'
    const sourceReceiptSha256 = sha256(receiptText)
    const receipt = yield* Effect.fromResult(validateBacktestSourceReceipt(receiptText, sourceReceiptSha256))
    // Use the controls' real whole-file reader, including raw bytes, reducer dispositions and sequence checks.
    yield* openBacktestSource(arrivalsPath, source, exportManifestHash, receipt)
    for (const [name, value] of [
      ['export-manifest.json', exportManifest],
      ['interval-receipt.json', interval],
      ['source.json', source],
    ] as const)
      yield* fs.writeFileString(path.join(outputPath, name), JSON.stringify(value, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      })
    // Publish the usable receipt last. Failed and interrupted exports cannot masquerade as complete sources.
    const pendingReceipt = path.join(outputPath, 'source-receipt.json.pending')
    const receiptFile = yield* fs.open(pendingReceipt, { flag: 'wx', mode: 0o600 })
    yield* receiptFile.writeAll(new TextEncoder().encode(receiptText))
    yield* receiptFile.sync
    yield* fs.rename(pendingReceipt, path.join(outputPath, 'source-receipt.json'))
    return {
      outputPath,
      captureId: epoch.captureId,
      throughOrdinal,
      finalChunkHash: final.contentHash,
      recordCount: source.recordCount,
      firstAvailableAtMs,
      lastAvailableAtMs: source.lastAvailableAtMs,
      dataSha256,
      sourceReceiptSha256,
      exportManifestHash,
    }
  }).pipe(Effect.scoped)
