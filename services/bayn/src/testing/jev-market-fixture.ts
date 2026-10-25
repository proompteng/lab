import { makeIntradayMomentumTestSnapshot } from '../strategy/intraday-momentum/test-support'

/** Synthetic entry scenarios include observed prices on both sides of the current quote. */
export const makeJevMarketTestSnapshot = (...input: Parameters<typeof makeIntradayMomentumTestSnapshot>) => {
  const raw = makeIntradayMomentumTestSnapshot(...input)
  const firstMinute = raw.bars[0]?.eventAt
  const quotes = new Map(raw.quotes.map((quote) => [quote.symbol, quote]))
  return {
    ...raw,
    bars: raw.bars.map((bar) => {
      const quote = quotes.get(bar.symbol)
      return bar.eventAt === firstMinute && bar.symbol !== 'SPY' && quote !== undefined
        ? { ...bar, high: Math.max(bar.high, quote.askPrice * 1.05), low: Math.min(bar.low, quote.bidPrice * 0.95) }
        : bar
    }),
  }
}
