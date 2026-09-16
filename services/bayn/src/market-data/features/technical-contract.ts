import { Result, Schema } from 'effect'
import { strictParseOptions } from '../../schemas'
import type { IntradayBar } from '../intraday/model'
import { intradayInstantNanos } from '../intraday/time'
import {
  MarketFeatureFailure,
  MarketFeatureInputSchema,
  MarketFeatureSessionPolicy,
  RollingMarketFeatureMaterialSchema,
  RollingMarketFeatureSchema,
  featureBarContentHash,
  marketFeatureClockSkewAllowanceMs,
  marketFeatureHash,
} from './contract'

export enum TechnicalFeatureContract {
  V1 = 'dorvud.technical-feature.v1',
}
export enum TechnicalFeatureDefinition {
  Indicators1m = 'dorvud.technical-indicators-1m.v1',
}
export enum TechnicalReadiness {
  Ready = 'READY',
  Warming = 'WARMING',
  Gap = 'GAP',
  SourceMissing = 'SOURCE_MISSING',
  ZeroVolume = 'ZERO_VOLUME',
}

export const TechnicalFeatureValueSchema = Schema.Struct({
  status: Schema.Enum(TechnicalReadiness),
  value: Schema.NullOr(Schema.String.check(Schema.isPattern(/^(?:0|-?[1-9][0-9]*)$/))),
})
export const TechnicalMarketValuesSchema = Schema.Struct({
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
  weightedCloseSessionPriceMicros: TechnicalFeatureValueSchema,
  vwap5mPriceMicros: TechnicalFeatureValueSchema,
  vwapSessionPriceMicros: TechnicalFeatureValueSchema,
  realizedVolatility60ReturnsPpm: TechnicalFeatureValueSchema,
})
export const TechnicalMarketFeatureMaterialSchema = Schema.Struct({
  ...RollingMarketFeatureMaterialSchema.fields,
  schemaVersion: Schema.Enum(TechnicalFeatureContract),
  definitionId: Schema.Enum(TechnicalFeatureDefinition),
  inputs: Schema.Array(MarketFeatureInputSchema).check(Schema.isLengthBetween(1, 390)),
  values: TechnicalMarketValuesSchema,
})
export const TechnicalMarketFeatureSchema = Schema.Struct({
  ...RollingMarketFeatureSchema.fields,
  material: TechnicalMarketFeatureMaterialSchema,
})
export type TechnicalMarketFeature = typeof TechnicalMarketFeatureSchema.Type

export const technicalFeatureDefinitionMaterial = [
  TechnicalFeatureDefinition.Indicators1m,
  MarketFeatureSessionPolicy.RegularNewYork,
  'PT1M;session:09:30-16:00;canonical-session-recompute;no-synthetic-bars',
  'EMA:12,26;alpha:2/(n+1);seed:first-close;ready:12,26',
  'MACD:EMA12-EMA26;signal:9;seed:zero;ready:34',
  'RSI:14;gain-loss-alpha:1/14;seed:zero;ready:15;flat:0',
  'Bollinger:20;population-standard-deviation;2-sigma',
  'weighted-close:5m,session;source-VWAP:5m,session;zero-volume:unavailable',
  'volatility:60-log-returns;population-standard-deviation;not-annualized',
  'recursive-and-session:complete-from-open;rolling:contiguous-tail',
  'binary64-times-1000000-round-half-positive-infinity;safe-signed-integer-string',
  'RSI:percentage-point-micros;volatility:ratio-ppm;prices:micros',
  'bar-winner:ingestion-nanos,partition,offset;raw-content:binary64-hex-v1',
  `cross-host-clock-skew-ms:${marketFeatureClockSkewAllowanceMs}`,
]
const expectedDefinitionHash = marketFeatureHash(technicalFeatureDefinitionMaterial)
const newYorkDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const newYorkTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const fail = (reason: MarketFeatureFailure['reason'], message: string, cause?: unknown) =>
  new MarketFeatureFailure({ reason, message, ...(cause === undefined ? {} : { cause }) })
const horizons: Record<keyof TechnicalMarketFeature['material']['values'], { count: number; recursive: boolean }> = {
  ema12PriceMicros: { count: 12, recursive: true },
  ema26PriceMicros: { count: 26, recursive: true },
  macdPriceMicros: { count: 34, recursive: true },
  macdSignalPriceMicros: { count: 34, recursive: true },
  macdHistogramPriceMicros: { count: 34, recursive: true },
  rsi14Micros: { count: 15, recursive: true },
  bollingerMiddlePriceMicros: { count: 20, recursive: false },
  bollingerUpperPriceMicros: { count: 20, recursive: false },
  bollingerLowerPriceMicros: { count: 20, recursive: false },
  weightedClose5mPriceMicros: { count: 5, recursive: false },
  weightedCloseSessionPriceMicros: { count: 1, recursive: true },
  vwap5mPriceMicros: { count: 5, recursive: false },
  vwapSessionPriceMicros: { count: 1, recursive: true },
  realizedVolatility60ReturnsPpm: { count: 61, recursive: false },
}
const contiguous = (times: readonly bigint[]) =>
  times.every((time, index) => index === 0 || time - (times[index - 1] ?? time) === 60_000_000_000n)

export const decodeTechnicalMarketFeature = (
  input: unknown,
): Result.Result<TechnicalMarketFeature, MarketFeatureFailure> =>
  Result.gen(function* () {
    const feature = yield* Schema.decodeUnknownResult(
      TechnicalMarketFeatureSchema,
      strictParseOptions,
    )(input).pipe(Result.mapError((cause) => fail('schema', 'Invalid technical feature message', cause)))
    const { material } = feature
    if (material.definitionHash !== (yield* expectedDefinitionHash))
      return yield* Result.fail(fail('identity', 'Unknown technical feature definition'))
    if (feature.featureId !== (yield* marketFeatureHash(material)))
      return yield* Result.fail(fail('hash', 'Technical feature identity differs from content'))
    if (
      material.windowStartMs % 60_000 !== 0 ||
      material.windowEndMs % 60_000 !== 0 ||
      material.windowEndMs <= material.windowStartMs ||
      material.windowEndMs - material.windowStartMs > 390 * 60_000 ||
      newYorkDate.format(material.windowStartMs) !== material.sessionDate ||
      newYorkTime.format(material.windowStartMs) !== '09:30' ||
      feature.computedAtMs + marketFeatureClockSkewAllowanceMs < material.windowEndMs
    )
      return yield* Result.fail(fail('window', 'Invalid technical session window or computation time'))
    const start = BigInt(material.windowStartMs) * 1_000_000n
    const end = BigInt(material.windowEndMs) * 1_000_000n
    let previous = start - 60_000_000_000n
    const coordinates = new Set<string>(),
      topics = new Set<string>()
    const times: bigint[] = []
    for (const reference of material.inputs) {
      const time = BigInt(reference.eventTimeNanos),
        ingestion = BigInt(reference.ingestionTimeNanos)
      const coordinate = `${reference.sourceTopic}:${reference.sourcePartition}:${reference.sourceOffset}`
      if (
        time < start ||
        time >= end ||
        time <= previous ||
        time % 60_000_000_000n !== 0n ||
        ingestion + BigInt(marketFeatureClockSkewAllowanceMs) * 1_000_000n < time + 60_000_000_000n ||
        ingestion > BigInt(feature.computedAtMs + marketFeatureClockSkewAllowanceMs) * 1_000_000n + 999_999n ||
        reference.sourcePartition > 2_147_483_647 ||
        BigInt(reference.sourceOffset) > 9_223_372_036_854_775_807n ||
        coordinates.has(coordinate)
      )
        return yield* Result.fail(fail('input', 'Invalid technical input order, availability or provenance'))
      coordinates.add(coordinate)
      topics.add(reference.sourceTopic)
      times.push(time)
      previous = time
    }
    if (topics.size !== 1 || previous !== end - 60_000_000_000n)
      return yield* Result.fail(
        fail('input', 'Technical inputs must end at the declared window and use one source topic'),
      )
    const complete = times[0] === start && contiguous(times)
    for (const name of Object.keys(horizons) as (keyof typeof horizons)[]) {
      const scalar = material.values[name],
        horizon = horizons[name]
      const expected =
        horizon.recursive && !complete
          ? TechnicalReadiness.Gap
          : times.length < horizon.count
            ? TechnicalReadiness.Warming
            : !contiguous(times.slice(-horizon.count))
              ? TechnicalReadiness.Gap
              : TechnicalReadiness.Ready
      const weighted = name.startsWith('weightedClose') || name.startsWith('vwap')
      if (
        (scalar.status === TechnicalReadiness.Ready) !== (scalar.value !== null) ||
        (scalar.status !== expected &&
          !(
            expected === TechnicalReadiness.Ready &&
            weighted &&
            (scalar.status === TechnicalReadiness.ZeroVolume ||
              (name.startsWith('vwap') && scalar.status === TechnicalReadiness.SourceMissing))
          ))
      )
        return yield* Result.fail(
          fail('input', 'Technical readiness differs from source coverage or value availability'),
        )
      if (scalar.value === null) continue
      const value = BigInt(scalar.value)
      const signed = [
        'macdPriceMicros',
        'macdSignalPriceMicros',
        'macdHistogramPriceMicros',
        'bollingerLowerPriceMicros',
      ].includes(name)
      if (
        value > BigInt(Number.MAX_SAFE_INTEGER) ||
        value < -BigInt(Number.MAX_SAFE_INTEGER) ||
        (!signed && value < 0n) ||
        (name === 'rsi14Micros' && value > 100_000_000n)
      )
        return yield* Result.fail(fail('input', 'Technical value violates its numeric domain'))
    }
    return feature
  })

/** Checks the raw decision window against the matching suffix of the full-session producer provenance. */
export const technicalFeatureMatchesBars = (feature: TechnicalMarketFeature, bars: readonly IntradayBar[]) =>
  Result.gen(function* () {
    const { material } = feature
    const ordered = bars.toSorted((left, right) => left.eventAt.localeCompare(right.eventAt))
    if (ordered.length === 0 || ordered.length > material.inputs.length) return false
    const references = material.inputs.slice(-ordered.length)
    for (const [index, bar] of ordered.entries()) {
      const reference = references[index]
      if (
        reference === undefined ||
        bar.provider !== material.provider ||
        bar.feed !== material.feed ||
        bar.delayClass !== material.delayClass ||
        bar.universeId !== material.universeId ||
        bar.universeSymbolHash !== material.universeSymbolHash ||
        bar.symbol !== material.symbol ||
        bar.marketSession !== 'regular' ||
        !bar.final ||
        reference.eventTimeNanos !== String(intradayInstantNanos(bar.eventAt)) ||
        reference.ingestionTimeNanos !== String(intradayInstantNanos(bar.ingestedAt)) ||
        reference.sourceTopic !== bar.sourceTopic ||
        reference.sourcePartition !== bar.sourcePartition ||
        reference.sourceOffset !== bar.sourceOffset ||
        reference.contentHash !== (yield* featureBarContentHash(bar))
      )
        return false
    }
    return true
  })
