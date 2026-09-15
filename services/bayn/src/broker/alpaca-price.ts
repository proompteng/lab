export type AlpacaLimitPriceDirection = 'DOWN' | 'UP'

export const alpacaLimitPriceIncrementMicros = (priceMicros: bigint): bigint =>
  priceMicros >= 1_000_000n ? 10_000n : 100n

export const quantizeAlpacaLimitPriceMicros = (priceMicros: bigint, direction: AlpacaLimitPriceDirection): bigint => {
  const increment = alpacaLimitPriceIncrementMicros(priceMicros)
  return direction === 'DOWN'
    ? (priceMicros / increment) * increment
    : ((priceMicros + increment - 1n) / increment) * increment
}
