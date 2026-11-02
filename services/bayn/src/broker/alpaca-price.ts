import { instrumentMarket, MarketKind } from '../instruments'
export type AlpacaLimitPriceDirection = 'DOWN' | 'UP'

export const alpacaLimitPriceIncrementMicros = (priceMicros: bigint): bigint =>
  priceMicros >= 1_000_000n ? 10_000n : 100n

export const quantizeAlpacaLimitPriceMicros = (priceMicros: bigint, direction: AlpacaLimitPriceDirection): bigint => {
  const increment = alpacaLimitPriceIncrementMicros(priceMicros)
  return direction === 'DOWN'
    ? (priceMicros / increment) * increment
    : ((priceMicros + increment - 1n) / increment) * increment
}

export const quantizeInstrumentPriceMicros = (
  symbol: string,
  priceMicros: bigint,
  direction: AlpacaLimitPriceDirection,
): bigint =>
  instrumentMarket(symbol) === MarketKind.Crypto ? priceMicros : quantizeAlpacaLimitPriceMicros(priceMicros, direction)
