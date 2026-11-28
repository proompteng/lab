import { Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { IsoDateSchema, strictParseOptions, UnitIntervalSchema } from '../../schemas'
import { MacroRiskConfig, macroRiskRules } from '../macro-portfolio/risk'

// Reference: Wave 5D (#16376), ensemble/base/21/0.05. Array order also breaks ranking ties.
export const macroCanaryEtfs = Object.freeze([
  'SPY',
  'QQQ',
  'IWM',
  'DIA',
  'XLK',
  'XLF',
  'XLE',
  'XLV',
  'XLI',
  'XLP',
  'XLU',
  'XLY',
  'XLB',
  'XLC',
  'XLRE',
  'TLT',
  'IEF',
  'SHY',
  'HYG',
  'LQD',
  'GLD',
  'SLV',
  'DBC',
  'USO',
  'UUP',
  'EFA',
  'EEM',
] as const)
export type MacroCanaryEtf = (typeof macroCanaryEtfs)[number]
export const MacroCanaryEtfSchema = Schema.Literals(macroCanaryEtfs)

const fixedBasket = (symbols: readonly MacroCanaryEtf[]) =>
  Schema.Array(MacroCanaryEtfSchema).check(
    Schema.makeFilter((value) => value.length === symbols.length && value.every((symbol, i) => symbol === symbols[i]), {
      expected: symbols.join(','),
    }),
  )

const roles = {
  canaryAssets: ['EEM', 'HYG', 'IEF', 'TLT'],
  offensiveAssets: ['SPY', 'QQQ', 'IWM', 'EFA', 'EEM', 'GLD', 'DBC', 'XLK', 'XLE', 'XLF', 'XLV'],
  defensiveSafeHavens: ['SHY', 'IEF', 'TLT', 'GLD', 'UUP', 'DBC'],
  creditPair: ['HYG', 'IEF'],
  inflationPairs: [
    ['GLD', 'TLT'],
    ['DBC', 'IEF'],
  ],
  dollarProxy: 'UUP',
  cashProxy: 'SHY',
} as const
const trendSleeves = [
  ['SPY', 'QQQ', 'EFA', 'EEM'],
  ['TLT', 'IEF'],
  ['HYG', 'LQD'],
  ['GLD', 'SLV', 'DBC'],
  ['UUP'],
] as const
const regimeBaskets = {
  Goldilocks: ['QQQ', 'SPY', 'XLK', 'IEF'],
  Reflation: ['XLE', 'DBC', 'GLD', 'XLI', 'SPY'],
  Stagflation: ['UUP', 'GLD', 'DBC', 'SHY'],
  DeflationaryCrash: ['TLT', 'IEF', 'GLD', 'SHY'],
} as const

const settings = {
  schemaVersion: 'bayn.macro-canary-etf-policy.v1',
  historyStartSession: '2018-06-19',
  universe: macroCanaryEtfs,
  ...roles,
  features: {
    horizons: [21, 63, 126, 252],
    annualSessions: 252,
    riskWindow: 63,
    volFloor: 0.04,
  },
  canary: { momentumCoefficients: [12, 4, 2, 1], cadence: 21, offensiveCount: 3, defensiveCount: 2 },
  trend: { sleeves: trendSleeves, targetVolatility: 0.08, maxGross: 1, minVolatility: 1e-12 },
  macro: { lookback: 63, emaSpan: 5, strongDollarRiskOnBudget: 0.75, strongDollarHedgeWeight: 2, regimeBaskets },
  ensemble: {
    reviewCadence: 21,
    relativeRiskBudgets: [1, 1, 1],
    offDiagonalScale: 0.75,
    diagonalVolFloor: 0.02,
    minActiveGross: 1e-10,
    riskParityPasses: 32,
    researchDriftBps: 500,
  },
  execution: { minDriftBps: 1000, limitCollarBps: 15, annualOneWayTurnoverBps: 60_000 },
} as const

const positiveUnit = UnitIntervalSchema.check(Schema.isGreaterThan(0))

export const MacroCanaryEtfPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal(settings.schemaVersion),
  historyStartSession: IsoDateSchema,
  universe: fixedBasket(settings.universe),
  canaryAssets: fixedBasket(roles.canaryAssets),
  offensiveAssets: fixedBasket(roles.offensiveAssets),
  defensiveSafeHavens: fixedBasket(roles.defensiveSafeHavens),
  creditPair: Schema.Tuple([Schema.Literal(roles.creditPair[0]), Schema.Literal(roles.creditPair[1])]),
  inflationPairs: Schema.Tuple([
    Schema.Tuple([Schema.Literal(roles.inflationPairs[0][0]), Schema.Literal(roles.inflationPairs[0][1])]),
    Schema.Tuple([Schema.Literal(roles.inflationPairs[1][0]), Schema.Literal(roles.inflationPairs[1][1])]),
  ]),
  dollarProxy: Schema.Literal(roles.dollarProxy),
  cashProxy: Schema.Literal(roles.cashProxy),
  features: Schema.Struct({
    horizons: Schema.Tuple([
      Schema.Literal(settings.features.horizons[0]),
      Schema.Literal(settings.features.horizons[1]),
      Schema.Literal(settings.features.horizons[2]),
      Schema.Literal(settings.features.horizons[3]),
    ]),
    annualSessions: Schema.Literal(settings.features.annualSessions),
    riskWindow: Schema.Literal(settings.features.riskWindow),
    volFloor: Schema.Literal(settings.features.volFloor),
  }),
  canary: Schema.Struct({
    momentumCoefficients: Schema.Tuple([
      Schema.Literal(settings.canary.momentumCoefficients[0]),
      Schema.Literal(settings.canary.momentumCoefficients[1]),
      Schema.Literal(settings.canary.momentumCoefficients[2]),
      Schema.Literal(settings.canary.momentumCoefficients[3]),
    ]),
    cadence: Schema.Literal(settings.canary.cadence),
    offensiveCount: Schema.Literal(settings.canary.offensiveCount),
    defensiveCount: Schema.Literal(settings.canary.defensiveCount),
  }),
  trend: Schema.Struct({
    sleeves: Schema.Tuple([
      fixedBasket(trendSleeves[0]),
      fixedBasket(trendSleeves[1]),
      fixedBasket(trendSleeves[2]),
      fixedBasket(trendSleeves[3]),
      fixedBasket(trendSleeves[4]),
    ]),
    targetVolatility: Schema.Literal(settings.trend.targetVolatility),
    maxGross: Schema.Literal(settings.trend.maxGross),
    minVolatility: Schema.Literal(settings.trend.minVolatility),
    book: Schema.Union([
      Schema.Struct({ kind: Schema.Literal('longOnly') }),
      Schema.Struct({ kind: Schema.Literal('signed'), maxShortGrossWeight: positiveUnit }),
    ]),
  }),
  macro: Schema.Struct({
    lookback: Schema.Literal(settings.macro.lookback),
    emaSpan: Schema.Literal(settings.macro.emaSpan),
    strongDollarRiskOnBudget: Schema.Literal(settings.macro.strongDollarRiskOnBudget),
    strongDollarHedgeWeight: Schema.Literal(settings.macro.strongDollarHedgeWeight),
    regimeBaskets: Schema.Struct({
      Goldilocks: fixedBasket(regimeBaskets.Goldilocks),
      Reflation: fixedBasket(regimeBaskets.Reflation),
      Stagflation: fixedBasket(regimeBaskets.Stagflation),
      DeflationaryCrash: fixedBasket(regimeBaskets.DeflationaryCrash),
    }),
  }),
  ensemble: Schema.Struct({
    reviewCadence: Schema.Literal(settings.ensemble.reviewCadence),
    relativeRiskBudgets: Schema.Tuple([
      Schema.Literal(settings.ensemble.relativeRiskBudgets[0]),
      Schema.Literal(settings.ensemble.relativeRiskBudgets[1]),
      Schema.Literal(settings.ensemble.relativeRiskBudgets[2]),
    ]),
    offDiagonalScale: Schema.Literal(settings.ensemble.offDiagonalScale),
    diagonalVolFloor: Schema.Literal(settings.ensemble.diagonalVolFloor),
    minActiveGross: Schema.Literal(settings.ensemble.minActiveGross),
    riskParityPasses: Schema.Literal(settings.ensemble.riskParityPasses),
    researchDriftBps: Schema.Literal(settings.ensemble.researchDriftBps),
  }),
  execution: Schema.Struct({
    minDriftBps: Schema.Literal(settings.execution.minDriftBps),
    limitCollarBps: Schema.Literal(settings.execution.limitCollarBps),
    annualOneWayTurnoverBps: Schema.Literal(settings.execution.annualOneWayTurnoverBps),
    maxGrossLeverage: positiveUnit,
    maxEtfWeight: positiveUnit,
  }),
}).check(
  Schema.makeFilter((policy) => {
    const { maxGrossLeverage, maxEtfWeight } = policy.execution
    if (maxEtfWeight > maxGrossLeverage)
      return { path: ['execution', 'maxEtfWeight'], issue: 'cannot exceed the gross leverage cap' }
    if (policy.trend.book.kind === 'signed' && policy.trend.book.maxShortGrossWeight > maxGrossLeverage)
      return { path: ['trend', 'book', 'maxShortGrossWeight'], issue: 'cannot exceed the gross leverage cap' }
    return undefined
  }),
)

export type MacroCanaryEtfPolicy = typeof MacroCanaryEtfPolicySchema.Type

export interface MacroCanaryEtfPolicyReceipt {
  readonly policy: MacroCanaryEtfPolicy
  readonly policyHash: string
}

const freezeTree = (value: unknown): void => {
  if (value === null || typeof value !== 'object') return
  for (const child of Object.values(value)) freezeTree(child)
  Object.freeze(value)
}

export const decodeMacroCanaryEtfPolicy = (value: unknown) =>
  Result.gen(function* () {
    const policy = yield* Schema.decodeUnknownResult(MacroCanaryEtfPolicySchema, strictParseOptions)(value)
    const policyHash = yield* canonicalHashV1Result(policy)
    freezeTree(policy)
    return Object.freeze({ policy, policyHash }) satisfies MacroCanaryEtfPolicyReceipt
  })

export const defaultMacroCanaryEtfPolicy = Result.getOrThrow(
  decodeMacroCanaryEtfPolicy({
    ...settings,
    trend: { ...settings.trend, book: { kind: 'longOnly' } },
    execution: { ...settings.execution, maxGrossLeverage: 1, maxEtfWeight: 0.5 },
  }),
)

export const canaryPolicyV2 = 'bayn.macro-canary-etf-policy.v2'
export const crossAssetV2 = Object.freeze({
  equity: Object.freeze(['SPY', 'QQQ', 'IWM'] as const),
  duration: Object.freeze(['TLT', 'IEF'] as const),
  realAssets: Object.freeze(['GLD', 'DBC'] as const),
  dollar: 'UUP',
  credit: 'HYG',
  carry: 'SHY',
  horizons: Object.freeze([21, 63, 126] as const),
  horizonWeights: Object.freeze([4, 2, 1] as const),
  cadence: 10,
  equityBudget: 0.15,
  durationBudget: 0.3,
  realAssetBudget: 0.35,
  dollarBudget: 0.15,
  creditBudget: 0.05,
  rateShockRealAssetTilt: 0.2,
  creditStress: -0.02,
  durationShock: -0.04,
  flightToSafety: 0.04,
  minDriftBps: 500,
  maxEtfWeight: 0.5,
})

export const crossAssetEtfs = Object.freeze([
  ...crossAssetV2.equity,
  ...crossAssetV2.duration,
  ...crossAssetV2.realAssets,
  crossAssetV2.dollar,
  crossAssetV2.credit,
  crossAssetV2.carry,
])
export type CrossAssetEtf = (typeof crossAssetEtfs)[number]

const PolicyV2 = Schema.Struct({
  schemaVersion: Schema.Literal(canaryPolicyV2),
  risk: MacroRiskConfig,
})

export const decodeMacroCanaryEtfPolicyV2 = (input: unknown) =>
  Result.gen(function* () {
    const decoded = yield* Schema.decodeUnknownResult(PolicyV2, strictParseOptions)(input)
    const policy = {
      ...decoded,
      universe: crossAssetEtfs,
      settings: crossAssetV2,
      governor: macroRiskRules,
    }
    const policyHash = yield* canonicalHashV1Result(policy)
    freezeTree(policy)
    return Object.freeze({ policy, policyHash })
  })
