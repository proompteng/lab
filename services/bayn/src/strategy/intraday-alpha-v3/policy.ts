import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { strictParseOptions } from '../../schemas'

export const equitySymbols = Object.freeze([
  'AAPL',
  'ALAB',
  'AMAT',
  'AMD',
  'AMZN',
  'ANET',
  'APP',
  'ARM',
  'ASML',
  'AVGO',
  'CEG',
  'COHR',
  'COIN',
  'CRDO',
  'CRWD',
  'GEV',
  'GOOGL',
  'HOOD',
  'INTC',
  'KLAC',
  'LITE',
  'LRCX',
  'META',
  'MRVL',
  'MSFT',
  'MSTR',
  'MU',
  'NET',
  'NFLX',
  'NOW',
  'NVDA',
  'ORCL',
  'PANW',
  'PLTR',
  'SHOP',
  'SMCI',
  'SNDK',
  'SNOW',
  'SOFI',
  'SPOT',
  'TSLA',
  'TSM',
  'UBER',
  'VRT',
  'VST',
  'WDC',
] as const)
export const trendSymbols = Object.freeze(['QQQ', 'SMH'] as const)
export type EquitySymbol = (typeof equitySymbols)[number]
export type TrendSymbol = (typeof trendSymbols)[number]
export type AlphaV3Symbol = EquitySymbol | TrendSymbol
export const benchmarkSymbol = 'SPY'
export const sipSymbols = Object.freeze([...equitySymbols, ...trendSymbols, benchmarkSymbol] as const)

export enum AlphaV3Engine {
  Orb = 'OR5',
  Noise = 'NOISE_AREA',
  Reversion = 'NOON_REVERSION',
}

export enum AlphaV3Direction {
  Long = 'LONG',
  Short = 'SHORT',
}

export enum AlphaV3Allocation {
  Equal = 'EQUAL',
  OrbTilt = 'OR5_TILT',
}

export enum AlphaV3NoonExit {
  Timed = 'TIMED_EOD',
  Bracket = 'BRACKET_500_800',
}

const exactSymbols = (symbols: readonly string[]) =>
  Schema.Array(Schema.String).check(
    Schema.makeFilter(
      (actual) => actual.length === symbols.length && symbols.every((symbol, i) => actual[i] === symbol),
      {
        expected: 'the exact ordered Wave 3B symbol list',
      },
    ),
  )

const defaults = {
  schemaVersion: 'bayn.intraday-alpha-policy.v3',
  feed: 'alpaca-sip',
  barMinutes: 5,
  priorSessions: 14,
  equitySymbols,
  trendSymbols,
  benchmarkSymbol,
  entryLimitSlippageBps: 30,
  stopLimitSlippageBps: 50,
  stopLimitAtrMultiplier: 0.25,
  sharedGrossCapMicros: '180000000000',
  allocation: AlphaV3Allocation.OrbTilt,
  orb: {
    openingRangeMinutes: 5,
    entryEndMinuteFromOpen: 115,
    exitMinuteFromOpen: 118,
    closeBufferMinutes: 15,
    minimumRvol: 2.5,
    minimumGapAtr: 0.5,
    top: 1,
    rewardRiskMultiple: 2,
    riskBudgetMicros: '1000000000',
    perSymbolCapMicros: '60000000000',
  },
  reversion: {
    entryMinuteFromOpen: 150,
    minimumIqrBps: 100,
    pairs: 2,
    exit: AlphaV3NoonExit.Timed,
    stopBps: 500,
    targetBps: 800,
    closeBufferMinutes: 5,
    partialBasket: 'CANCEL_THEN_REDUCE_CONFIRMED_FILLS',
  },
  noise: {
    checkpointMinutes: 30,
    entryEndMinuteFromOpen: 330,
    entryCloseBufferMinutes: 30,
    closeBufferMinutes: 2,
    bandMultiplier: 1.2,
    exit: 'OPPOSITE_BAND',
    riskBudgetMicros: '1500000000',
    perSymbolCapMicros: '60000000000',
  },
} as const

export const IntradayAlphaV3PolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal(defaults.schemaVersion),
  feed: Schema.Literal(defaults.feed),
  barMinutes: Schema.Literal(defaults.barMinutes),
  priorSessions: Schema.Literal(defaults.priorSessions),
  equitySymbols: exactSymbols(equitySymbols),
  trendSymbols: exactSymbols(trendSymbols),
  benchmarkSymbol: Schema.Literal(defaults.benchmarkSymbol),
  entryLimitSlippageBps: Schema.Int.check(Schema.isBetween({ minimum: 25, maximum: 35 })),
  stopLimitSlippageBps: Schema.Literal(defaults.stopLimitSlippageBps),
  stopLimitAtrMultiplier: Schema.Literal(defaults.stopLimitAtrMultiplier),
  sharedGrossCapMicros: Schema.Literal(defaults.sharedGrossCapMicros),
  allocation: Schema.Enum(AlphaV3Allocation),
  orb: Schema.Struct({
    openingRangeMinutes: Schema.Literal(defaults.orb.openingRangeMinutes),
    entryEndMinuteFromOpen: Schema.Literal(defaults.orb.entryEndMinuteFromOpen),
    exitMinuteFromOpen: Schema.Literal(defaults.orb.exitMinuteFromOpen),
    closeBufferMinutes: Schema.Literal(defaults.orb.closeBufferMinutes),
    minimumRvol: Schema.Literal(defaults.orb.minimumRvol),
    minimumGapAtr: Schema.Literal(defaults.orb.minimumGapAtr),
    top: Schema.Literal(defaults.orb.top),
    rewardRiskMultiple: Schema.Literal(defaults.orb.rewardRiskMultiple),
    riskBudgetMicros: Schema.Literal(defaults.orb.riskBudgetMicros),
    perSymbolCapMicros: Schema.Literal(defaults.orb.perSymbolCapMicros),
  }),
  reversion: Schema.Struct({
    entryMinuteFromOpen: Schema.Literal(defaults.reversion.entryMinuteFromOpen),
    minimumIqrBps: Schema.Literal(defaults.reversion.minimumIqrBps),
    pairs: Schema.Literal(defaults.reversion.pairs),
    exit: Schema.Enum(AlphaV3NoonExit),
    stopBps: Schema.Literal(defaults.reversion.stopBps),
    targetBps: Schema.Literal(defaults.reversion.targetBps),
    closeBufferMinutes: Schema.Literal(defaults.reversion.closeBufferMinutes),
    partialBasket: Schema.Literal(defaults.reversion.partialBasket),
  }),
  noise: Schema.Struct({
    checkpointMinutes: Schema.Literal(defaults.noise.checkpointMinutes),
    entryEndMinuteFromOpen: Schema.Literal(defaults.noise.entryEndMinuteFromOpen),
    entryCloseBufferMinutes: Schema.Literal(defaults.noise.entryCloseBufferMinutes),
    closeBufferMinutes: Schema.Literal(defaults.noise.closeBufferMinutes),
    bandMultiplier: Schema.Literal(defaults.noise.bandMultiplier),
    exit: Schema.Literal(defaults.noise.exit),
    riskBudgetMicros: Schema.Literal(defaults.noise.riskBudgetMicros),
    perSymbolCapMicros: Schema.Literal(defaults.noise.perSymbolCapMicros),
  }),
})
export type IntradayAlphaV3Policy = typeof IntradayAlphaV3PolicySchema.Type

const freezePolicy = (policy: IntradayAlphaV3Policy): IntradayAlphaV3Policy =>
  Object.freeze({
    ...policy,
    equitySymbols,
    trendSymbols,
    orb: Object.freeze({ ...policy.orb }),
    reversion: Object.freeze({ ...policy.reversion }),
    noise: Object.freeze({ ...policy.noise }),
  })

export const defaultIntradayAlphaV3Policy = freezePolicy(defaults)

export const decodeIntradayAlphaV3Policy = (input: unknown) =>
  Schema.decodeUnknownResult(IntradayAlphaV3PolicySchema, strictParseOptions)(input).pipe(Result.map(freezePolicy))

export const intradayAlphaV3PolicyHash = (policy: IntradayAlphaV3Policy) => canonicalHashV1Result(policy)
