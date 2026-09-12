import { createHash } from 'node:crypto'
import { Data, Effect, FileSystem, Pull, Schema, Semaphore, Stream } from 'effect'
import { canonicalHashV1Result } from '../hash'
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

/** Validate the complete file before execution; replay it with one chunk and the bounded live projection retained. */
export const openRetainedReplaySource = (path: string, input: unknown, runId: string) =>
  Effect.gen(function* () {
    const manifest = yield* Schema.decodeUnknownEffect(RetainedReplaySourceManifestSchema, strictParseOptions)(input)
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
    if (
      bounds.size !== manifest.positions.length ||
      manifest.positions.some((p) => BigInt(p.startOffset) >= BigInt(p.endOffsetExclusive))
    )
      return yield* fail('Source partition bounds are duplicated or empty')
    const fs = yield* FileSystem.FileSystem
    const source = {
      runId,
      sourceManifestHash,
      deliveryModel: manifest.deliveryModel,
      featureTopic: manifest.universe.topics.features,
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
      const stream = fs.stream(path).pipe(
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
        digest.digest('hex') !== manifest.dataSha256
          ? Effect.fail(fail('Source bytes, record count, or availability bounds differ from the frozen manifest'))
          : Effect.void,
      )
      return { stream, verify }
    }
    const preflight = read()
    yield* Stream.runDrain(preflight.stream)
    yield* preflight.verify
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
