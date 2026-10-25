import { Result, Schema } from 'effect'
import type { RollingMarketFeature } from './contract'
import type { TechnicalMarketFeature } from './technical-contract'

import { canonicalHashV1Result } from '../../hash'
import { Sha256Schema, strictParseOptions } from '../../schemas'
import { MarketFeatureFailure, MarketFeatureInputSchema, marketFeatureClockSkewAllowanceMs } from './feature-core'
import { TechnicalFeatureValueSchema, TechnicalReadiness } from './feature-core'

export const cryptoFeatureTopic = 'bayn.market-data.crypto.features.v1'
export const cryptoRawTopic = 'bayn.market-data.crypto.v1'
export const cryptoUniverse = Object.freeze({
  id: 'alpaca.crypto.us.v1',
  symbols: ['BTC/USD', 'ETH/USD', 'SOL/USD'],
})

export const cryptoFeatureDefinitionMaterial = [
  'dorvud.crypto-continuous-1m.v2',
  'continuous;PT1M;no-calendar-reset;no-synthetic-bars',
  'canonical-correction-history:61-bars;older-corrections:reject',
  'EMA:12,26;alpha:2/(n+1);seed:first-observed-close;ready:12,26',
  'MACD:EMA12-EMA26;signal:9;seed:zero;ready:34',
  'RSI:14;gain-loss-alpha:1/14;seed:zero;ready:15;flat:0',
  'Bollinger:20;population-standard-deviation;2-sigma',
  'weighted-close-and-source-VWAP:5m,30m;zero-volume:unavailable',
  'volatility:60-log-returns;population-standard-deviation;not-annualized',
  'gap:reset-recursive-indicator-seed-and-warmup;price-window:observed-minutes',
  'rolling-OHLC-volume:PT30M-maximum-context;gaps-unfilled;exact-decimal-strings',
  'technical:binary64;price-micros;RSI-percentage-point-micros;volatility-ratio-ppm',
  'bar-winner:ingestion-nanos,partition,offset;raw-content:native-json-v1',
  `history:sha256-chain-of-canonical-source-inputs;cross-host-clock-skew-ms:${marketFeatureClockSkewAllowanceMs}`,
] as const

const Decimal = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/))
const Instant = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 253402300799999 }))
const RollingValues = Schema.Struct({
  referencePrice: Decimal,
  rangeHighPrice: Decimal,
  rangeLowPrice: Decimal,
  lastClosePrice: Decimal,
  totalVolume: Decimal,
})
const CryptoTechnicalValues = Schema.Struct({
  ema12PriceMicros: TechnicalFeatureValueSchema,
  ema26PriceMicros: TechnicalFeatureValueSchema,
  macdPriceMicros: TechnicalFeatureValueSchema,
  macdSignalPriceMicros: TechnicalFeatureValueSchema,
  macdHistogramPriceMicros: TechnicalFeatureValueSchema,
  rsi14Micros: TechnicalFeatureValueSchema,
  bollingerMiddlePriceMicros: TechnicalFeatureValueSchema,
  bollingerUpperPriceMicros: TechnicalFeatureValueSchema,
  bollingerLowerPriceMicros: TechnicalFeatureValueSchema,
  weightedClose5mPriceMicros: TechnicalFeatureValueSchema,
  weightedClose30mPriceMicros: TechnicalFeatureValueSchema,
  vwap5mPriceMicros: TechnicalFeatureValueSchema,
  vwap30mPriceMicros: TechnicalFeatureValueSchema,
  realizedVolatility60ReturnsPpm: TechnicalFeatureValueSchema,
})
export const CryptoMarketFeatureSchema = Schema.Struct({
  material: Schema.Struct({
    schemaVersion: Schema.Literal('dorvud.crypto-market-feature.v2'),
    definitionId: Schema.Literal('dorvud.crypto-continuous-1m.v2'),
    definitionHash: Sha256Schema,
    provider: Schema.Literal('alpaca'),
    location: Schema.Literal('us'),
    marketSession: Schema.Literal('continuous'),
    delayClass: Schema.Literal('real_time_crypto'),
    symbol: Schema.Literals(['BTC/USD', 'ETH/USD', 'SOL/USD']),
    windowStartMs: Instant,
    windowEndMs: Instant,
    historyPrefixHash: Sha256Schema,
    historyHash: Sha256Schema,
    inputs: Schema.Array(MarketFeatureInputSchema).check(Schema.isMinLength(1), Schema.isMaxLength(61)),
    priceWindow: RollingValues,
    technical: CryptoTechnicalValues,
  }),
  featureId: Sha256Schema,
  computedAtMs: Instant,
  producerRevision: Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
})
export type CryptoMarketFeature = typeof CryptoMarketFeatureSchema.Type
export const isCryptoMarketFeature = (
  feature: RollingMarketFeature | TechnicalMarketFeature | CryptoMarketFeature,
): feature is CryptoMarketFeature => feature.material.schemaVersion === 'dorvud.crypto-market-feature.v2'

const fail = (message: string) => Result.fail(new MarketFeatureFailure({ reason: 'input', message }))

export const decodeCryptoMarketFeature = (input: unknown): Result.Result<CryptoMarketFeature, MarketFeatureFailure> =>
  Result.gen(function* () {
    const feature = yield* Schema.decodeUnknownResult(
      CryptoMarketFeatureSchema,
      strictParseOptions,
    )(input).pipe(
      Result.mapError(
        (cause) => new MarketFeatureFailure({ reason: 'schema', message: 'invalid continuous crypto feature', cause }),
      ),
    )
    const material = feature.material
    const hash = (value: unknown) =>
      canonicalHashV1Result(value).pipe(
        Result.mapError(
          (cause) => new MarketFeatureFailure({ reason: 'hash', message: 'crypto feature cannot be hashed', cause }),
        ),
      )
    if (
      material.definitionHash !== (yield* hash(cryptoFeatureDefinitionMaterial)) ||
      feature.featureId !== (yield* hash(material))
    )
      return yield* fail('crypto feature definition or semantic identity differs')
    const start = BigInt(material.windowStartMs) * 1_000_000n
    const end = BigInt(material.windowEndMs) * 1_000_000n
    const minute = 60_000_000_000n
    const skew = BigInt(marketFeatureClockSkewAllowanceMs) * 1_000_000n
    const computed = BigInt(feature.computedAtMs) * 1_000_000n
    if (start % minute !== 0n || end % minute !== 0n || end <= start || computed + skew < end)
      return yield* fail('crypto feature does not bind a completed minute window')
    let previous = start - minute
    let history = material.historyPrefixHash
    const coordinates = new Set<string>()
    const topics = new Set<string>()
    for (const reference of material.inputs) {
      const event = BigInt(reference.eventTimeNanos)
      const ingestion = BigInt(reference.ingestionTimeNanos)
      const coordinate = `${reference.sourceTopic}:${reference.sourcePartition}:${reference.sourceOffset}`
      if (
        reference.sourcePartition > 2_147_483_647 ||
        BigInt(reference.sourceOffset) > 9_223_372_036_854_775_807n ||
        event < start ||
        event >= end ||
        event % minute !== 0n ||
        event <= previous ||
        ingestion + skew < event + minute ||
        computed + skew < ingestion ||
        coordinates.has(coordinate)
      )
        return yield* fail('crypto feature raw provenance is unordered, duplicated, premature, or unavailable')
      coordinates.add(coordinate)
      topics.add(reference.sourceTopic)
      history = yield* hash([history, reference])
      previous = event
    }
    if (
      topics.size !== 1 ||
      material.inputs[0]?.eventTimeNanos !== start.toString() ||
      previous + minute !== end ||
      history !== material.historyHash
    )
      return yield* fail('crypto feature input extent or history chain differs')
    {
      const values = material.priceWindow
      if (
        ![values.referencePrice, values.rangeHighPrice, values.rangeLowPrice, values.lastClosePrice].every(
          (value) => Number(value) > 0 && Number.isFinite(Number(value)),
        ) ||
        Number(values.rangeHighPrice) <
          Math.max(Number(values.referencePrice), Number(values.lastClosePrice), Number(values.rangeLowPrice)) ||
        Number(values.rangeLowPrice) > Math.min(Number(values.referencePrice), Number(values.lastClosePrice)) ||
        !Number.isFinite(Number(values.totalVolume))
      )
        return yield* fail('crypto observed price-window values are invalid')
    }
    for (const [name, scalar] of Object.entries(material.technical)) {
      if ((scalar.status === TechnicalReadiness.Ready) !== (scalar.value !== null))
        return yield* fail('crypto technical readiness and values disagree')
      if (scalar.value === null) continue
      const value = BigInt(scalar.value)
      if (
        value < -BigInt(Number.MAX_SAFE_INTEGER) ||
        value > BigInt(Number.MAX_SAFE_INTEGER) ||
        (name === 'rsi14Micros' && (value < 0n || value > 100_000_000n)) ||
        (name === 'realizedVolatility60ReturnsPpm' && value < 0n) ||
        (!name.startsWith('macd') && name.endsWith('PriceMicros') && value <= 0n)
      )
        return yield* fail('crypto technical scalar is outside its declared units')
    }
    return feature
  })
