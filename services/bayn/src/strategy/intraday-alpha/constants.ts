import { intradayUniverse } from '../intraday-market'

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

/** 15 real-time WebSocket equities from intradayUniverse (excluding SPY benchmark). */
export const intradayAlphaCandidateSymbols = Object.freeze(
  intradayUniverse.symbols.filter((symbol) => symbol !== 'SPY'),
)

export const intradayAlphaBenchmarkSymbol = 'SPY' as const
