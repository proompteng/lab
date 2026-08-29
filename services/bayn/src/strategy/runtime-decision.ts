import { Schema } from 'effect'

import {
  IsoDateSchema,
  PositiveIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnitIntervalSchema,
  UtcInstantSchema,
  UtcOrderTimestampSchema,
  UnsignedMicrosSchema,
} from '../schemas'
import { IntradayMomentumTargetPortfolioSchema } from './intraday-momentum/model'

const LegacyRiskBalancedHorizonSchema = Schema.Struct({
  horizonSessions: PositiveIntegerSchema,
  return: Schema.Finite,
  normalizedTrend: Schema.Finite,
})

const LegacyRiskBalancedSignalSchema = Schema.Struct({
  symbol: SymbolSchema,
  horizons: Schema.Array(LegacyRiskBalancedHorizonSchema).check(Schema.isMinLength(1)),
  dailyVolatility: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  annualizedVolatility: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  compositeScore: Schema.Finite,
  positiveScore: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  eligible: Schema.Boolean,
  uncappedWeight: UnitIntervalSchema,
  cappedWeight: UnitIntervalSchema,
  targetWeight: UnitIntervalSchema,
})

const LegacyRiskBalancedDecisionPlanSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.risk-balanced-trend-decision-plan.v1'),
  signalDate: IsoDateSchema,
  covarianceWindow: Schema.Struct({
    returnCount: PositiveIntegerSchema,
    firstSession: IsoDateSchema,
    lastSession: IsoDateSchema,
    sessionsHash: Sha256Schema,
  }),
  estimatedAnnualizedPortfolioVolatility: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  exposureScale: UnitIntervalSchema,
  targetWeights: Schema.Record(SymbolSchema, UnitIntervalSchema),
  signals: Schema.Array(LegacyRiskBalancedSignalSchema).check(Schema.isMinLength(1)),
})

const LegacyOpeningDriveSignalSchema = Schema.Struct({
  symbol: SymbolSchema,
  openingPriceMicros: PositiveMicrosSchema,
  rangeHighPriceMicros: PositiveMicrosSchema,
  rangeLowPriceMicros: PositiveMicrosSchema,
  bidPriceMicros: PositiveMicrosSchema,
  askPriceMicros: PositiveMicrosSchema,
  quoteObservedAt: UtcInstantSchema,
  breakoutTradePriceMicros: PositiveMicrosSchema,
  breakoutTradeObservedAt: UtcInstantSchema,
  openingReturnBps: Schema.Int,
  breakoutBps: Schema.Int,
  rangeLocationPpm: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  spreadBps: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20_000 })),
  openingDollarVolumeMicros: UnsignedMicrosSchema,
  eligible: Schema.Boolean,
  rejectionReasons: Schema.Array(
    Schema.Literals([
      'opening-return',
      'breakout',
      'range-location',
      'spread',
      'dollar-volume',
      'displayed-liquidity',
      'market-data-freshness',
    ]),
  ).check(Schema.isUnique()),
  rank: Schema.NullOr(PositiveIntegerSchema),
})

const LegacyOpeningDriveTargetPortfolioSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.opening-drive.target.v1'),
  strategy: Schema.Literal('opening-drive-momentum'),
  sessionDate: IsoDateSchema,
  snapshotId: Sha256Schema,
  observedAt: UtcInstantSchema,
  calendarHash: Sha256Schema,
  selectedSymbols: Schema.Array(SymbolSchema).check(Schema.isUnique()),
  targetWeights: Schema.Record(SymbolSchema, UnitIntervalSchema),
  signals: Schema.Array(LegacyOpeningDriveSignalSchema).check(Schema.isMinLength(1)),
})

const LegacyIntradaySignalSchema = Schema.Struct({
  symbol: SymbolSchema,
  referencePriceMicros: PositiveMicrosSchema,
  rangeHighPriceMicros: PositiveMicrosSchema,
  rangeLowPriceMicros: PositiveMicrosSchema,
  bidPriceMicros: PositiveMicrosSchema,
  askPriceMicros: PositiveMicrosSchema,
  bidSizeMicros: UnsignedMicrosSchema,
  askSizeMicros: UnsignedMicrosSchema,
  quoteObservedAt: Schema.Union([UtcInstantSchema, UtcOrderTimestampSchema]),
  confirmationTradePriceMicros: PositiveMicrosSchema,
  confirmationTradeObservedAt: Schema.Union([UtcInstantSchema, UtcOrderTimestampSchema]),
  lookbackReturnBps: Schema.Int,
  breakoutBps: Schema.Int,
  rangeLocationPpm: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 })),
  spreadBps: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 20_000 })),
  eligible: Schema.Boolean,
  rejectionReasons: Schema.Array(
    Schema.Literals([
      'lookback-return',
      'breakout',
      'range-location',
      'spread',
      'displayed-liquidity',
      'market-data-freshness',
    ]),
  ).check(Schema.isUnique()),
  rank: Schema.NullOr(PositiveIntegerSchema),
})

const LegacyIntradayTargetPortfolioSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-momentum.target.v1'),
  strategy: Schema.Literal('intraday-momentum'),
  sessionDate: IsoDateSchema,
  snapshotId: Sha256Schema,
  observedAt: UtcInstantSchema,
  calendarHash: Sha256Schema,
  selectedSymbols: Schema.Array(SymbolSchema).check(Schema.isUnique()),
  targetWeights: Schema.Record(SymbolSchema, UnitIntervalSchema),
  signals: Schema.Array(LegacyIntradaySignalSchema).check(Schema.isMinLength(1)),
})

const FlatExecutionTargetBase = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.execution-flat-target.v1'),
  strategyName: StrictNonEmptyStringSchema,
  sessionDate: IsoDateSchema,
  targetWeights: Schema.Record(SymbolSchema, Schema.Literal(0)),
  symbols: Schema.Array(SymbolSchema).check(Schema.isUnique()),
  reason: Schema.Literal('mandate-close'),
})

export const FlatExecutionTargetSchema = FlatExecutionTargetBase.check(
  Schema.makeFilter((target) => {
    const weightSymbols = Object.keys(target.targetWeights).sort()
    const declaredSymbols = [...target.symbols].sort()
    return weightSymbols.length === declaredSymbols.length &&
      weightSymbols.every((symbol, index) => symbol === declaredSymbols[index])
      ? []
      : [{ path: ['targetWeights'], issue: 'keys must exactly match the declared close symbols' }]
  }),
)

export const RuntimeStrategyDecisionSchema = Schema.Union([
  IntradayMomentumTargetPortfolioSchema,
  FlatExecutionTargetSchema,
])

export type RuntimeStrategyDecision = typeof RuntimeStrategyDecisionSchema.Type

/** Decoder-only compatibility for immutable decision rows. Active planning accepts RuntimeStrategyDecisionSchema only. */
export const PersistedStrategyDecisionSchema = Schema.Union([
  LegacyRiskBalancedDecisionPlanSchema,
  LegacyOpeningDriveTargetPortfolioSchema,
  LegacyIntradayTargetPortfolioSchema,
  RuntimeStrategyDecisionSchema,
])

export const runtimeDecisionMatchesStrategy = (decision: RuntimeStrategyDecision, strategyName: string): boolean => {
  switch (decision.schemaVersion) {
    case 'bayn.intraday-momentum.target.v2':
      return strategyName === 'intraday-momentum'
    case 'bayn.execution-flat-target.v1':
      return decision.strategyName === strategyName
  }
}

export const runtimeDecisionSessionDate = (decision: RuntimeStrategyDecision): string => decision.sessionDate
