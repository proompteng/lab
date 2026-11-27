import type { TradeSide } from './stock-in-play'

export type NoiseAreaTrail = 'vwap' | 'breakout-band' | 'opposite-band' | 'vwap-boundary'

/** A checkpoint close is compared to contemporaneous levels, not intrabar touches or running extrema. */
export const noiseAreaExitLevel = (
  side: TradeSide,
  trail: NoiseAreaTrail,
  vwap: number,
  lower: number,
  upper: number,
): number => {
  const breakoutBand = side === 1 ? upper : lower
  if (trail === 'vwap') return vwap
  if (trail === 'opposite-band') return side === 1 ? lower : upper
  if (trail === 'breakout-band') return breakoutBand
  return side === 1 ? Math.max(vwap, breakoutBand) : Math.min(vwap, breakoutBand)
}

/** Use only after the bar completes; the returned stop cannot be applied to that same bar. */
export const tightenProtectiveStop = (side: TradeSide, currentStop: number, nextStop: number): number =>
  side === 1 ? Math.max(currentStop, nextStop) : Math.min(currentStop, nextStop)

export const breakevenStopAfterOneR = (
  side: TradeSide,
  currentStop: number,
  entry: number,
  initialRisk: number,
  favorablePrice: number,
): number =>
  side * (favorablePrice - (entry + side * initialRisk)) >= 0
    ? tightenProtectiveStop(side, currentStop, entry)
    : currentStop
