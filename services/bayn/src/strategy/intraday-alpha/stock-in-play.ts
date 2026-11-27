/** Volume from one fully observed opening range, or null when any minute was missing. */
export const openingRangeRelativeVolume = (
  volume: number | null,
  priorVolumes: readonly (number | null)[],
): number | null => {
  if (volume === null || !Number.isFinite(volume) || volume <= 0 || priorVolumes.length !== 14) return null
  let total = 0
  for (const prior of priorVolumes) {
    if (prior === null || !Number.isFinite(prior) || prior <= 0) return null
    total += prior
  }
  return Number.isFinite(total) ? volume / (total / 14) : null
}

export type TradeSide = 1 | -1

/** Positive only outside the range; an optional cap measures absolute distance in ATR units, not percent. */
export const cappedBreakoutExtension = (
  side: TradeSide,
  close: number,
  boundary: number,
  atr: number,
  cap: number | null,
): number | null => {
  const extension = side * (close - boundary)
  if (!Number.isFinite(extension) || extension <= 0 || boundary <= 0) return null
  if (cap !== null && (!Number.isFinite(atr) || atr <= 0 || extension > cap * atr)) return null
  return extension / boundary
}
