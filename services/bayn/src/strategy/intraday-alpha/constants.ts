import { currentEquityUniverse } from '../intraday-market'

export enum IntradayAlphaPhase {
  MorningOrb = 'MORNING_ORB',
  MiddayReversion = 'MIDDAY_REVERSION',
  NoiseAreaTrend = 'NOISE_AREA_TREND',
  OutsideWindow = 'OUTSIDE_WINDOW',
}

export enum IntradayAlphaSetup {
  Orb30Long = 'ORB30_BREAKOUT_LONG',
  Orb30Short = 'ORB30_BREAKDOWN_SHORT',
  MiddayVwapReversionLong = 'MIDDAY_VWAP_REVERSION_LONG',
  MiddayVwapReversionShort = 'MIDDAY_VWAP_REVERSION_SHORT',
  NoiseAreaLong = 'NOISE_AREA_MOMENTUM_LONG',
  NoiseAreaShort = 'NOISE_AREA_MOMENTUM_SHORT',
}

/**
 * 20 liquid real-time equities from torghut-core-equity-v3 (excluding SPY benchmark and thin CRDO).
 * Every candidate is marginable, shortable, easy-to-borrow on Alpaca, and streams full RTH bars.
 */
export const intradayAlphaCandidateSymbols = Object.freeze(
  currentEquityUniverse.symbols.filter((symbol) => symbol !== 'SPY' && symbol !== 'CRDO'),
)

/**
 * Disjoint index/sector ETFs reserved exclusively for Zarattini-Aziz-Barbon Noise Area momentum.
 * Engine 1 (Morning ATR-ORB30) and Engine 2 (Midday Relative-VWAP Reversion) never trade these symbols.
 */
export const intradayAlphaNoiseAreaSymbols = Object.freeze(['QQQ', 'SMH'] as const)

/** 18 single-name equities reserved exclusively for Morning ATR-ORB30 and Midday Relative-VWAP Reversion. */
export const intradayAlphaEquitySymbols = Object.freeze(
  intradayAlphaCandidateSymbols.filter(
    (symbol) => !(intradayAlphaNoiseAreaSymbols as readonly string[]).includes(symbol),
  ),
)

export const intradayAlphaBenchmarkSymbol = 'SPY' as const
