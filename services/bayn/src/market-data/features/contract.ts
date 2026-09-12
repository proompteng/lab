import { Data, Result, Schema } from 'effect'

import { canonicalHashV1Result, sha256 } from '../../hash'
import type { IntradayBar } from '../intraday/model'
import { intradayInstantNanos } from '../intraday/time'
import { strictParseOptions } from '../../schemas'

export enum MarketFeatureContract {
  V1 = 'dorvud.market-feature.v1',
}
export enum MarketFeatureDefinition {
  RollingPrice30m = 'dorvud.rolling-price-30m.v1',
}
export enum MarketFeatureSessionPolicy {
  RegularNewYork = 'alpaca.regular.new-york-date.v1',
}

export const marketFeatureClockSkewAllowanceMs = 5000

export const rollingFeatureDefinitionMaterial = [
  MarketFeatureDefinition.RollingPrice30m,
  MarketFeatureSessionPolicy.RegularNewYork,
  '30xPT1M-complete',
  'binary64-times-1000000-round-half-positive-infinity',
  'bar-winner:ingestion-nanos,partition,offset',
  'raw-content:binary64-hex-v1',
  `cross-host-clock-skew-ms:${marketFeatureClockSkewAllowanceMs}`,
]

const IntegerString = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/))
const PositiveIntegerString = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/))
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const SafeInteger = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const Timestamp = SafeInteger.check(Schema.isLessThanOrEqualTo(253402300799999))
const Identity = Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/))

export const MarketFeatureInputSchema = Schema.Struct({
  eventTimeNanos: IntegerString,
  ingestionTimeNanos: IntegerString,
  sourceTopic: Identity,
  sourcePartition: SafeInteger,
  sourceOffset: IntegerString,
  contentHash: Hash,
})
export const RollingMarketValuesSchema = Schema.Struct({
  referencePriceMicros: PositiveIntegerString,
  rangeHighPriceMicros: PositiveIntegerString,
  rangeLowPriceMicros: PositiveIntegerString,
  lastClosePriceMicros: PositiveIntegerString,
  totalVolumeMicros: IntegerString,
})
export const RollingMarketFeatureMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Enum(MarketFeatureContract),
  definitionId: Schema.Enum(MarketFeatureDefinition),
  definitionHash: Hash,
  provider: Schema.Literal('alpaca'),
  feed: Schema.Literal('iex'),
  delayClass: Schema.Literal('real_time_exchange_only'),
  universeId: Identity,
  universeSymbolHash: Hash,
  symbol: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.]{0,9}$/)),
  sessionDate: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  sessionPolicy: Schema.Enum(MarketFeatureSessionPolicy),
  windowStartMs: Timestamp,
  windowEndMs: Timestamp,
  inputs: Schema.Array(MarketFeatureInputSchema).check(Schema.isLengthBetween(30, 30)),
  values: RollingMarketValuesSchema,
})
export const RollingMarketFeatureSchema = Schema.Struct({
  material: RollingMarketFeatureMaterialSchema,
  featureId: Hash,
  computedAtMs: Timestamp,
  producerRevision: Schema.String.check(Schema.isMinLength(1)),
})
export type RollingMarketFeature = typeof RollingMarketFeatureSchema.Type
export type MarketFeatureInput = typeof MarketFeatureInputSchema.Type
export type RollingMarketValues = typeof RollingMarketValuesSchema.Type

export class MarketFeatureFailure extends Data.TaggedError('MarketFeatureFailure')<{
  readonly reason: 'schema' | 'identity' | 'window' | 'hash' | 'input'
  readonly message: string
  readonly cause?: unknown
}> {}

const failure = (reason: MarketFeatureFailure['reason'], message: string, cause?: unknown) =>
  new MarketFeatureFailure({ reason, message, ...(cause === undefined ? {} : { cause }) })

export const marketFeatureHash = (value: unknown) =>
  canonicalHashV1Result(value).pipe(
    Result.mapError((cause) => failure('hash', 'feature content is not canonical', cause)),
  )

const newYorkDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const canonicalMaterialKeys = [
  ...new Set([
    ...Object.keys(RollingMarketFeatureMaterialSchema.fields),
    ...Object.keys(MarketFeatureInputSchema.fields),
    ...Object.keys(RollingMarketValuesSchema.fields),
  ]),
].sort()

// Strict decoding below produces plain JSON with ASCII strings and finite integers.
// Native serialization with sorted schema keys preserves canonical v1 without revalidating every property.
const hashDecodedMaterial = (material: RollingMarketFeature['material']) =>
  Result.try({
    try: () => sha256(JSON.stringify(material, canonicalMaterialKeys)),
    catch: (cause) => failure('hash', 'decoded feature content could not be hashed', cause),
  })

const expectedDefinitionHash = marketFeatureHash(rollingFeatureDefinitionMaterial)

export const decodeRollingMarketFeature = (value: unknown): Result.Result<RollingMarketFeature, MarketFeatureFailure> =>
  Result.gen(function* () {
    const feature = yield* Schema.decodeUnknownResult(RollingMarketFeatureSchema)(value, strictParseOptions).pipe(
      Result.mapError((cause) => failure('schema', 'invalid rolling feature message', cause)),
    )
    const { material } = feature
    const expectedDefinition = yield* expectedDefinitionHash
    if (material.definitionHash !== expectedDefinition)
      return yield* Result.fail(failure('identity', 'unknown rolling feature definition'))
    if (feature.featureId !== (yield* hashDecodedMaterial(material)))
      return yield* Result.fail(failure('hash', 'feature identity does not match its content'))
    if (
      material.windowStartMs % 60_000 !== 0 ||
      material.windowEndMs - material.windowStartMs !== 30 * 60_000 ||
      feature.computedAtMs + marketFeatureClockSkewAllowanceMs < material.windowEndMs ||
      newYorkDate.format(material.windowStartMs) !== material.sessionDate ||
      newYorkDate.format(material.windowEndMs - 1) !== material.sessionDate
    )
      return yield* Result.fail(failure('window', 'feature does not describe a complete same-session window'))
    const coordinates = new Set<string>()
    const topics = new Set<string>()
    for (const [index, input] of material.inputs.entries()) {
      if (BigInt(input.sourceOffset) > 9_223_372_036_854_775_807n || input.sourcePartition > 2_147_483_647)
        return yield* Result.fail(failure('input', 'feature input coordinates exceed the Kafka integer domain'))
      if (
        BigInt(input.eventTimeNanos) !== BigInt(material.windowStartMs + index * 60_000) * 1_000_000n ||
        BigInt(input.ingestionTimeNanos) + BigInt(marketFeatureClockSkewAllowanceMs) * 1_000_000n <
          BigInt(input.eventTimeNanos) + 60_000_000_000n ||
        BigInt(input.ingestionTimeNanos) >
          BigInt(feature.computedAtMs + marketFeatureClockSkewAllowanceMs) * 1_000_000n + 999_999n
      ) {
        return yield* Result.fail(
          failure('input', 'feature input is non-contiguous, premature, or unavailable at computation'),
        )
      }
      const coordinate = `${input.sourceTopic}:${input.sourcePartition}:${input.sourceOffset}`
      if (coordinates.has(coordinate))
        return yield* Result.fail(failure('input', 'feature repeats a source coordinate'))
      coordinates.add(coordinate)
      topics.add(input.sourceTopic)
    }
    if (topics.size !== 1) return yield* Result.fail(failure('input', 'feature inputs mix source topics'))
    const values = material.values
    const prices = [
      values.referencePriceMicros,
      values.rangeHighPriceMicros,
      values.rangeLowPriceMicros,
      values.lastClosePriceMicros,
    ].map(BigInt)
    if (
      prices.some((price) => price > BigInt(Number.MAX_SAFE_INTEGER)) ||
      BigInt(values.rangeHighPriceMicros) < BigInt(values.rangeLowPriceMicros) ||
      [values.referencePriceMicros, values.lastClosePriceMicros].some(
        (price) =>
          BigInt(price) < BigInt(values.rangeLowPriceMicros) || BigInt(price) > BigInt(values.rangeHighPriceMicros),
      )
    ) {
      return yield* Result.fail(failure('input', 'feature prices violate their numeric domain'))
    }
    return feature
  })

const doubleBits = (value: number): string => {
  const bytes = new DataView(new ArrayBuffer(8))
  bytes.setFloat64(0, value)
  return bytes.getBigUint64(0).toString(16).padStart(16, '0')
}

export const featureBarContentHash = (bar: IntradayBar): Result.Result<string, MarketFeatureFailure> =>
  marketFeatureHash([
    bar.provider,
    bar.universeId,
    bar.universeSymbolHash,
    bar.feed,
    bar.marketSession,
    bar.delayClass,
    bar.symbol,
    String(intradayInstantNanos(bar.eventAt)),
    String(intradayInstantNanos(bar.ingestedAt)),
    bar.channel,
    String(bar.final),
    String(bar.schemaVersion),
    doubleBits(bar.open),
    doubleBits(bar.high),
    doubleBits(bar.low),
    doubleBits(bar.close),
    doubleBits(bar.volume),
    bar.vwap === null ? 'null' : doubleBits(bar.vwap),
    bar.tradeCount ?? 'null',
  ])

export const featureMatchesBars = (
  feature: RollingMarketFeature,
  bars: readonly IntradayBar[],
): Result.Result<boolean, MarketFeatureFailure> =>
  Result.gen(function* () {
    const { material } = feature
    const ordered = bars.toSorted((a, b) => (a.eventAt < b.eventAt ? -1 : a.eventAt > b.eventAt ? 1 : 0))
    if (ordered.length !== material.inputs.length) return false
    for (const [index, bar] of ordered.entries()) {
      const input = material.inputs[index]
      if (
        input === undefined ||
        bar.provider !== material.provider ||
        bar.feed !== material.feed ||
        bar.delayClass !== material.delayClass ||
        bar.universeId !== material.universeId ||
        bar.universeSymbolHash !== material.universeSymbolHash ||
        bar.symbol !== material.symbol ||
        bar.marketSession !== 'regular' ||
        !bar.final ||
        input.eventTimeNanos !== String(intradayInstantNanos(bar.eventAt)) ||
        input.ingestionTimeNanos !== String(intradayInstantNanos(bar.ingestedAt)) ||
        input.sourceTopic !== bar.sourceTopic ||
        input.sourcePartition !== bar.sourcePartition ||
        input.sourceOffset !== bar.sourceOffset ||
        input.contentHash !== (yield* featureBarContentHash(bar))
      )
        return false
    }
    return true
  })
