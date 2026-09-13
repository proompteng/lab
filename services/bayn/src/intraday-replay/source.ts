import { createHash } from 'node:crypto'
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
import { SimulatedSnapshotSourceSchema } from '../market-data/streaming/evidence-schema'
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
export const RetainedReplaySourceManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.retained-replay-source.v1'),
  dataSha256: Sha256Schema,
  recordCount: PositiveIntegerSchema,
  coverageStartMs: NonNegativeIntegerSchema,
  coverageEndMs: NonNegativeIntegerSchema,
  firstAvailableAtMs: NonNegativeIntegerSchema,
  lastAvailableAtMs: NonNegativeIntegerSchema,
  origin: StrictNonEmptyStringSchema,
  positions: Schema.Array(SourcePositionSchema).check(Schema.isMinLength(1)),
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
})
export type RetainedReplaySourceManifest = typeof RetainedReplaySourceManifestSchema.Type
export class ReplaySourceFailure extends Data.TaggedError('ReplaySourceFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}
const fail = (message: string, cause?: unknown) => new ReplaySourceFailure({ message, cause })
const partitionKey = (topic: string, partition: number) => `${topic}:${partition}`

export const RetainedReplayCaptureSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.replay-source-capture.v1'),
  capturedAt: UtcInstantSchema,
  origin: StrictNonEmptyStringSchema,
  coverageStartMs: NonNegativeIntegerSchema,
  coverageEndMs: NonNegativeIntegerSchema,
  universe: RetainedReplaySourceManifestSchema.fields.universe,
  positions: RetainedReplaySourceManifestSchema.fields.positions,
})

/** The expected hash is supplied by the capture authority, independently of the editable session manifest. */
export const validateRetainedReplayCapture = (text: string, expectedHash: string) =>
  Result.gen(function* () {
    yield* Schema.decodeUnknownResult(Sha256Schema)(expectedHash)
    if (sha256(text) !== expectedHash)
      return yield* Result.fail(fail('Source capture bytes differ from the independently pinned capture hash'))
    const value = yield* Schema.decodeUnknownResult(
      Schema.fromJsonString(RetainedReplayCaptureSchema),
      strictParseOptions,
    )(text)
    if (value.coverageStartMs > value.coverageEndMs || Date.parse(value.capturedAt) < value.coverageEndMs)
      return yield* Result.fail(fail('Source capture must observe the complete export interval'))
    return { value, contentHash: expectedHash }
  })
export type RetainedReplayCapture = Result.Result.Success<ReturnType<typeof validateRetainedReplayCapture>>

export const validateCapturedReplayCuts = (manifest: RetainedReplaySourceManifest, capture: RetainedReplayCapture) =>
  Result.gen(function* () {
    const cuts = (
      value: Pick<RetainedReplaySourceManifest, 'coverageStartMs' | 'coverageEndMs' | 'universe' | 'positions'>,
    ) => ({
      coverageStartMs: value.coverageStartMs,
      coverageEndMs: value.coverageEndMs,
      universe: value.universe,
      positions: value.positions,
    })
    if ((yield* canonicalHashV1Result(cuts(manifest))) !== (yield* canonicalHashV1Result(cuts(capture.value))))
      return yield* Result.fail(fail('Source partition cuts differ from the independently captured session offsets'))
  })

/** The current Torghut capture profile matches the committed KafkaTopic topology, not observed records. */
export const retainedReplaySourcePartitions = (manifest: RetainedReplaySourceManifest) =>
  Object.values(manifest.universe.topics)
    .flatMap((topic) =>
      Array.from(
        {
          length:
            topic === manifest.universe.topics.quotes
              ? 13
              : topic === manifest.universe.topics.features && manifest.regeneratedFeaturesRecordedAtMs !== undefined
                ? 1
                : 3,
        },
        (_, partition) => ({ topic, partition }),
      ),
    )
    .sort((a, b) => a.topic.localeCompare(b.topic) || a.partition - b.partition)

export const validateRetainedReplaySourceManifest = (input: unknown) =>
  Result.gen(function* () {
    const manifest = yield* Schema.decodeUnknownResult(RetainedReplaySourceManifestSchema, strictParseOptions)(input)
    const topics = Object.values(manifest.universe.topics)
    if (new Set(topics).size !== topics.length)
      return yield* Result.fail(fail('Raw and derived source topics must be distinct'))
    const expected = retainedReplaySourcePartitions(manifest)
    if (
      manifest.positions.length !== expected.length ||
      expected.some((partition, index) => {
        const supplied = manifest.positions[index]
        return supplied?.topic !== partition.topic || supplied.partition !== partition.partition
      })
    )
      return yield* Result.fail(fail('Source cuts must include every partition in the Torghut capture topology'))
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
export const openRetainedReplaySource = (path: string, input: unknown, runId: string, capture: RetainedReplayCapture) =>
  Effect.gen(function* () {
    const manifest = yield* Effect.fromResult(validateRetainedReplaySourceManifest(input))
    yield* Effect.fromResult(validateCapturedReplayCuts(manifest, capture))
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
    yield* snapshot.seek(0, 'start')
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
    }
    let cursor: HistoricalMarketCursor = yield* Effect.fromResult(
      createHistoricalMarketCursor(runId, manifest.universe, manifest.regeneratedFeaturesRecordedAtMs, source),
    )
    const read = () => {
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
        Stream.decodeText({ encoding: 'utf-8' }),
        Stream.splitLines,
        Stream.mapEffect((line) =>
          Effect.gen(function* () {
            const json = yield* Effect.try({
              try: (): unknown => JSON.parse(line),
              catch: (cause) => fail('Invalid arrival JSON', cause),
            })
            const event = yield* Schema.decodeUnknownEffect(HistoricalMarketArrivalSchema, strictParseOptions)(json)
            const key = partitionKey(event.record.topic, event.record.partition)
            const bound = bounds.get(key)
            const offset = BigInt(event.record.offset)
            const previous = offsets.get(key)
            if (bound === undefined || offset < BigInt(bound.startOffset) || offset >= BigInt(bound.endOffsetExclusive))
              return yield* fail('Arrival is outside frozen source partition bounds')
            if (previous === undefined && offset !== BigInt(bound.startOffset))
              return yield* fail('Source omits the first data record of a declared partition cut')
            if (previous !== undefined && offset !== BigInt(previous) + 1n)
              return yield* fail('Source partition cuts must contain every consecutive Kafka offset')
            if (
              (last !== undefined && compareArrivalPositions(arrivalPosition(last), arrivalPosition(event)) > 0) ||
              (previous !== undefined && offset <= BigInt(previous))
            )
              return yield* fail('Source arrivals reverse time or repeat/reverse a Kafka coordinate')
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
        manifest.positions.some((bound) =>
          bound.startOffset === bound.endOffsetExclusive
            ? offsets.has(partitionKey(bound.topic, bound.partition))
            : offsets.get(partitionKey(bound.topic, bound.partition)) !== String(BigInt(bound.endOffsetExclusive) - 1n),
        ) ||
        digest.digest('hex') !== manifest.dataSha256
          ? Effect.fail(fail('Source bytes, record count, or availability bounds differ from the frozen manifest'))
          : Effect.void,
      )
      return { stream, verify }
    }
    const preflight = read()
    yield* Stream.runDrain(preflight.stream)
    yield* preflight.verify
    yield* snapshot.seek(0, 'start')
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
