/**
 * Research primitives for a future policy. ATR14 and its reference must have the same price units.
 * Invalid or unavailable volatility never grants a fallback collar.
 */
export const adaptiveEntryCollarBps = (completedClose: number, atr14: number): number | null => {
  if (!Number.isFinite(completedClose) || completedClose <= 0 || !Number.isFinite(atr14) || atr14 < 0) return null
  return Math.min(40, Math.max(15, (atr14 / completedClose) * 1_000))
}

export const adaptiveStopAtr14Multiplier = 0.25

/** The stop buffer is separate from entry tolerance and expressed relative to the stop, not the entry. */
export const adaptiveStopBufferBps = (stop: number, atr14: number): number | null => {
  if (!Number.isFinite(stop) || stop <= 0 || !Number.isFinite(atr14) || atr14 < 0) return null
  const bps = (atr14 / stop) * (10_000 * adaptiveStopAtr14Multiplier)
  // A symmetric buffer may not consume the entire reference price.
  return bps < 10_000 ? bps : null
}
