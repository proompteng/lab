import { gzipSync } from 'node:zlib'
import { Effect, Result, Schema } from 'effect'

import { canonicalHashV1, sha256 } from '../hash'
import { validateBacktestSourceManifest, validateBacktestSourceReceipt } from '../intraday-replay/source'
import {
  advanceHistoricalMarketCursor,
  createHistoricalMarketCursor,
  type HistoricalMarketArrival,
  type HistoricalMarketCursor,
} from '../market-data/streaming/historical'
import type { StreamingUniverse } from '../market-data/streaming/raw-events'
import { strictParseOptions } from '../schemas'
import {
  CaptureIntervalRequestSchema,
  ResearchCaptureFailure,
  decodeResearchCaptureChunk,
  maximumResearchCaptureChunkBytes,
  type CaptureIntervalRequest,
  type ResearchCaptureBytes,
} from './capture'
import {
  deriveResearchCaptureExportManifest,
  ResearchCaptureByteIndexSchema,
  ResearchCaptureExportManifestSchema,
  verifyResearchCaptureExportPrefix,
} from './export'

type ExportChunks = Parameters<typeof verifyResearchCaptureExportPrefix>[0]
const fail = (message: string, cause?: unknown) =>
  new ResearchCaptureFailure({ message, ...(cause === undefined ? {} : { cause }) })
const inventory = (rows: readonly { readonly topic: string; readonly partition: number }[]) =>
  rows.map(({ topic, partition }) => `${topic}:${partition}`).join('|')

/** The independently selected request and universe are not inferred from the retained records. */
export const replayResearchCaptureInterval = (
  chunks: ExportChunks,
  sealBytes: ResearchCaptureBytes,
  manifestBytes: ResearchCaptureBytes,
  request: CaptureIntervalRequest,
  universe: StreamingUniverse,
) =>
  Result.gen(function* () {
    const requested = yield* Schema.decodeUnknownResult(CaptureIntervalRequestSchema, strictParseOptions)(request)
    const verified = yield* verifyResearchCaptureExportPrefix(chunks, sealBytes, manifestBytes)
    if (!verified.continuous || verified.seal.invalidations.length !== 0)
      return yield* Result.fail(fail('An invalidated or incomplete observation prefix cannot prove an interval'))
    const receipts = []
    const rawBySequence = new Map<number, Uint8Array | null>()
    for (const bytes of chunks) {
      const chunk = yield* decodeResearchCaptureChunk(bytes.metadata)
      const index = yield* Schema.decodeUnknownResult(
        Schema.fromJsonString(ResearchCaptureByteIndexSchema),
        strictParseOptions,
      )(bytes.index.payload)
      receipts.push(...chunk.receipts)
      for (const range of index.ranges)
        rawBySequence.set(
          range.receiptSequence,
          range.byteOffset === null || range.byteLength === null
            ? null
            : bytes.raw.subarray(range.byteOffset, range.byteOffset + range.byteLength),
        )
    }
    const cuts = receipts.filter(
      (receipt) => receipt.event.kind === 'consumer-interval-cut' && receipt.event.intervalId === requested.intervalId,
    )
    const cutReceipt = cuts[0]
    if (cuts.length !== 1 || cutReceipt?.event.kind !== 'consumer-interval-cut')
      return yield* Result.fail(fail('The sealed prefix must contain exactly one actual interval cut'))
    const cut = cutReceipt.event
    const selectedRequest = {
      intervalId: cut.intervalId,
      coverageStartMs: cut.coverageStartMs,
      coverageEndMs: cut.coverageEndMs,
      universeHash: cut.universeHash,
      expectedPartitions: cut.expectedPartitions,
    }
    if (
      canonicalHashV1(requested) !== canonicalHashV1(selectedRequest) ||
      cut.universeHash !== canonicalHashV1(universe)
    )
      return yield* Result.fail(fail('Capture interval differs from the independently selected request or universe'))
    const assignments = receipts.filter(
      (receipt) =>
        receipt.sequence < cutReceipt.sequence &&
        receipt.event.kind === 'consumer-boundary' &&
        receipt.event.consumerEpoch === cut.consumerEpoch &&
        receipt.event.phase === 'ASSIGNED',
    )
    const assignment = assignments[0]
    if (
      assignments.length !== 1 ||
      assignment?.event.kind !== 'consumer-boundary' ||
      assignment.event.bootstrap === undefined
    )
      return yield* Result.fail(fail('Capture interval lacks its unique native assignment and bootstrap'))
    const bootstrap = assignment.event.bootstrap
    const expected = inventory(requested.expectedPartitions)
    const topics = Object.values(universe.topics)
    if (
      bootstrap.epoch !== cut.consumerEpoch ||
      assignment.observedAtMs > requested.coverageStartMs ||
      requested.coverageStartMs > requested.coverageEndMs ||
      cut.committedFence.lookupStartedAtMs < requested.coverageEndMs ||
      cut.committedFence.lookupCompletedAtMs < cut.committedFence.lookupStartedAtMs ||
      cutReceipt.observedAtMs < cut.committedFence.lookupCompletedAtMs ||
      expected !== inventory(bootstrap.partitions) ||
      expected !== inventory(assignment.event.positions) ||
      expected !== inventory(cut.committedFence.positions) ||
      expected !== inventory(cut.drainedPositions) ||
      new Set(requested.expectedPartitions.map(({ topic, partition }) => `${topic}:${partition}`)).size !==
        requested.expectedPartitions.length ||
      topics.some((topic) => !requested.expectedPartitions.some((position) => position.topic === topic)) ||
      requested.expectedPartitions.some((position) => !topics.includes(position.topic))
    )
      return yield* Result.fail(fail('Capture interval has missing partitions or unobserved/backdated boundaries'))
    const positions = []
    for (const [index, start] of bootstrap.partitions.entries()) {
      const assigned = assignment.event.positions[index]
      const fence = cut.committedFence.positions[index]
      const drained = cut.drainedPositions[index]
      if (
        assigned === undefined ||
        fence === undefined ||
        drained === undefined ||
        assigned.offset !== start.startOffset ||
        BigInt(start.logStartOffset) > BigInt(start.startOffset) ||
        BigInt(start.startOffset) > BigInt(start.endOffset) ||
        BigInt(start.endOffset) > BigInt(fence.offset) ||
        BigInt(fence.offset) > BigInt(drained.offset)
      )
        return yield* Result.fail(fail('Capture interval does not reach its sampled committed fence'))
      positions.push({
        topic: start.topic,
        partition: start.partition,
        startOffset: start.startOffset,
        endOffsetExclusive: drained.offset,
      })
    }
    const within = receipts.filter(
      (receipt) => receipt.sequence > assignment.sequence && receipt.sequence < cutReceipt.sequence,
    )
    if (
      within.some(
        (receipt) =>
          receipt.event.kind === 'consumer-boundary' &&
          (receipt.event.consumerEpoch !== cut.consumerEpoch ||
            receipt.event.phase === 'INVALIDATED' ||
            receipt.event.phase === 'STOPPED' ||
            receipt.event.phase === 'STARTED'),
      ) ||
      !within.some(
        (receipt) =>
          receipt.event.kind === 'consumer-boundary' &&
          receipt.event.phase === 'BOOTSTRAPPED' &&
          receipt.event.consumerEpoch === cut.consumerEpoch,
      )
    )
      return yield* Result.fail(fail('Capture interval crosses a failed, incomplete or changed consumer epoch'))
    const markets = receipts.filter(
      (receipt) =>
        receipt.sequence < cutReceipt.sequence &&
        receipt.event.kind === 'market-record' &&
        receipt.event.consumerEpoch === cut.consumerEpoch,
    )
    if (markets.length !== cut.finalConsumerSequence || markets.length === 0)
      return yield* Result.fail(
        fail('Capture interval omits delivered records or has no replayable market observations'),
      )
    const deliveryModel = {
      schemaVersion: 'bayn.original-capture-arrivals.v1' as const,
      description:
        'Original native-visible read-committed input through the recorded drained cut; later commits and controller completeness are not claimed.',
      tieBreak: 'availability-receipt-sequence' as const,
      captureId: verified.seal.captureId,
      consumerEpoch: cut.consumerEpoch,
      exportManifestHash: manifestBytes.contentHash,
      intervalReceiptHash: canonicalHashV1(cutReceipt),
      finalConsumerSequence: cut.finalConsumerSequence,
    }
    const events: HistoricalMarketArrival[] = []
    let cursor: HistoricalMarketCursor = yield* createHistoricalMarketCursor(canonicalHashV1(deliveryModel), universe)
    for (const [index, receipt] of markets.entries()) {
      const event = receipt.event
      if (event.kind !== 'market-record' || event.originalTransport === undefined)
        return yield* Result.fail(fail('Capture interval omits original transport metadata'))
      const raw = rawBySequence.get(receipt.sequence)
      const bound = positions.find(
        (position) => position.topic === event.topic && position.partition === event.partition,
      )
      if (
        receipt.sequence <= assignment.sequence ||
        event.consumerSequence !== index + 1 ||
        raw === undefined ||
        event.tombstone ||
        event.reason === 'assignment-invalidated' ||
        bound === undefined ||
        BigInt(event.offset) < BigInt(bound.startOffset) ||
        BigInt(event.offset) >= BigInt(bound.endOffsetExclusive)
      )
        return yield* Result.fail(fail('Capture interval omits a delivery or contains a failed/out-of-cut record'))
      const arrival: HistoricalMarketArrival = {
        schemaVersion: 'bayn.original-market-arrival.v2',
        availableAtMs: receipt.observedAtMs,
        record: {
          topic: event.topic,
          partition: event.partition,
          offset: event.offset,
          value: raw === null ? '' : Buffer.from(raw).toString('utf8'),
        },
        originalTransport: event.originalTransport,
        rawValueBase64: raw === null ? null : Buffer.from(raw).toString('base64'),
        receipt: {
          captureId: verified.seal.captureId,
          consumerEpoch: event.consumerEpoch,
          sequence: receipt.sequence,
          consumerSequence: event.consumerSequence,
          projectionSequence: event.projectionSequence,
          disposition: event.disposition,
          tombstone: event.tombstone,
          rawValueSha256: event.rawValueSha256,
          rawByteLength: event.rawByteLength,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        },
      }
      cursor = yield* advanceHistoricalMarketCursor(cursor, arrival)
      events.push(arrival)
    }
    const bytes = yield* Result.try({
      try: () => gzipSync(events.map((event) => JSON.stringify(event)).join('\n') + '\n'),
      catch: (cause) => fail('Cannot encode original replay arrivals', cause),
    })
    const first = events[0]
    const last = events.at(-1)
    if (first === undefined || last === undefined) return yield* Result.fail(fail('Capture interval has no arrivals'))
    const manifest = yield* validateBacktestSourceManifest({
      schemaVersion: 'bayn.backtest-source.v1',
      encoding: 'ndjson-gzip',
      transport: 'original-capture',
      dataSha256: sha256(bytes),
      recordCount: events.length,
      coverageStartMs: assignment.observedAtMs,
      coverageEndMs: cutReceipt.observedAtMs,
      firstAvailableAtMs: first.availableAtMs,
      lastAvailableAtMs: last.availableAtMs,
      origin: `original-capture:${verified.seal.captureId}:${cut.intervalId}`,
      positions,
      nativeVisiblePartitions: requested.expectedPartitions,
      universe,
      deliveryModel,
    })
    const recordedAt = yield* Result.try({
      try: () => new Date(verified.seal.closedAtMs).toISOString(),
      catch: (cause) => fail('Capture seal timestamp cannot be represented', cause),
    })
    const receiptPayload = JSON.stringify({
      schemaVersion: 'bayn.original-capture-replay-receipt.v1',
      recordedAt,
      origin: manifest.origin,
      coverageStartMs: manifest.coverageStartMs,
      coverageEndMs: manifest.coverageEndMs,
      universe,
      positions,
      nativeVisiblePartitions: requested.expectedPartitions,
      deliveryModel,
      sourceDataSha256: manifest.dataSha256,
    })
    const sourceReceipt = yield* validateBacktestSourceReceipt(receiptPayload, sha256(receiptPayload))
    return {
      bytes,
      manifest,
      sourceReceipt,
      receiptBytes: { contentHash: sha256(receiptPayload), payload: receiptPayload },
      events,
      cursor,
      cut: cutReceipt,
      structurallyClosed: verified.structurallyClosed,
      qualification: verified.seal.qualification,
      controllerReceipts: within.filter((receipt) => receipt.event.kind === 'controller-pass'),
      controllerCoverage: 'UNKNOWN' as const,
    }
  })

/** Readers must enforce the supplied byte limit while receiving each object. No listing or ambient credentials. */
export const readResearchCaptureInterval = (input: {
  readonly seal: ResearchCaptureBytes
  readonly maximumBytes: number
  readonly readObject: (contentHash: string, maximumBytes: number) => Effect.Effect<Uint8Array, ResearchCaptureFailure>
  readonly readMetadataChunk: (ordinal: number) => Effect.Effect<ResearchCaptureBytes, ResearchCaptureFailure>
  readonly request: CaptureIntervalRequest
  readonly universe: StreamingUniverse
}) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes <= 0)
      return yield* fail('Capture reader requires a finite positive byte budget')
    let remaining = input.maximumBytes - Buffer.byteLength(input.seal.payload)
    const read = (hash: string) =>
      Effect.gen(function* () {
        if (remaining <= 0) return yield* fail('Capture export exceeds its read budget')
        const limit = Math.min(remaining, maximumResearchCaptureChunkBytes)
        const payload = yield* input.readObject(hash, limit)
        if (!(payload instanceof Uint8Array) || payload.byteLength > limit || sha256(payload) !== hash)
          return yield* fail('Capture object exceeds its read bound or differs from its content address')
        remaining -= payload.byteLength
        return { contentHash: hash, payload }
      })
    const asText = (object: { readonly contentHash: string; readonly payload: Uint8Array }): ResearchCaptureBytes => ({
      contentHash: object.contentHash,
      payload: Buffer.from(object.payload).toString('utf8'),
    })
    const expected = yield* Effect.fromResult(deriveResearchCaptureExportManifest(input.seal))
    const manifestBytes = asText(yield* read(expected.contentHash))
    const manifest = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(ResearchCaptureExportManifestSchema),
      strictParseOptions,
    )(manifestBytes.payload)
    const sealObject = asText(yield* read(manifest.metadataSeal.contentHash))
    if (sealObject.payload !== input.seal.payload || sealObject.contentHash !== input.seal.contentHash)
      return yield* fail('Durable SQL seal differs from its exported object')
    const chunks: Array<ExportChunks[number]> = []
    let hash = manifest.lastIndexHash
    for (let ordinal = manifest.exportedChunks - 1; ordinal >= 0; ordinal--) {
      if (hash === null) return yield* fail('Capture index chain omits its declared tail')
      const indexBytes = asText(yield* read(hash))
      const index = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ResearchCaptureByteIndexSchema),
        strictParseOptions,
      )(indexBytes.payload)
      const metadata = asText(yield* read(index.metadata.contentHash))
      const sqlMetadata = yield* input.readMetadataChunk(ordinal)
      if (metadata.contentHash !== sqlMetadata.contentHash || metadata.payload !== sqlMetadata.payload)
        return yield* fail('Exported metadata differs from its exact SQL chunk')
      const raw = yield* read(index.raw.contentHash)
      chunks.push({ index: indexBytes, metadata, raw: raw.payload })
      hash = index.previousIndexHash
    }
    if (hash !== null) return yield* fail('Capture index chain exceeds the declared frontier')
    return yield* Effect.fromResult(
      replayResearchCaptureInterval(chunks.reverse(), input.seal, manifestBytes, input.request, input.universe),
    )
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ResearchCaptureFailure
        ? cause
        : new ResearchCaptureFailure({ message: 'Cannot read original capture interval', cause }),
    ),
  )
