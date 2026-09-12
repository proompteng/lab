import { Result, Schema } from 'effect'
import { canonicalHashV1Result } from '../../hash'
import {
  NonNegativeIntegerSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  UnsignedMicrosSchema,
  strictParseOptions,
} from '../../schemas'
import { emptyStreamingProjection, incorporateMarketRecord } from './projection'
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
    let projection = emptyStreamingProjection(`historical-${decoded.runId}`)
    for (const event of events) {
      if (event.availableAtMs > decoded.observedAtMs) break
      projection = incorporateMarketRecord(projection, event.record, universe, event.availableAtMs)
    }
    return {
      schemaVersion: 'bayn.historical-market-replay.v1' as const,
      evidenceMode: 'simulated-consumer-availability' as const,
      runId: decoded.runId,
      inputHash,
      deliveryModel: decoded.deliveryModel,
      observedAtMs: decoded.observedAtMs,
      projection,
    }
  })
