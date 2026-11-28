import { v4Rules } from './policy'

export enum Direction {
  Long = 1,
  Short = -1,
}

// These are confirmation peers, not additional traded symbols.
export const breadthSymbols = ['QQQ', 'SMH', 'XLK', 'SPY', 'IWM'] as const
type BreadthSymbol = (typeof breadthSymbols)[number]
export type CandidateSymbol = 'QQQ' | 'SMH'

const openingBars = v4Rules.openingRangeMinutes / v4Rules.barMinutes
const efficiencyBars = v4Rules.efficiencyLookbackMinutes / v4Rules.barMinutes

export interface PriceBar {
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
}

interface VolumeBar extends PriceBar {
  readonly volume: number
  readonly vwap: number
}

export const trueRange = (bar: PriceBar, previousClose: number) =>
  Math.max(bar.high, previousClose) - Math.min(bar.low, previousClose)

/** Accepts only the completed regular-session prefix of a verified 5m tape. Never bridge a missing bar. */
export const observeCheckpoint = (prefix: readonly (VolumeBar | undefined)[], previousClose?: number) => {
  const open = prefix[0]?.open
  const close = prefix.at(-1)?.close
  if (prefix.length <= openingBars || open === undefined || close === undefined) return

  let previous = open
  let openingHigh = -Infinity
  let openingLow = Infinity
  let volume = 0
  let tradedValue = 0
  let atrSum = 0
  const gap = previousClose === undefined ? undefined : Math.log(open / previousClose)
  let noiseSquared = gap === undefined ? undefined : gap ** 2
  let path = 0
  let start = open
  const firstAtrBar = Math.max(0, prefix.length - v4Rules.atrBars)
  const firstEfficiencyBar = Math.max(0, prefix.length - efficiencyBars)
  for (const [index, bar] of prefix.entries()) {
    if (bar === undefined) return
    if (index < openingBars) {
      openingHigh = Math.max(openingHigh, bar.high)
      openingLow = Math.min(openingLow, bar.low)
    }
    volume += bar.volume
    tradedValue += bar.vwap * bar.volume
    if (index >= firstAtrBar) atrSum += trueRange(bar, previous)
    if (noiseSquared !== undefined) noiseSquared += Math.log(bar.close / previous) ** 2
    if (index === firstEfficiencyBar) start = previous
    if (index >= firstEfficiencyBar) path += Math.abs(bar.close - previous)
    previous = bar.close
  }
  if (volume <= 0) return
  return {
    open,
    close,
    openingHigh,
    openingLow,
    vwap: tradedValue / volume,
    realizedNoise: noiseSquared === undefined ? undefined : Math.sqrt(noiseSquared),
    atr: atrSum / (prefix.length - firstAtrBar),
    signedEfficiency: path > 0 ? (close - start) / path : 0,
  }
}

export type Checkpoint = NonNullable<ReturnType<typeof observeCheckpoint>>

/** Common reserved budgets remain a ceiling; a quieter name never inherits another name's unused allocation. */
export const inverseNoiseScale = (observation: Checkpoint | undefined, typicalNoise: number | undefined) => {
  const noise = observation?.realizedNoise
  if (noise === undefined || typicalNoise === undefined || typicalNoise <= 0) return 0
  return noise <= typicalNoise ? 1 : typicalNoise / noise
}

export const confirmsRegime = (
  symbol: CandidateSymbol,
  direction: Direction,
  minutesAfterOpen: number,
  observations: ReadonlyMap<BreadthSymbol, Checkpoint>,
) => {
  const entry = observations.get(symbol)
  if (entry === undefined || direction * (entry.close - entry.vwap) <= 0) return false
  const openingEdge = direction === Direction.Long ? entry.openingHigh : entry.openingLow
  if (direction * (entry.close - openingEdge) <= 0) return false

  // A breakout during lunch must also make net directional progress relative to its recent path.
  if (
    minutesAfterOpen >= v4Rules.middayStartMinutes &&
    minutesAfterOpen <= v4Rules.middayEndMinutes &&
    direction * entry.signedEfficiency < v4Rules.middayMinEfficiency
  )
    return false
  let votes = 0
  for (const peer of breadthSymbols) {
    if (peer === symbol) continue
    const observation = observations.get(peer)
    if (observation === undefined) return false
    if (
      direction * (observation.close - observation.open) > 0 &&
      direction * (observation.close - observation.vwap) > 0
    )
      votes++
  }
  return votes >= v4Rules.minimumPeerVotes
}
