import { Effect, Schema } from 'effect'

import { operationalError, type OperationalError } from './errors'
import { defaultExecutionModel } from './execution-model'
import { canonicalHashV1 } from './hash'
import { DIRECT_VOLATILITY_WINDOW, type RiskBalancedTrendProtocol, type TsmomProtocol } from './types'

const StrictParseOptions = { onExcessProperty: 'error' } as const
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0))
const UnitInterval = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))
const PositiveUnitInterval = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))
const SymbolName = Schema.String.check(Schema.isPattern(/^[A-Z][A-Z0-9.-]{0,15}$/))
const PositiveMicros = Schema.String.check(Schema.isPattern(/^[1-9][0-9]*$/))
const UnsignedMicros = Schema.String.check(Schema.isPattern(/^(?:0|[1-9][0-9]*)$/))
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

const TsmomProtocolBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.tsmom.protocol.v2'),
  universe: Schema.Array(SymbolName).check(Schema.isMinLength(1)),
  lookbacks: Schema.Array(PositiveInteger).check(Schema.isMinLength(1)),
  rebalance: Schema.Literal('month-end'),
  positionPolicy: Schema.Literal('long-or-cash'),
  directVolatilityTarget: PositiveUnitInterval,
  initialCapitalMicros: PositiveMicros,
  executionModel: ExecutionModelSchema,
  thresholds: EconomicThresholdsSchema,
})

export const TsmomProtocolSchema = TsmomProtocolBase.check(
  Schema.makeFilter((parameters: typeof TsmomProtocolBase.Type) => {
    const issues: Schema.FilterIssue[] = []
    const sortedUniverse = [...new Set(parameters.universe)].sort()
    if (sortedUniverse.length !== parameters.universe.length) {
      issues.push({ path: ['universe'], issue: 'must not contain duplicate symbols' })
    } else if (sortedUniverse.some((symbol, index) => symbol !== parameters.universe[index])) {
      issues.push({ path: ['universe'], issue: 'must be sorted in canonical order' })
    }
    for (let index = 1; index < parameters.lookbacks.length; index += 1) {
      if (parameters.lookbacks[index] <= parameters.lookbacks[index - 1]) {
        issues.push({ path: ['lookbacks', index], issue: 'must be unique and strictly increasing' })
        break
      }
    }
    return issues
  }),
)

const defaultEconomicThresholds = {
  minimumObservations: 504,
  minimumAnnualizedReturn: 0,
  minimumSharpeImprovement: 0,
  maximumDrawdown: 0.35,
  maximumAnnualTurnover: 12,
  requirePositiveDoubleCostReturn: true,
} as const

export const defaultProtocolDocument = {
  schemaVersion: 'bayn.tsmom.protocol.v2',
  universe: ['DBC', 'EEM', 'EFA', 'GLD', 'IEF', 'SPY', 'TLT', 'VNQ'],
  lookbacks: [21, 63, 126, 252],
  rebalance: 'month-end',
  positionPolicy: 'long-or-cash',
  directVolatilityTarget: 0.1,
  initialCapitalMicros: '1000000000000',
  executionModel: defaultExecutionModel,
  thresholds: defaultEconomicThresholds,
} as const

export const loadTsmomProtocol = (input: unknown): Effect.Effect<TsmomProtocol, OperationalError> =>
  Schema.decodeUnknownEffect(
    TsmomProtocolSchema,
    StrictParseOptions,
  )(input).pipe(
    Effect.mapError((cause) => operationalError('strategy', 'parameters', 'invalid TSMOM parameters', cause)),
  )

export const loadDefaultProtocol = loadTsmomProtocol(defaultProtocolDocument)

export const hashTsmomParameters = (parameters: TsmomProtocol): string => canonicalHashV1(parameters)

const RiskBalancedTrendProtocolBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.risk-balanced-trend.protocol.v1'),
  universe: Schema.Array(SymbolName).check(Schema.isMinLength(1)),
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

export const RiskBalancedTrendProtocolSchema = RiskBalancedTrendProtocolBase.check(
  Schema.makeFilter((parameters: typeof RiskBalancedTrendProtocolBase.Type) => {
    const issues: Schema.FilterIssue[] = []
    const sortedUniverse = [...new Set(parameters.universe)].sort()
    if (sortedUniverse.length !== parameters.universe.length) {
      issues.push({ path: ['universe'], issue: 'must not contain duplicate symbols' })
    } else if (sortedUniverse.some((symbol, index) => symbol !== parameters.universe[index])) {
      issues.push({ path: ['universe'], issue: 'must be sorted in canonical order' })
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

export const defaultRiskBalancedTrendProtocolDocument = {
  schemaVersion: 'bayn.risk-balanced-trend.protocol.v1',
  universe: ['DBC', 'EEM', 'EFA', 'GLD', 'IEF', 'SPY', 'TLT', 'VNQ'],
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

export const loadRiskBalancedTrendProtocol = (
  input: unknown,
): Effect.Effect<RiskBalancedTrendProtocol, OperationalError> =>
  Schema.decodeUnknownEffect(
    RiskBalancedTrendProtocolSchema,
    StrictParseOptions,
  )(input).pipe(
    Effect.mapError((cause) =>
      operationalError('strategy', 'parameters', 'invalid risk-balanced trend parameters', cause),
    ),
  )

export const loadDefaultRiskBalancedTrendProtocol = loadRiskBalancedTrendProtocol(
  defaultRiskBalancedTrendProtocolDocument,
)

export const hashRiskBalancedTrendParameters = (parameters: RiskBalancedTrendProtocol): string =>
  canonicalHashV1(parameters)
