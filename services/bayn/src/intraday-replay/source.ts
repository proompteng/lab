import { createHash } from 'node:crypto'
import { createGunzip } from 'node:zlib'
import { NodeStream } from '@effect/platform-node'
import { Cause, Data, Effect, FileSystem, Option, Pull, Result, Schema, Semaphore, Stream } from 'effect'
import { canonicalHashV1Result, sha256 } from '../hash'
import {
  HistoricalMarketArrivalSchema,
  advanceHistoricalMarketCursor,
  arrivalPosition,
  compareArrivalPositions,
  createHistoricalMarketCursor,
  type HistoricalMarketArrival,
  type HistoricalMarketCursor,
} from '../market-data/streaming/historical'
import { OriginalCaptureDeliverySchema, SimulatedSnapshotSourceSchema } from '../market-data/streaming/evidence-schema'
import {
  NonNegativeIntegerSchema,
  PositiveIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'

const SourcePositionSchema = Schema.Struct({
  topic: StrictNonEmptyStringSchema,
  partition: NonNegativeIntegerSchema,
  startOffset: UnsignedMicrosSchema,
  endOffsetExclusive: UnsignedMicrosSchema,
})
const UnobservedArchivePartitionSchema = Schema.Struct({
  topic: StrictNonEmptyStringSchema,
  partition: NonNegativeIntegerSchema,
})
export const BacktestSourceManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.backtest-source.v1'),
  encoding: Schema.Literal('ndjson-gzip'),
  transport: Schema.Literals(['captured-kafka', 'alpaca-rest', 'archive-reconstruction', 'original-capture']),
  dataSha256: Sha256Schema,
  recordCount: PositiveIntegerSchema,
  coverageStartMs: NonNegativeIntegerSchema,
  coverageEndMs: NonNegativeIntegerSchema,
  firstAvailableAtMs: NonNegativeIntegerSchema,
  lastAvailableAtMs: NonNegativeIntegerSchema,
  origin: StrictNonEmptyStringSchema,
  positions: Schema.Array(SourcePositionSchema).check(Schema.isMinLength(1)),
  archiveUnobservedPartitions: Schema.optionalKey(Schema.Array(UnobservedArchivePartitionSchema)),
  nativeVisiblePartitions: Schema.optionalKey(Schema.Array(UnobservedArchivePartitionSchema)),
  universe: Schema.Struct({
    universeId: StrictNonEmptyStringSchema,
    universeSymbolHash: Sha256Schema,
    symbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1)),
    topics: Schema.Struct({
      bars: StrictNonEmptyStringSchema,
      quotes: StrictNonEmptyStringSchema,
      trades: StrictNonEmptyStringSchema,
      features: StrictNonEmptyStringSchema,
      technicalFeatures: Schema.optionalKey(StrictNonEmptyStringSchema),
    }),
  }),
  deliveryModel: SimulatedSnapshotSourceSchema.fields.deliveryModel,
  regeneratedFeaturesRecordedAtMs: Schema.optionalKey(NonNegativeIntegerSchema),
  regeneratedTechnicalFeaturesRecordedAtMs: Schema.optionalKey(NonNegativeIntegerSchema),
})
export type BacktestSourceManifest = typeof BacktestSourceManifestSchema.Type
export class ReplaySourceFailure extends Data.TaggedError('ReplaySourceFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}
const fail = (message: string, cause?: unknown) => new ReplaySourceFailure({ message, cause })
const partitionKey = (topic: string, partition: number) => `${topic}:${partition}`

const CapturedKafkaSourceReceiptSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.replay-source-capture.v1'),
  capturedAt: UtcInstantSchema,
  origin: StrictNonEmptyStringSchema,
  coverageStartMs: NonNegativeIntegerSchema,
  coverageEndMs: NonNegativeIntegerSchema,
  universe: BacktestSourceManifestSchema.fields.universe,
  positions: BacktestSourceManifestSchema.fields.positions,
})

export const BacktestSourceReceiptSchema = Schema.Union([
  CapturedKafkaSourceReceiptSchema,
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.original-capture-replay-receipt.v1'),
    recordedAt: UtcInstantSchema,
    origin: StrictNonEmptyStringSchema,
    coverageStartMs: NonNegativeIntegerSchema,
    coverageEndMs: NonNegativeIntegerSchema,
    universe: BacktestSourceManifestSchema.fields.universe,
    positions: BacktestSourceManifestSchema.fields.positions,
    nativeVisiblePartitions: Schema.Array(UnobservedArchivePartitionSchema).check(Schema.isMinLength(1)),
    deliveryModel: OriginalCaptureDeliverySchema,
    sourceDataSha256: Sha256Schema,
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.archive-reconstruction-receipt.v1'),
    recordedAt: UtcInstantSchema,
    origin: StrictNonEmptyStringSchema,
    queryHashes: Schema.Array(Sha256Schema).check(Schema.isMinLength(1), Schema.isUnique()),
    archiveResponseHashes: Schema.Array(Sha256Schema).check(Schema.isMinLength(1), Schema.isUnique()),
    sourceDataSha256: Sha256Schema,
    normalization: Schema.Literal('bayn.archive-envelope-reconstruction.v1'),
    originalStreamAvailability: Schema.Literal('NOT_OBSERVED'),
    completeness: Schema.Literal('RETAINED_ROWS_ONLY'),
    emptyPartitions: Schema.Literal('NO_RETAINED_RECORDS_NOT_PROOF_OF_EMPTY_LOG'),
    archiveUnobservedPartitions: Schema.optionalKey(Schema.Array(UnobservedArchivePartitionSchema)),
    coverageStartMs: NonNegativeIntegerSchema,
    coverageEndMs: NonNegativeIntegerSchema,
    universe: BacktestSourceManifestSchema.fields.universe,
    positions: BacktestSourceManifestSchema.fields.positions,
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.alpaca-rest-replay-receipt.v2'),
    recordedAt: UtcInstantSchema,
    origin: StrictNonEmptyStringSchema,
    datasetId: Sha256Schema,
    acquiredSymbols: Schema.Array(SymbolSchema).check(Schema.isMinLength(1), Schema.isUnique()),
    unacquiredSymbols: Schema.Array(SymbolSchema).check(Schema.isUnique()),
    rawChunkHashes: Schema.Array(Sha256Schema).check(Schema.isMinLength(1), Schema.isUnique()),
    featureReceiptHash: Sha256Schema,
    sourceDataSha256: Sha256Schema,
    normalization: Schema.Literal('bayn.alpaca-rest-arrivals.v2'),
    coordinates: Schema.Literal('virtual-topic-partition-zero-offset-order'),
    originalStreamAvailability: Schema.Literal('NOT_OBSERVED'),
    coverageStartMs: NonNegativeIntegerSchema,
    coverageEndMs: NonNegativeIntegerSchema,
    universe: BacktestSourceManifestSchema.fields.universe,
    positions: BacktestSourceManifestSchema.fields.positions,
  }),
])

/** The expected hash is supplied by the capture authority, independently of the editable session manifest. */
export const validateBacktestSourceReceipt = (text: string, expectedHash: string) =>
  Result.gen(function* () {
    yield* Schema.decodeUnknownResult(Sha256Schema)(expectedHash)
    if (sha256(text) !== expectedHash)
      return yield* Result.fail(fail('Source capture bytes differ from the independently pinned capture hash'))
    const value = yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(BacktestSourceReceiptSchema),
      strictParseOptions,
    )(text)
    if (
      value.coverageStartMs > value.coverageEndMs ||
      Date.parse(value.schemaVersion === 'bayn.replay-source-capture.v1' ? value.capturedAt : value.recordedAt) <
        value.coverageEndMs
    )
      return yield* Result.fail(fail('Source capture must observe the complete export interval'))
    if (
      value.schemaVersion === 'bayn.alpaca-rest-replay-receipt.v2' &&
      (value.acquiredSymbols.join(',') !== [...value.acquiredSymbols].sort().join(',') ||
        value.acquiredSymbols.some((symbol) => !value.universe.symbols.includes(symbol)) ||
        value.unacquiredSymbols.join(',') !==
          value.universe.symbols.filter((symbol) => !value.acquiredSymbols.includes(symbol)).join(','))
    )
      return yield* Result.fail(
        fail('REST receipt must distinguish acquired symbols from unacquired strategy candidates'),
      )
    return { value, contentHash: expectedHash }
  })
export type BacktestSourceReceipt = Result.Result.Success<ReturnType<typeof validateBacktestSourceReceipt>>

export const validateBacktestSourceCuts = (manifest: BacktestSourceManifest, capture: BacktestSourceReceipt) =>
  Result.gen(function* () {
    const expectedTransport =
      capture.value.schemaVersion === 'bayn.original-capture-replay-receipt.v1'
        ? 'original-capture'
        : capture.value.schemaVersion === 'bayn.replay-source-capture.v1'
          ? 'captured-kafka'
          : capture.value.schemaVersion === 'bayn.alpaca-rest-replay-receipt.v2'
            ? 'alpaca-rest'
            : 'archive-reconstruction'
    if (manifest.transport !== expectedTransport)
      return yield* Result.fail(fail('Source transport differs from its independently pinned receipt'))
    if (
      capture.value.schemaVersion === 'bayn.original-capture-replay-receipt.v1' &&
      ((yield* canonicalHashV1Result(manifest.deliveryModel)) !==
        (yield* canonicalHashV1Result(capture.value.deliveryModel)) ||
        (yield* canonicalHashV1Result(manifest.nativeVisiblePartitions)) !==
          (yield* canonicalHashV1Result(capture.value.nativeVisiblePartitions)) ||
        manifest.origin !== capture.value.origin ||
        manifest.recordCount !== capture.value.deliveryModel.finalConsumerSequence)
    )
      return yield* Result.fail(fail('Original source differs from its frozen capture interval provenance'))
    if (
      capture.value.schemaVersion !== 'bayn.replay-source-capture.v1' &&
      capture.value.sourceDataSha256 !== manifest.dataSha256
    )
      return yield* Result.fail(fail('Reconstructed replay bytes differ from the export receipt'))
    if (
      capture.value.schemaVersion === 'bayn.archive-reconstruction-receipt.v1' &&
      capture.value.origin !== manifest.origin
    )
      return yield* Result.fail(fail('Archive reconstruction origin differs from the receipt'))
    if (
      capture.value.schemaVersion === 'bayn.archive-reconstruction-receipt.v1' &&
      (yield* canonicalHashV1Result(manifest.archiveUnobservedPartitions ?? [])) !==
        (yield* canonicalHashV1Result(capture.value.archiveUnobservedPartitions ?? []))
    )
      return yield* Result.fail(fail('Unobserved archive partitions differ from the reconstruction receipt'))
    const cuts = (
      value: Pick<BacktestSourceManifest, 'coverageStartMs' | 'coverageEndMs' | 'universe' | 'positions'>,
    ) => ({
      coverageStartMs: value.coverageStartMs,
      coverageEndMs: value.coverageEndMs,
      universe: value.universe,
      positions: value.positions,
    })
    if ((yield* canonicalHashV1Result(cuts(manifest))) !== (yield* canonicalHashV1Result(cuts(capture.value))))
      return yield* Result.fail(fail('Source partition cuts differ from the independently pinned receipt'))
  })

/** The current Torghut capture profile matches the committed KafkaTopic topology, not observed records. */
export const backtestSourcePartitions = (manifest: BacktestSourceManifest) =>
  manifest.transport === 'original-capture'
    ? (manifest.nativeVisiblePartitions ?? [])
    : Object.values(manifest.universe.topics)
        .flatMap((topic) =>
          Array.from(
            {
              length:
                manifest.transport === 'alpaca-rest'
                  ? 1
                  : topic === manifest.universe.topics.quotes
                    ? 13
                    : (topic === manifest.universe.topics.features &&
                          manifest.regeneratedFeaturesRecordedAtMs !== undefined) ||
                        (topic === manifest.universe.topics.technicalFeatures &&
                          manifest.regeneratedTechnicalFeaturesRecordedAtMs !== undefined)
                      ? 1
                      : 3,
            },
            (_, partition) => ({ topic, partition }),
          ),
        )
        .sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition)

export const validateBacktestSourceManifest = (input: unknown) =>
  Result.gen(function* () {
    const manifest = yield* Schema.decodeUnknownResult(BacktestSourceManifestSchema, strictParseOptions)(input)
    const original = manifest.transport === 'original-capture'
    if (
      original !== (manifest.deliveryModel.schemaVersion === 'bayn.original-capture-arrivals.v1') ||
      original !== (manifest.nativeVisiblePartitions !== undefined) ||
      (original &&
        (manifest.regeneratedFeaturesRecordedAtMs !== undefined ||
          manifest.regeneratedTechnicalFeaturesRecordedAtMs !== undefined))
    )
      return yield* Result.fail(fail('Original capture provenance cannot mix with legacy or regenerated delivery'))
    const topics = Object.values(manifest.universe.topics)
    if (new Set(topics).size !== topics.length)
      return yield* Result.fail(fail('Raw and derived source topics must be distinct'))
    if (
      manifest.regeneratedTechnicalFeaturesRecordedAtMs !== undefined &&
      manifest.universe.topics.technicalFeatures === undefined
    )
      return yield* Result.fail(fail('Technical regeneration requires its bound source topic'))
    const expected = backtestSourcePartitions(manifest)
    if (
      original &&
      (expected.length === 0 ||
        new Set(expected.map(({ topic, partition }) => partitionKey(topic, partition))).size !== expected.length ||
        topics.some((topic) => !expected.some((position) => position.topic === topic)) ||
        expected.some((position) => !topics.includes(position.topic)))
    )
      return yield* Result.fail(
        fail('Original source inventory must account for every configured topic without duplicates'),
      )
    const unobserved = manifest.archiveUnobservedPartitions ?? []
    if (
      manifest.transport === 'archive-reconstruction' &&
      manifest.positions.some((position) => position.startOffset === position.endOffsetExclusive)
    )
      return yield* Result.fail(
        fail('No-record archive partitions must be declared unobserved, not assigned empty log offsets'),
      )
    if (manifest.transport !== 'archive-reconstruction' && manifest.archiveUnobservedPartitions !== undefined)
      return yield* Result.fail(fail('Only archive reconstruction can declare unobserved partitions'))
    const suppliedTopology = [...manifest.positions, ...unobserved].sort(
      (a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition,
    )
    if (
      suppliedTopology.length !== expected.length ||
      expected.some((partition, index) => {
        const supplied = suppliedTopology[index]
        return supplied?.topic !== partition.topic || supplied.partition !== partition.partition
      })
    )
      return yield* Result.fail(fail('Source cuts must include every partition in the declared source topology'))
    if (
      unobserved.some((partition, index) => {
        const previous = unobserved[index - 1]
        return (
          previous !== undefined &&
          (previous.topic > partition.topic ||
            (previous.topic === partition.topic && previous.partition >= partition.partition))
        )
      })
    )
      return yield* Result.fail(fail('Unobserved archive partition declarations must be unique and ordered'))
    if (
      manifest.positions.some((position, index) => {
        const previous = manifest.positions[index - 1]
        return (
          BigInt(position.startOffset) > BigInt(position.endOffsetExclusive) ||
          (previous !== undefined &&
            (previous.topic > position.topic ||
              (previous.topic === position.topic && previous.partition >= position.partition)))
        )
      })
    )
      return yield* Result.fail(
        fail('Source partition cuts must be ordered by topic then partition with nonnegative spans'),
      )
    return manifest
  })

/** Validate the complete file before execution; replay it with one chunk and the bounded live projection retained. */
export const openBacktestSource = (path: string, input: unknown, runId: string, capture: BacktestSourceReceipt) =>
  Effect.gen(function* () {
    const manifest = yield* Effect.fromResult(validateBacktestSourceManifest(input))
    yield* Effect.fromResult(validateBacktestSourceCuts(manifest, capture))
    const sourceManifestHash = yield* Effect.fromResult(canonicalHashV1Result(manifest))
    if (
      manifest.firstAvailableAtMs > manifest.lastAvailableAtMs ||
      manifest.coverageStartMs > manifest.firstAvailableAtMs ||
      manifest.coverageEndMs < manifest.lastAvailableAtMs
    )
      return yield* fail('Source availability bounds are reversed')
    const bounds = new Map(
      manifest.positions.map((position) => [partitionKey(position.topic, position.partition), position]),
    )
    const fs = yield* FileSystem.FileSystem
    // Keep a private, unlinked snapshot open through preflight and execution. Replacing or
    // changing the caller's path cannot substitute bytes after validation.
    const snapshotPath = yield* fs.makeTempFileScoped({ prefix: 'bayn-replay-source-' })
    const snapshot = yield* fs.open(snapshotPath, { flag: 'r+' })
    yield* fs.remove(snapshotPath)
    yield* Stream.runForEach(fs.stream(path), (chunk) => snapshot.writeAll(chunk))
    yield* snapshot.seek(0n, 'start')
    const source = {
      runId,
      sourceManifestHash,
      deliveryModel: manifest.deliveryModel,
      featureTopic: manifest.universe.topics.features,
      ...(manifest.universe.topics.technicalFeatures === undefined
        ? {}
        : { technicalFeatureTopic: manifest.universe.topics.technicalFeatures }),
      ...(manifest.regeneratedFeaturesRecordedAtMs === undefined
        ? {}
        : { regeneratedFeaturesRecordedAtMs: manifest.regeneratedFeaturesRecordedAtMs }),
      ...(manifest.regeneratedTechnicalFeaturesRecordedAtMs === undefined
        ? {}
        : { regeneratedTechnicalFeaturesRecordedAtMs: manifest.regeneratedTechnicalFeaturesRecordedAtMs }),
    }
    let cursor: HistoricalMarketCursor = yield* Effect.fromResult(
      createHistoricalMarketCursor(runId, manifest.universe, manifest.regeneratedFeaturesRecordedAtMs, source),
    )
    const read = () => {
      const original = manifest.deliveryModel.schemaVersion === 'bayn.original-capture-arrivals.v1'
      let validationCursor = cursor
      const digest = createHash('sha256')
      let count = 0
      let firstMs: number | undefined
      let last: HistoricalMarketArrival | undefined
      const offsets = new Map<string, string>()
      const stream = Stream.fromPull(
        Effect.succeed(
          snapshot
            .readAlloc(64 * 1024)
            .pipe(
              Effect.flatMap(Option.match({ onNone: () => Cause.done(), onSome: (chunk) => Effect.succeed([chunk]) })),
            ),
        ),
      ).pipe(
        Stream.tap((chunk) =>
          Effect.sync(() => {
            digest.update(chunk)
          }),
        ),
        NodeStream.pipeThroughDuplex({
          evaluate: () => createGunzip(),
          onError: (cause) => fail('Invalid compressed backtest source', cause),
        }),
        Stream.decodeText({ encoding: 'utf-8' }),
        Stream.splitLines,
        Stream.mapEffect((line) =>
          Effect.gen(function* () {
            const json = yield* Effect.try({
              try: (): unknown => JSON.parse(line),
              catch: (cause) => fail('Invalid arrival JSON', cause),
            })
            const event = yield* Schema.decodeUnknownEffect(HistoricalMarketArrivalSchema, strictParseOptions)(json)
            if ('receipt' in event && (!original || event.schemaVersion !== 'bayn.original-market-arrival.v2'))
              return yield* fail('Original receipt export requires a separately qualified capture manifest')
            if (original) {
              if (!('schemaVersion' in event) || event.schemaVersion !== 'bayn.original-market-arrival.v2')
                return yield* fail('Original capture cannot contain legacy arrival records')
              validationCursor = yield* Effect.fromResult(advanceHistoricalMarketCursor(validationCursor, event))
            }
            const key = partitionKey(event.record.topic, event.record.partition)
            const bound = bounds.get(key)
            const offset = BigInt(event.record.offset)
            const previous = offsets.get(key)
            if (bound === undefined || offset < BigInt(bound.startOffset) || offset >= BigInt(bound.endOffsetExclusive))
              return yield* fail('Arrival is outside frozen source partition bounds')
            if (!original && previous === undefined && offset !== BigInt(bound.startOffset))
              return yield* fail('Source omits the first data record of a declared partition cut')
            // Archive envelopes retain original coordinates, not every record in the underlying Kafka log.
            // The separately hashed reconstruction receipt explicitly limits completeness to retained rows.
            if (
              manifest.transport !== 'archive-reconstruction' &&
              !original &&
              previous !== undefined &&
              offset !== BigInt(previous) + 1n
            )
              return yield* fail('Source partition cuts must contain every consecutive source offset')
            if (
              (last !== undefined && compareArrivalPositions(arrivalPosition(last), arrivalPosition(event)) > 0) ||
              (previous !== undefined && (original ? offset < BigInt(previous) : offset <= BigInt(previous)))
            )
              return yield* fail('Source arrivals reverse time or repeat/reverse a source coordinate')
            count++
            firstMs ??= event.availableAtMs
            last = event
            offsets.set(key, event.record.offset)
            return event
          }),
        ),
      )
      const verify = Effect.suspend(() =>
        count !== manifest.recordCount ||
        firstMs !== manifest.firstAvailableAtMs ||
        last?.availableAtMs !== manifest.lastAvailableAtMs ||
        (!original &&
          manifest.positions.some((bound) =>
            bound.startOffset === bound.endOffsetExclusive
              ? offsets.has(partitionKey(bound.topic, bound.partition))
              : offsets.get(partitionKey(bound.topic, bound.partition)) !==
                String(BigInt(bound.endOffsetExclusive) - 1n),
          )) ||
        digest.digest('hex') !== manifest.dataSha256
          ? Effect.fail(fail('Source bytes, record count, or availability bounds differ from the frozen manifest'))
          : Effect.void,
      )
      return { stream, verify }
    }
    const preflight = read()
    yield* Stream.runDrain(preflight.stream)
    yield* preflight.verify
    yield* snapshot.seek(0n, 'start')
    const replay = read()
    const pull = yield* Stream.toPull(replay.stream)
    let pending: readonly HistoricalMarketArrival[] = []
    let pendingIndex = 0
    let ended = false
    let advancedToMs = 0
    const permit = yield* Semaphore.make(1)
    const peek = Effect.gen(function* () {
      if (pendingIndex === pending.length && !ended) {
        const chunk = yield* pull.pipe(Pull.catchDone(() => Effect.void))
        if (chunk === undefined) {
          ended = true
          yield* replay.verify
          pending = []
        } else pending = chunk
        pendingIndex = 0
      }
      return pending[pendingIndex]
    })
    const advanceTo = (atMs: number) =>
      permit.withPermit(
        Effect.gen(function* () {
          if (!Number.isSafeInteger(atMs) || atMs < advancedToMs)
            return yield* fail('Source clock cannot move backwards')
          while (true) {
            const next = yield* peek
            if (next === undefined || next.availableAtMs > atMs) break
            cursor = yield* Effect.fromResult(advanceHistoricalMarketCursor(cursor, next))
            pendingIndex++
          }
          advancedToMs = atMs
        }),
      )
    return {
      manifest,
      source,
      cursor: Effect.sync(() => cursor),
      advanceTo,
      finish: Effect.suspend(() => advanceTo(Math.max(manifest.lastAvailableAtMs, advancedToMs))).pipe(
        Effect.andThen(
          Effect.suspend(() => (ended ? Effect.void : Effect.fail(fail('Source was not fully consumed')))),
        ),
      ),
    }
  }).pipe(Effect.mapError((cause) => fail('Cannot open or advance retained replay source', cause)))
