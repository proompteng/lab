import { Effect, Schema } from 'effect'

import { operationalError, type OperationalError } from './errors'
import { defaultExecutionModel } from './execution-model'
import { canonicalHashV1, sha256 } from './hash'
import {
  IsoDateSchema,
  NonNegativeFiniteSchema as NonNegativeFinite,
  PositiveFiniteSchema as PositiveFinite,
  PositiveIntegerSchema as PositiveInteger,
  PositiveMicrosSchema as PositiveMicros,
  Sha256Schema,
  SymbolSchema as SymbolName,
  UnitIntervalSchema as UnitInterval,
  UnsignedMicrosSchema as UnsignedMicros,
  strictParseOptions as StrictParseOptions,
} from './schemas'

export const DIRECT_VOLATILITY_WINDOW = 63

const PositiveUnitInterval = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))
const BasisPoints = NonNegativeFinite.check(Schema.isLessThanOrEqualTo(10_000))
const PartsPerMillion = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))
const EconomicThresholdsSchema = Schema.Struct({
  minimumObservations: PositiveInteger,
  minimumAnnualizedReturn: Schema.Finite.check(Schema.isGreaterThan(-1)),
  minimumSharpeImprovement: Schema.Finite,
  maximumDrawdown: UnitInterval,
  maximumAnnualTurnover: PositiveFinite,
  requirePositiveDoubleCostReturn: Schema.Boolean,
})
export type EconomicThresholds = typeof EconomicThresholdsSchema.Type

export const ExecutionModelSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-model.v1'),
  venue: Schema.Literal('alpaca-paper'),
  assetClass: Schema.Literal('us-equity'),
  order: Schema.Struct({
    type: Schema.Literal('market'),
    timeInForce: Schema.Literal('day'),
    extendedHours: Schema.Literal(false),
    submitAfter: Schema.Literal('signal-session-close'),
    submitBefore: Schema.Literal('next-session-open'),
    priceReference: Schema.Literal('next-session-open'),
  }),
  precision: Schema.Struct({
    quantityIncrementMicros: PositiveMicros,
    priceIncrementMicros: PositiveMicros,
    minimumBuyNotionalMicros: PositiveMicros,
  }),
  priceImpact: Schema.Struct({
    halfSpreadBps: BasisPoints,
    slippageBps: BasisPoints,
  }),
  fees: Schema.Struct({
    scheduleVersion: Schema.Literal('alpaca-brokerage-2026-07-01'),
    commissionBps: BasisPoints,
    secSellBps: BasisPoints,
    tafSellPerShareMicros: UnsignedMicros,
    tafMaximumPerOrderMicros: PositiveMicros,
    catPerShareMicros: UnsignedMicros,
    aggregation: Schema.Literal('session-by-fee-type'),
    roundingIncrementMicros: PositiveMicros,
  }),
  cash: Schema.Struct({
    annualYieldBps: BasisPoints,
    dayCount: Schema.Literal('actual-365'),
    accrual: Schema.Literal('session-open'),
  }),
  partialFills: Schema.Struct({
    policy: Schema.Literal('deterministic-hash'),
    probabilityPpm: PartsPerMillion,
    filledFractionPpm: PartsPerMillion,
    remainder: Schema.Literal('cancel'),
  }),
  doubleCostMultiplier: Schema.Literal(2),
}).check(
  Schema.makeFilter((model: typeof ExecutionModelSchema.Type) => {
    const issues: Schema.FilterIssue[] = []
    if (model.partialFills.probabilityPpm > 0 && model.partialFills.filledFractionPpm === 0) {
      issues.push({
        path: ['partialFills', 'filledFractionPpm'],
        issue: 'must be positive when partial fills are enabled',
      })
    }
    if (model.partialFills.filledFractionPpm >= 1_000_000) {
      issues.push({ path: ['partialFills', 'filledFractionPpm'], issue: 'must describe a partial, not complete, fill' })
    }
    return issues
  }),
)
export type ExecutionModel = typeof ExecutionModelSchema.Type

const defaultEconomicThresholds = {
  minimumObservations: 504,
  minimumAnnualizedReturn: 0,
  minimumSharpeImprovement: 0,
  maximumDrawdown: 0.35,
  maximumAnnualTurnover: 12,
  requirePositiveDoubleCostReturn: true,
} as const

const universeContract = {
  id: 'cross-asset-taa-v1',
  symbolHash: 'c15a52d125073a20c3addee154974ef32b4ef009c40a46b05b54743f075c0fe8',
  symbols: ['DBC', 'EFA', 'IEF', 'SPY', 'VNQ'],
  historyStart: '2016-01-04',
  evaluationStart: '2017-01-03',
} as const

const ProtocolBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.risk-balanced-trend.protocol.v2'),
  universeId: Schema.Literal(universeContract.id),
  universeSymbolHash: Sha256Schema,
  universe: Schema.Array(SymbolName).check(Schema.isMinLength(1)),
  historyStart: IsoDateSchema,
  evaluationStart: IsoDateSchema,
  horizons: Schema.Array(PositiveInteger).check(Schema.isMinLength(1)),
  volatilityWindow: PositiveInteger,
  rebalance: Schema.Literal('month-end'),
  positionPolicy: Schema.Literal('long-or-cash'),
  maximumSymbolWeight: PositiveUnitInterval,
  maximumPortfolioVolatility: PositiveUnitInterval,
  directVolatilityTarget: PositiveUnitInterval,
  initialCapitalMicros: PositiveMicros,
  executionModel: ExecutionModelSchema,
  thresholds: EconomicThresholdsSchema,
})

export const ProtocolSchema = ProtocolBase.check(
  Schema.makeFilter((parameters: typeof ProtocolBase.Type) => {
    const issues: Schema.FilterIssue[] = []
    const sortedUniverse = [...new Set(parameters.universe)].sort()
    if (sortedUniverse.length !== parameters.universe.length) {
      issues.push({ path: ['universe'], issue: 'must not contain duplicate symbols' })
    } else if (sortedUniverse.some((symbol, index) => symbol !== parameters.universe[index])) {
      issues.push({ path: ['universe'], issue: 'must be sorted in canonical order' })
    }
    if (parameters.universeSymbolHash !== sha256(parameters.universe.join(','))) {
      issues.push({ path: ['universeSymbolHash'], issue: 'must match the canonical universe' })
    }
    if (
      parameters.universeSymbolHash !== universeContract.symbolHash ||
      parameters.universe.join(',') !== universeContract.symbols.join(',') ||
      parameters.historyStart !== universeContract.historyStart ||
      parameters.evaluationStart !== universeContract.evaluationStart
    ) {
      issues.push({ path: ['universeId'], issue: 'must identify its exact source-controlled universe contract' })
    }
    if (parameters.evaluationStart <= parameters.historyStart) {
      issues.push({ path: ['evaluationStart'], issue: 'must follow historyStart' })
    }
    for (let index = 1; index < parameters.horizons.length; index += 1) {
      if (parameters.horizons[index] <= parameters.horizons[index - 1]) {
        issues.push({ path: ['horizons', index], issue: 'must be unique and strictly increasing' })
        break
      }
    }
    if (parameters.volatilityWindow < 2) {
      issues.push({ path: ['volatilityWindow'], issue: 'must contain at least two returns for covariance' })
    }
    if (Math.max(parameters.volatilityWindow, ...parameters.horizons) < DIRECT_VOLATILITY_WINDOW) {
      issues.push({
        path: ['horizons'],
        issue: `must provide at least ${DIRECT_VOLATILITY_WINDOW} sessions for the direct-volatility benchmark`,
      })
    }
    return issues
  }),
)
export type Protocol = typeof ProtocolSchema.Type

export const defaultProtocolDocument = {
  schemaVersion: 'bayn.risk-balanced-trend.protocol.v2',
  universeId: universeContract.id,
  universeSymbolHash: universeContract.symbolHash,
  universe: universeContract.symbols,
  historyStart: universeContract.historyStart,
  evaluationStart: universeContract.evaluationStart,
  horizons: [21, 63, 126, 252],
  volatilityWindow: 63,
  rebalance: 'month-end',
  positionPolicy: 'long-or-cash',
  maximumSymbolWeight: 0.35,
  maximumPortfolioVolatility: 0.1,
  directVolatilityTarget: 0.1,
  initialCapitalMicros: '1000000000000',
  executionModel: defaultExecutionModel,
  thresholds: defaultEconomicThresholds,
} as const

export const loadProtocol = (input: unknown): Effect.Effect<Protocol, OperationalError> =>
  Schema.decodeUnknownEffect(
    ProtocolSchema,
    StrictParseOptions,
  )(input).pipe(
    Effect.mapError((cause) =>
      operationalError('strategy', 'parameters', 'invalid risk-balanced trend parameters', cause),
    ),
  )

export const loadDefaultProtocol = loadProtocol(defaultProtocolDocument)

export const hashParameters = (parameters: Protocol): string => canonicalHashV1(parameters)
