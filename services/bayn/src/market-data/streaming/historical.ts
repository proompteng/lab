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
  events: Schema.Array(
    Schema.Struct({
      availableAtMs: NonNegativeIntegerSchema,
      record: Schema.Struct({
        topic: StrictNonEmptyStringSchema,
        partition: NonNegativeIntegerSchema,
        offset: UnsignedMicrosSchema,
        value: Schema.String,
        timestampMs: Schema.optionalKey(NonNegativeIntegerSchema),
      }),
    }),
  ).check(Schema.isMaxLength(500_000)),
})

class HistoricalMarketArrivalFailure extends Data.TaggedError('HistoricalMarketArrivalFailure')<{
  readonly message: string
  readonly topic: string
  readonly partition: number
  readonly offset: string
}> {}

export const replayHistoricalMarketArrivals = (input: unknown, universe: StreamingUniverse) =>
  Result.gen(function* () {
    const decoded = yield* Schema.decodeUnknownResult(HistoricalStreamingInputSchema, strictParseOptions)(input)
    const inputHash = yield* canonicalHashV1Result({ input: decoded, universe })
    const events = [...decoded.events].sort(
      (a, b) =>
        a.availableAtMs - b.availableAtMs ||
        (a.record.topic < b.record.topic ? -1 : a.record.topic > b.record.topic ? 1 : 0) ||
        a.record.partition - b.record.partition ||
        (BigInt(a.record.offset) < BigInt(b.record.offset)
          ? -1
          : BigInt(a.record.offset) > BigInt(b.record.offset)
            ? 1
            : 0),
    )
    const offsets = new Map<string, bigint>()
    for (const { record } of events) {
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
    let projection: ReturnType<typeof emptyStreamingProjection> = {
      ...emptyStreamingProjection(`historical-${decoded.runId}`),
      availabilityMode: 'simulated',
    }
    for (const event of events) {
      if (event.availableAtMs > decoded.observedAtMs) break
      projection = incorporateSimulatedMarketRecord(
        projection,
        event.record,
        universe,
        event.availableAtMs,
        decoded.regeneratedFeatures?.recordedAtMs ?? event.availableAtMs,
      )
    }
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
