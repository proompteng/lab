import { currentEquityUniverse } from '../intraday-market'

export enum IntradayAlphaPhase {
  MorningOrb = 'MORNING_ORB',
  MiddayReversion = 'MIDDAY_REVERSION',
  OutsideWindow = 'OUTSIDE_WINDOW',
}

export enum IntradayAlphaSetup {
  Orb30Long = 'ORB30_BREAKOUT_LONG',
  Orb30Short = 'ORB30_BREAKDOWN_SHORT',
  MiddayVwapReversionLong = 'MIDDAY_VWAP_REVERSION_LONG',
  MiddayVwapReversionShort = 'MIDDAY_VWAP_REVERSION_SHORT',
}

/**
 * 20 liquid real-time equities from torghut-core-equity-v3 (excluding SPY benchmark and thin CRDO).
 * Every candidate is marginable, shortable, easy-to-borrow on Alpaca, and streams full RTH bars.
 */
export const intradayAlphaCandidateSymbols = Object.freeze(
  currentEquityUniverse.symbols.filter((symbol) => symbol !== 'SPY' && symbol !== 'CRDO'),
)

export const intradayAlphaBenchmarkSymbol = 'SPY' as const
