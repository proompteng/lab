import { Result, Schema } from 'effect'

import { quantizeInstrumentPriceMicros } from '../../broker/alpaca-price'
import type { JevProtocol } from '../../jev/protocol'
import { strictParseOptions } from '../../schemas'
import { adaptiveStopAtr14Multiplier, adaptiveStopBufferBps } from '../execution-model/adaptive-collars'
import { IntradayAlphaV2PolicySchema, makeIntradayAlphaPolicy } from './policy'

const entryLimitSlippageBps = 30
const minimumStopLimitBps = 50
const maximumStopLimitBps = 150

export const IntradayAlphaPolicyV21Schema = IntradayAlphaV2PolicySchema.mapFields(
  (fields) => ({
    ...fields,
    schemaVersion: Schema.Literal('bayn.intraday-alpha-policy.v2_1'),
    entryLimitSlippageBps: Schema.Int.check(Schema.isBetween({ minimum: 25, maximum: 35 })),
    stopLimitCollar: Schema.Struct({
      minimumBps: Schema.Literal(minimumStopLimitBps),
      atr14Multiplier: Schema.Literal(adaptiveStopAtr14Multiplier),
      maximumBps: Schema.Literal(maximumStopLimitBps),
    }),
    partialBasketProtection: Schema.Literal('CANCEL_RECONCILE_TRIM'),
  }),
  // The inherited refinements check only universe and checkpoint fields, which are unchanged.
  { unsafePreserveChecks: true },
)
export type IntradayAlphaPolicyV21 = typeof IntradayAlphaPolicyV21Schema.Type

function freezePolicy<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezePolicy(child)
    Object.freeze(value)
  }
  return value
}

export const makeIntradayAlphaPolicyV21 = (protocol: JevProtocol, entryBps = entryLimitSlippageBps) =>
  Schema.decodeUnknownResult(
    IntradayAlphaPolicyV21Schema,
    strictParseOptions,
  )({
    ...makeIntradayAlphaPolicy(structuredClone(protocol)),
    schemaVersion: 'bayn.intraday-alpha-policy.v2_1',
    entryLimitSlippageBps: entryBps,
    stopLimitCollar: {
      minimumBps: minimumStopLimitBps,
      atr14Multiplier: adaptiveStopAtr14Multiplier,
      maximumBps: maximumStopLimitBps,
    },
    partialBasketProtection: 'CANCEL_RECONCILE_TRIM',
  }).pipe(Result.map(freezePolicy))

export const intradayAlphaV21StopLimitPriceMicros = (input: {
  readonly collar: IntradayAlphaPolicyV21['stopLimitCollar']
  readonly symbol: string
  readonly direction: 'LONG' | 'SHORT'
  readonly stopPriceMicros: bigint
  readonly atr14Ratio: number
}): bigint | null => {
  const { collar, symbol, direction, stopPriceMicros: stop, atr14Ratio } = input
  if (stop <= 0n || atr14Ratio <= 0 || atr14Ratio > 0.5) return null
  // The trailing baseline already expresses ATR14 as a price ratio. Apply that width to the stop.
  const adaptiveBps = adaptiveStopBufferBps(1, atr14Ratio)
  if (adaptiveBps === null) return null
  const bps = Math.min(collar.maximumBps, Math.max(collar.minimumBps, adaptiveBps))
  const bpsScale = 1_000_000
  const denominator = 10_000n * BigInt(bpsScale)
  const sign = direction === 'SHORT' ? 1n : -1n
  const boundary = stop * (denominator + sign * BigInt(Math.round(bps * bpsScale)))
  const cap = stop * (denominator + sign * BigInt(collar.maximumBps * bpsScale))
  // Round away from the trigger for execution tolerance, but round the hard cap toward the trigger.
  if (direction === 'SHORT') {
    const outward = quantizeInstrumentPriceMicros(symbol, (boundary + denominator - 1n) / denominator, 'UP')
    const ceiling = quantizeInstrumentPriceMicros(symbol, cap / denominator, 'DOWN')
    const limit = outward < ceiling ? outward : ceiling
    return limit > stop ? limit : null
  }
  const outward = quantizeInstrumentPriceMicros(symbol, boundary / denominator, 'DOWN')
  const floor = quantizeInstrumentPriceMicros(symbol, (cap + denominator - 1n) / denominator, 'UP')
  const limit = outward > floor ? outward : floor
  return limit > 0n && limit < stop ? limit : null
}
