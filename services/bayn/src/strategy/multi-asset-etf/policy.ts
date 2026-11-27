import { Result, Schema, SchemaGetter } from 'effect'

import { canonicalHashV1Result } from '../../hash'
import { IsoDateSchema, Sha256Schema, strictParseOptions } from '../../schemas'

export const multiAssetEtfs = Object.freeze([
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

export type MultiAssetEtf = (typeof multiAssetEtfs)[number]
export const multiAssetEtfTradables = Object.freeze([...multiAssetEtfs, 'SGOV'] as const)
export type MultiAssetEtfTradable = (typeof multiAssetEtfTradables)[number]
export type EtfWeights = Readonly<Partial<Record<MultiAssetEtfTradable, number>>>

export const sleeveNames = Object.freeze(['trend', 'rotation', 'pension', 'turnOfMonth', 'pullback'] as const)
export type EtfSleeve = (typeof sleeveNames)[number]

// Keep Wave 3C's relative tie order among the shared symbols. Do not substitute for SMH or VNQ.
const trendSymbols = ['SPY', 'QQQ', 'EFA', 'EEM', 'TLT', 'IEF', 'HYG', 'LQD', 'GLD', 'SLV', 'DBC', 'USO'] as const
const riskOnSymbols = ['QQQ', 'XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI', 'XLP', 'XLE', 'XLU', 'XLRE', 'XLB'] as const
const riskOffSymbols = ['TLT', 'SHY', 'GLD'] as const
const pullbackSymbols = ['SPY', 'QQQ', 'IWM', 'XLK', 'XLF', 'XLV', 'XLY', 'XLI', 'XLE', 'GLD'] as const

const exactSymbols = (symbols: readonly MultiAssetEtf[]) =>
  Schema.Array(Schema.Literals(multiAssetEtfs)).check(
    Schema.makeFilter(
      (actual) => actual.length === symbols.length && actual.every((symbol, i) => symbol === symbols[i]),
      { expected: 'the frozen symbols in their registered order' },
    ),
  )

const weightUnits = (weight: number) => Math.round(weight * 10_000)
const Weight = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: 1 }),
  Schema.makeFilter((weight) => weightUnits(weight) / 10_000 === weight, {
    expected: 'a weight in whole basis points',
  }),
)

const SleeveSchema = Schema.Struct({
  trend: Schema.Struct({
    symbols: exactSymbols(trendSymbols),
    capitalWeight: Weight,
    momentumSessions: Schema.Literal(120),
    annualVolatility: Schema.Literal(0.1),
    targetBuffer: Schema.Literal(0.05),
  }),
  rotation: Schema.Struct({
    riskOnSymbols: exactSymbols(riskOnSymbols),
    riskOffSymbols: exactSymbols(riskOffSymbols),
    capitalWeight: Weight,
    momentumSessions: Schema.Literal(120),
    gateSymbol: Schema.Literal('HYG'),
    gateSmaSessions: Schema.Literal(50),
    picks: Schema.Literal(3),
  }),
  pension: Schema.Struct({
    capitalWeight: Weight,
    signalSessionsFromMonthEnd: Schema.Literal(-5),
    minimumSpread: Schema.Literal(0.02),
  }),
  turnOfMonth: Schema.Struct({
    capitalWeight: Weight,
    entrySessionsFromMonthEnd: Schema.Literal(-2),
    throughSessionOfNextMonth: Schema.Literal(4),
    annualVolatility: Schema.Literal(0.15),
  }),
  pullback: Schema.Struct({
    symbols: exactSymbols(pullbackSymbols),
    capitalWeight: Weight,
    trendSmaSessions: Schema.Literal(100),
    rsiSessions: Schema.Literal(2),
    entryBelowRsi: Schema.Literal(15),
    exitAboveRsi: Schema.Literal(70),
    maximumHeldSessions: Schema.Literal(7),
    maximumPositions: Schema.Literal(4),
    maximumWeightPerPosition: Schema.Literal(0.25),
    annualVolatilityPerPosition: Schema.Literal(0.05),
  }),
}).check(
  Schema.makeFilter(
    (sleeves) => sleeveNames.reduce((sum, name) => sum + weightUnits(sleeves[name].capitalWeight), 0) <= 10_000,
    {
      expected: 'sleeve capital weights with a sum no greater than one',
    },
  ),
)

const RiskSchema = Schema.Struct({
  maxGrossLeverage: Schema.Finite.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(1.8),
    Schema.makeFilter((weight) => weightUnits(weight) / 10_000 === weight),
  ),
  maxSingleSymbolWeight: Weight.check(Schema.isGreaterThan(0)),
  maxNetShortWeight: Weight,
  minRebalanceDriftBps: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })),
  entryLimitCollarBps: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
}).check(
  Schema.makeFilter(
    (risk) => risk.maxSingleSymbolWeight <= risk.maxGrossLeverage && risk.maxNetShortWeight <= risk.maxGrossLeverage,
    {
      expected: 'single-symbol and net-short caps no greater than the gross cap',
    },
  ),
)

const PolicyMaterialSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.multi-asset-etf-policy.v1'),
  universe: exactSymbols(multiAssetEtfs),
  historyStartSession: IsoDateSchema,
  refreshEverySessions: Schema.Literal(5),
  volatilityLookbackSessions: Schema.Literal(20),
  annualizationSessions: Schema.Literal(252),
  sleeveGrossCap: Schema.Literal(1.8),
  sleeves: SleeveSchema,
  idleCashSweep: Schema.Union([
    Schema.Struct({ enabled: Schema.Literal(false) }),
    Schema.Struct({ enabled: Schema.Literal(true), symbol: Schema.Literals(['SGOV', 'SHY']) }),
  ]),
  risk: RiskSchema,
})

const HashedPolicySchema = Schema.Struct({
  ...PolicyMaterialSchema.fields,
  policyHash: Sha256Schema,
})
  .check(
    Schema.makeFilter(
      ({ policyHash, ...material }) => {
        const hash = canonicalHashV1Result(material)
        return Result.isSuccess(hash) && hash.success === policyHash
      },
      { expected: 'a policyHash reproduced by the canonical policy material' },
    ),
  )
  .pipe(Schema.brand('MultiAssetEtfPolicy'))

export type MultiAssetEtfPolicy = typeof HashedPolicySchema.Type
export type MultiAssetEtfPolicyMaterial = typeof PolicyMaterialSchema.Type

const freezePolicy = (policy: MultiAssetEtfPolicy): MultiAssetEtfPolicy => {
  const { sleeves } = policy
  Object.freeze(policy.universe)
  Object.freeze(policy.risk)
  Object.freeze(policy.idleCashSweep)
  Object.freeze(sleeves.trend.symbols)
  Object.freeze(sleeves.rotation.riskOnSymbols)
  Object.freeze(sleeves.rotation.riskOffSymbols)
  Object.freeze(sleeves.pullback.symbols)
  for (const name of sleeveNames) Object.freeze(sleeves[name])
  Object.freeze(sleeves)
  return Object.freeze(policy)
}

// A declaration preserves the frozen value instead of cloning it through another Struct.
export const MultiAssetEtfPolicySchema = HashedPolicySchema.pipe(
  Schema.decodeTo(Schema.declare(Schema.is(HashedPolicySchema)), {
    decode: SchemaGetter.transform(freezePolicy),
    encode: SchemaGetter.passthrough(),
  }),
)

export const decodeMultiAssetEtfPolicy = Schema.decodeUnknownResult(MultiAssetEtfPolicySchema, strictParseOptions)

export const makeMultiAssetEtfPolicy = (input: MultiAssetEtfPolicyMaterial) =>
  Result.gen(function* () {
    const material = yield* Schema.decodeUnknownResult(PolicyMaterialSchema)(input, strictParseOptions)
    const policyHash = yield* canonicalHashV1Result(material)
    return yield* decodeMultiAssetEtfPolicy({ ...material, policyHash })
  })

export const defaultMultiAssetEtfPolicy = () =>
  makeMultiAssetEtfPolicy({
    schemaVersion: 'bayn.multi-asset-etf-policy.v1',
    universe: multiAssetEtfs,
    historyStartSession: '2016-01-04',
    refreshEverySessions: 5,
    volatilityLookbackSessions: 20,
    annualizationSessions: 252,
    sleeveGrossCap: 1.8,
    sleeves: {
      trend: {
        symbols: trendSymbols,
        capitalWeight: 0.2,
        momentumSessions: 120,
        annualVolatility: 0.1,
        targetBuffer: 0.05,
      },
      rotation: {
        riskOnSymbols,
        riskOffSymbols,
        capitalWeight: 0.2,
        momentumSessions: 120,
        gateSymbol: 'HYG',
        gateSmaSessions: 50,
        picks: 3,
      },
      pension: { capitalWeight: 0.2, signalSessionsFromMonthEnd: -5, minimumSpread: 0.02 },
      turnOfMonth: {
        capitalWeight: 0.2,
        entrySessionsFromMonthEnd: -2,
        throughSessionOfNextMonth: 4,
        annualVolatility: 0.15,
      },
      pullback: {
        symbols: pullbackSymbols,
        capitalWeight: 0.2,
        trendSmaSessions: 100,
        rsiSessions: 2,
        entryBelowRsi: 15,
        exitAboveRsi: 70,
        maximumHeldSessions: 7,
        maximumPositions: 4,
        maximumWeightPerPosition: 0.25,
        annualVolatilityPerPosition: 0.05,
      },
    },
    idleCashSweep: { enabled: false },
    risk: {
      maxGrossLeverage: 1.8,
      maxSingleSymbolWeight: 0.35,
      maxNetShortWeight: 0.2,
      minRebalanceDriftBps: 25,
      entryLimitCollarBps: 20,
    },
  })
