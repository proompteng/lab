import { Result } from 'effect'

import { quantizeInstrumentPriceMicros } from '../src/broker/alpaca-price'
import { OrderSide, OrderType, TimeInForce } from '../src/execution/contracts'
import { deriveExecutionIntentPricing } from '../src/execution/intent-pricing'
import { quantityScale } from '../src/quantity'
import { priceNumberToMicros } from '../src/strategy/execution-model/fixed-point'
import type { Bar } from './midday-research-data'

export type Direction = 1 | -1
export const microsPerDollar = 1_000_000
export const bps = (price: number, reference: number) => ((price - reference) / reference) * 10_000

const usd = (micros: bigint) => Number(micros) / microsPerDollar
const priceMicros = (price: number, rounding: 'UP' | 'DOWN') =>
  Result.getOrThrow(priceNumberToMicros(price, 'microstructure proxy price', rounding))

const inwardTick = (symbol: string, price: number, rounding: 'UP' | 'DOWN') =>
  quantizeInstrumentPriceMicros(
    symbol,
    BigInt((rounding === 'UP' ? Math.ceil : Math.floor)(price * microsPerDollar)),
    rounding,
  )

export const entryLimit = (symbol: string, direction: Direction, close: number, collarBps: number) => {
  const reference = quantizeInstrumentPriceMicros(
    symbol,
    priceMicros(close, direction === 1 ? 'UP' : 'DOWN'),
    direction === 1 ? 'UP' : 'DOWN',
  )
  if (Number.isInteger(collarBps))
    return usd(
      Result.getOrThrow(
        deriveExecutionIntentPricing({
          symbol,
          side: direction === 1 ? OrderSide.Buy : OrderSide.Sell,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.Day,
          quantityAtoms: quantityScale,
          referencePriceMicros: reference,
          limitSlippageBps: BigInt(collarBps),
        }),
      ).expectedExecutionPriceMicros,
    )

  // The research-only fractional-bp variant uses the same inward tick direction as the fixed collar.
  const rounding = direction === 1 ? 'DOWN' : 'UP'
  return usd(inwardTick(symbol, usd(reference) * (1 + (direction * collarBps) / 10_000), rounding))
}

export const stopLimit = (symbol: string, direction: Direction, stop: number, offsetBps: number) => {
  const rounding = direction === 1 ? 'UP' : 'DOWN'
  if (Number.isInteger(offsetBps)) {
    const trigger = priceMicros(stop, rounding)
    const offset = trigger * (10_000n - BigInt(direction) * BigInt(offsetBps))
    return usd(quantizeInstrumentPriceMicros(symbol, (offset + (direction === 1 ? 9_999n : 0n)) / 10_000n, rounding))
  }
  return usd(inwardTick(symbol, stop * (1 - (direction * offsetBps) / 10_000), rounding))
}

export const adversePrice = (price: number, side: Direction, roundTripBps: number) =>
  price * (1 + (side * roundTripBps) / 20_000)

export const clearsLimit = (price: number, limit: number, side: Direction) => side * (price - limit) <= 0

export type ExitPath = {
  readonly exit: {
    readonly minute: number
    readonly price: number
    readonly reason: 'stop' | 'target' | 'timed'
  } | null
  readonly triggeredMinute: number | null
  readonly blockedMinutes: number
  readonly missingWorkingMinutes: number
  readonly ambiguousTriggers: number
  readonly worstBlockedPrice: number | null
}

export const followExit = (input: {
  readonly bars: ReadonlyMap<number, Bar>
  readonly direction: Direction
  readonly entryMinute: number
  readonly dueMinute: number
  readonly sessionMinutes: number
  readonly stop: number
  readonly stopLimit: number
  readonly target: number
  readonly roundTripBps: number
}): ExitPath => {
  const { bars, direction, entryMinute, dueMinute, sessionMinutes, stop, stopLimit, target, roundTripBps } = input
  const side = direction === 1 ? -1 : 1
  let triggeredMinute: number | null = null
  let blockedMinutes = 0
  let missingWorkingMinutes = 0
  let ambiguousTriggers = 0
  let worstBlockedPrice: number | null = null
  const result = (exit: ExitPath['exit']): ExitPath => ({
    exit,
    triggeredMinute,
    blockedMinutes,
    missingWorkingMinutes,
    ambiguousTriggers,
    worstBlockedPrice,
  })
  const bound = (rawPrice: number) => adversePrice(rawPrice, side, roundTripBps)
  const hitsStop = (price: number) => direction * (price - stop) <= 0
  for (let minute = entryMinute; minute < sessionMinutes; minute++) {
    const bar = bars.get(minute)
    if (bar === undefined) {
      if (triggeredMinute !== null && minute <= dueMinute) missingWorkingMinutes++
      continue
    }
    if (minute > dueMinute) return result({ minute, price: bound(bar.open), reason: 'timed' })
    const openPrice = bound(bar.open)
    if (triggeredMinute === null && clearsLimit(openPrice, target, side))
      return result({ minute, price: openPrice, reason: 'target' })
    const adverseExtreme = direction === 1 ? bar.low : bar.high
    const favorableExtreme = direction === 1 ? bar.high : bar.low
    const touchedStop = hitsStop(adverseExtreme)
    const touchedTarget = clearsLimit(bound(favorableExtreme), target, side)
    if (triggeredMinute === null && touchedStop && touchedTarget) ambiguousTriggers++
    if (triggeredMinute !== null || touchedStop) {
      const activeAtOpen = triggeredMinute !== null || hitsStop(bar.open)
      triggeredMinute ??= minute
      if (activeAtOpen && clearsLimit(openPrice, stopLimit, side))
        return result({ minute, price: openPrice, reason: 'stop' })
      // The adverse extreme is itself a trigger print. If even that executable proxy clears
      // the limit, do not book the wider limit as an extra charge on otherwise identical paths.
      if (!activeAtOpen && clearsLimit(bound(adverseExtreme), stopLimit, side))
        return result({ minute, price: bound(adverseExtreme), reason: 'stop' })
      // Otherwise require a subsequent recovery. An intrabar trigger cannot use a favorable
      // extreme that may be in the past; the completed close provides the ordered endpoint.
      if (clearsLimit(bound(activeAtOpen ? favorableExtreme : bar.close), stopLimit, side))
        return result({ minute, price: stopLimit, reason: 'stop' })
      blockedMinutes++
      const blocked = bound(adverseExtreme)
      if (worstBlockedPrice === null || direction * (blocked - worstBlockedPrice) < 0) worstBlockedPrice = blocked
      continue
    }
    if (touchedTarget) return result({ minute, price: target, reason: 'target' })
  }
  return result(null)
}

// The closing order can only use a pre-deadline reference. Missing bars and prices beyond
// the limit are not fills; the deadline is exclusive of the regular closing auction.
export const probeTimedClose = (input: {
  readonly bars: ReadonlyMap<number, Bar>
  readonly dueMinute: number
  readonly sessionMinutes: number
  readonly direction: Direction
  readonly roundTripBps: number
  readonly limitBps: number
  readonly delayMinutes: number
}) => {
  const { bars, dueMinute, sessionMinutes, direction, roundTripBps, limitBps, delayMinutes } = input
  const reference = bars.get(dueMinute - 1)?.close
  const arrivalMinute = dueMinute + delayMinutes
  const open = arrivalMinute < sessionMinutes ? bars.get(arrivalMinute)?.open : undefined
  if (reference === undefined || open === undefined) return null
  const price = adversePrice(open, direction === 1 ? -1 : 1, roundTripBps)
  const adverseBps = -direction * bps(price, reference)
  return { price, adverseBps, clears: adverseBps <= limitBps }
}
