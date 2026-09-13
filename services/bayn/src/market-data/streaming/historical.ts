import { SimulatedSnapshotSourceSchema } from './evidence-schema'
import { Data, Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../../hash'
import {
  NonNegativeIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  strictParseOptions,
} from '../../schemas'
import { emptyStreamingProjection, incorporateSimulatedMarketRecord, topicPartitionKey } from './projection'
import type { StreamingUniverse } from './raw-events'

export const HistoricalMarketArrivalSchema = Schema.Struct({
  availableAtMs: NonNegativeIntegerSchema,
  record: Schema.Struct({
    topic: StrictNonEmptyStringSchema,
    partition: NonNegativeIntegerSchema,
    offset: UnsignedMicrosSchema,
    value: Schema.String,
    timestampMs: Schema.optionalKey(NonNegativeIntegerSchema),
  }),
})
export type HistoricalMarketArrival = typeof HistoricalMarketArrivalSchema.Type

/** Explicit counterfactual delivery; computedAt and the published payload are never rewritten. */
export const HistoricalStreamingInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.historical-market-arrivals.v1'),
  runId: Sha256Schema,
  deliveryModel: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.supplied-arrival-times.v1'),
    description: StrictNonEmptyStringSchema,
    tieBreak: Schema.Literal('availability-topic-partition-offset'),
  }),
  regeneratedFeatures: Schema.optionalKey(
    Schema.Struct({
      runId: Sha256Schema,
      recordedAtMs: NonNegativeIntegerSchema,
    }),
  ),
  observedAtMs: NonNegativeIntegerSchema,
  events: Schema.Array(HistoricalMarketArrivalSchema).check(Schema.isMaxLength(500_000)),
})

export class HistoricalMarketArrivalFailure extends Data.TaggedError('HistoricalMarketArrivalFailure')<{
  readonly message: string
  readonly topic: string
  readonly partition: number
  readonly offset: string
}> {}

export const replayHistoricalMarketArrivals = (input: unknown, universe: StreamingUniverse) =>
  Result.gen(function* () {
    const decoded = yield* Schema.decodeUnknownResult(HistoricalStreamingInputSchema, strictParseOptions)(input)
    const inputHash = yield* canonicalHashV1Result({ input: decoded, universe })
    const events = [...decoded.events].sort((a, b) => compareArrivalPositions(arrivalPosition(a), arrivalPosition(b)))
    const cursor = yield* createHistoricalMarketCursor(
      decoded.runId,
      universe,
      decoded.regeneratedFeatures?.recordedAtMs,
    )
    // Validate the entire supplied ordering, including records after this observation.
    const offsets = new Map<string, bigint>()
    for (const event of events) {
      const { record } = event
      const key = topicPartitionKey(record.topic, record.partition)
      const offset = BigInt(record.offset)
      const previous = offsets.get(key)
      if (previous !== undefined && offset < previous)
        return yield* Result.fail(
          new HistoricalMarketArrivalFailure({
            message: 'Simulated availability reverses Kafka partition offsets',
            topic: record.topic,
            partition: record.partition,
            offset: record.offset,
          }),
        )
      offsets.set(key, offset)
    }
    let current: HistoricalMarketCursor = cursor
    for (const event of events) {
      if (event.availableAtMs > decoded.observedAtMs) break
      current = yield* advanceHistoricalMarketCursor(current, event)
    }
    const projection = current.projection
    return {
      schemaVersion: 'bayn.historical-market-replay.v1' as const,
      evidenceMode: 'simulated-consumer-availability' as const,
      runId: decoded.runId,
      inputHash,
      deliveryModel: decoded.deliveryModel,
      regeneratedFeatures: decoded.regeneratedFeatures,
      observedAtMs: decoded.observedAtMs,
      projection,
    }
  })

type HistoricalArrivalPosition = Pick<HistoricalMarketArrival, 'availableAtMs'> &
  Pick<HistoricalMarketArrival['record'], 'topic' | 'partition' | 'offset'>

export const arrivalPosition = (event: HistoricalMarketArrival): HistoricalArrivalPosition => ({
  availableAtMs: event.availableAtMs,
  topic: event.record.topic,
  partition: event.record.partition,
  offset: event.record.offset,
})
export const compareArrivalPositions = (a: HistoricalArrivalPosition, b: HistoricalArrivalPosition): number => {
  if (a.availableAtMs !== b.availableAtMs) return a.availableAtMs - b.availableAtMs
  if (a.topic !== b.topic) return a.topic < b.topic ? -1 : 1
  if (a.partition !== b.partition) return a.partition - b.partition
  return BigInt(a.offset) < BigInt(b.offset) ? -1 : BigInt(a.offset) > BigInt(b.offset) ? 1 : 0
}

/** Incremental state accepts already ordered arrivals without retaining the source file. */
export interface HistoricalMarketCursor {
  readonly source?: typeof SimulatedSnapshotSourceSchema.Type
  readonly runId: string
  readonly universe: StreamingUniverse
  readonly regeneratedFeaturesRecordedAtMs?: number
  readonly projection: ReturnType<typeof emptyStreamingProjection>
  readonly processedRecords: number
  readonly suppliedOffsets: ReadonlyMap<string, string>
  readonly lastArrival: HistoricalArrivalPosition | null
}

export const createHistoricalMarketCursor = (
  runId: string,
  universe: StreamingUniverse,
  regeneratedFeaturesRecordedAtMs?: number,
  source?: typeof SimulatedSnapshotSourceSchema.Type,
) =>
  Result.gen(function* () {
    yield* Schema.decodeUnknownResult(Sha256Schema, strictParseOptions)(runId)
    if (regeneratedFeaturesRecordedAtMs !== undefined)
      yield* Schema.decodeUnknownResult(NonNegativeIntegerSchema, strictParseOptions)(regeneratedFeaturesRecordedAtMs)
    const provenance =
      source === undefined
        ? undefined
        : yield* Schema.decodeUnknownResult(
            SimulatedSnapshotSourceSchema.check(
              Schema.makeFilter(
                (value) =>
                  value.runId === runId &&
                  value.featureTopic === universe.topics.features &&
                  value.technicalFeatureTopic === universe.topics.technicalFeatures &&
                  value.regeneratedFeaturesRecordedAtMs === regeneratedFeaturesRecordedAtMs,
              ),
            ),
            strictParseOptions,
          )(source)
    return {
      ...(provenance === undefined ? {} : { source: provenance }),
      runId,
      universe,
      ...(regeneratedFeaturesRecordedAtMs === undefined ? {} : { regeneratedFeaturesRecordedAtMs }),
      projection: {
        ...emptyStreamingProjection(`historical-${runId}`, universe.topics.technicalFeatures),
        availabilityMode: 'simulated',
      },
      processedRecords: 0,
      suppliedOffsets: new Map<string, string>(),
      lastArrival: null,
    } satisfies HistoricalMarketCursor
  })

export const advanceHistoricalMarketCursor = (cursor: HistoricalMarketCursor, input: unknown) =>
  Result.gen(function* () {
    const event = yield* Schema.decodeUnknownResult(HistoricalMarketArrivalSchema, strictParseOptions)(input)
    const { record } = event
    const last = cursor.lastArrival
    const partitionKey = topicPartitionKey(record.topic, record.partition)
    const offset = cursor.suppliedOffsets.get(partitionKey)
    const order = last === null ? 1 : compareArrivalPositions(arrivalPosition(event), last)
    if (order < 0 || (offset !== undefined && BigInt(record.offset) < BigInt(offset)))
      return yield* Result.fail(
        new HistoricalMarketArrivalFailure({
          message: 'Historical arrivals must preserve availability order and Kafka partition offsets',
          topic: record.topic,
          partition: record.partition,
          offset: record.offset,
        }),
      )
    return {
      ...cursor,
      projection: incorporateSimulatedMarketRecord(
        cursor.projection,
        record,
        cursor.universe,
        event.availableAtMs,
        cursor.regeneratedFeaturesRecordedAtMs ?? event.availableAtMs,
      ),
      processedRecords: cursor.processedRecords + 1,
      suppliedOffsets: new Map(cursor.suppliedOffsets).set(partitionKey, record.offset),
      lastArrival: {
        availableAtMs: event.availableAtMs,
        topic: record.topic,
        partition: record.partition,
        offset: record.offset,
      },
    } satisfies HistoricalMarketCursor
  })
