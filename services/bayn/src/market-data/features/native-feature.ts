import { Result, Schema } from 'effect'

import type { IntradayBar } from '../intraday/model'
import { intradayInstantNanos } from '../intraday/time'
import { nativeSourceContentHash } from '../native-json'
import {
  featureMatchesBars,
  RollingMarketFeatureSchema,
  type RollingMarketFeature,
  type RollingMarketValues,
} from './contract'
import { CryptoMarketFeatureSchema, isCryptoMarketFeature, type CryptoMarketFeature } from './crypto-contract'
import { MarketFeatureFailure } from './feature-core'

export const NativeMarketFeatureSchema = Schema.Union([RollingMarketFeatureSchema, CryptoMarketFeatureSchema])
export type NativeMarketFeature = RollingMarketFeature | CryptoMarketFeature

export const rollingWindowStartMs = (feature: NativeMarketFeature) =>
  isCryptoMarketFeature(feature) ? feature.material.windowEndMs - 30 * 60_000 : feature.material.windowStartMs

export const rollingValues = (feature: NativeMarketFeature) => {
  if (isCryptoMarketFeature(feature)) {
    const values = feature.material.priceWindow
    return {
      reference: Number(values.referencePrice),
      high: Number(values.rangeHighPrice),
      low: Number(values.rangeLowPrice),
      close: Number(values.lastClosePrice),
      volume: Number(values.totalVolume),
    }
  }
  const values = feature.material.values
  return {
    reference: Number(values.referencePriceMicros) / 1_000_000,
    high: Number(values.rangeHighPriceMicros) / 1_000_000,
    low: Number(values.rangeLowPriceMicros) / 1_000_000,
    close: Number(values.lastClosePriceMicros) / 1_000_000,
    volume: Number(values.totalVolumeMicros) / 1_000_000,
  }
}

export const nativeFeatureMatchesBars = (
  feature: NativeMarketFeature,
  bars: readonly IntradayBar[],
): Result.Result<boolean, MarketFeatureFailure> => {
  if (!isCryptoMarketFeature(feature)) return featureMatchesBars(feature, bars)
  const start = BigInt(rollingWindowStartMs(feature)) * 1_000_000n
  const inputs = feature.material.inputs.filter((input) => BigInt(input.eventTimeNanos) >= start)
  if (bars.length === 0 || bars.length !== inputs.length) return Result.succeed(false)
  const ordered = bars.toSorted((left, right) => left.eventAt.localeCompare(right.eventAt))
  return Result.gen(function* () {
    for (const [index, bar] of ordered.entries()) {
      const input = inputs[index]
      if (bar.nativePayload === undefined) return false
      const retainedPayload = bar.nativePayload
      const payload = yield* Result.try({
        try: (): unknown => JSON.parse(retainedPayload),
        catch: (cause) =>
          new MarketFeatureFailure({ reason: 'schema', message: 'retained crypto payload is not JSON', cause }),
      }).pipe(
        Result.flatMap(
          Schema.decodeUnknownResult(
            Schema.Struct({
              o: Schema.Finite,
              h: Schema.Finite,
              l: Schema.Finite,
              c: Schema.Finite,
              v: Schema.Finite,
              vw: Schema.optionalKey(Schema.Finite),
            }),
          ),
        ),
        Result.mapError(
          (cause) => new MarketFeatureFailure({ reason: 'schema', message: 'invalid retained crypto bar', cause }),
        ),
      )
      if (
        payload.o !== bar.open ||
        payload.h !== bar.high ||
        payload.l !== bar.low ||
        payload.c !== bar.close ||
        payload.v !== bar.volume ||
        (payload.vw ?? null) !== bar.vwap
      )
        return false
      const matches =
        input !== undefined &&
        bar.nativePayload !== undefined &&
        bar.provider === 'alpaca' &&
        bar.feed === 'us' &&
        bar.delayClass === 'real_time_crypto' &&
        bar.marketSession === 'continuous' &&
        bar.symbol === feature.material.symbol &&
        bar.final &&
        input.eventTimeNanos === String(intradayInstantNanos(bar.eventAt)) &&
        input.ingestionTimeNanos === String(intradayInstantNanos(bar.ingestedAt)) &&
        input.sourceTopic === bar.sourceTopic &&
        input.sourcePartition === bar.sourcePartition &&
        input.sourceOffset === bar.sourceOffset &&
        input.contentHash ===
          nativeSourceContentHash(
            [bar.provider, bar.feed, bar.symbol, bar.channel, input.eventTimeNanos, input.ingestionTimeNanos],
            bar.nativePayload,
          )
      if (!matches) return false
    }
    return true
  })
}

export const equityRollingValues = (
  feature: NativeMarketFeature,
): Result.Result<RollingMarketValues, MarketFeatureFailure> =>
  isCryptoMarketFeature(feature)
    ? Result.fail(
        new MarketFeatureFailure({ reason: 'identity', message: 'equity research requires an equity feature' }),
      )
    : Result.succeed(feature.material.values)
