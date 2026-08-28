import type { RuntimeProvenance } from './contracts'
import { makeRiskBalancedTrendApplication } from './strategy/risk-balanced-trend'
import type { RiskBalancedTrendStrategyDefinition } from './strategy/risk-balanced-trend'
import {
  decodeDefaultOpeningDriveProtocol,
  makeOpeningDriveDefinition,
  openingDriveBehaviorHash,
  type OpeningDriveProtocol,
} from './strategy/opening-drive'
import type {
  ReviewedStrategySource,
  StrategyApplication,
  StrategyDefinition,
  StrategyDecisionFailure,
  TargetPortfolio,
} from './strategy/core'
import { Pipeable } from './pipeable'

export type {
  CompiledStrategyDecision,
  StrategyApplication,
  StrategyApplicationFailure,
  StrategyDecisionFailure,
  StrategyDefinition,
  ReviewedStrategySource,
  TargetPortfolio,
  VerifiedStrategyContext,
} from './strategy/core'
export {
  makeRiskBalancedTrendApplication,
  makeRiskBalancedTrendDefinition,
  riskBalancedTrendContextAtSignal,
} from './strategy/risk-balanced-trend'
export {
  decideOpeningDrive,
  decodeDefaultOpeningDriveProtocol,
  decodeOpeningDriveProtocol,
  defaultOpeningDriveProtocolHash,
  defaultOpeningDriveProtocolDocument,
  hashOpeningDriveProtocol,
  makeOpeningDriveDefinition,
  OpeningDriveFailure,
  OpeningDriveProtocolDecodeError,
  OpeningDriveProtocolSchema,
  type OpeningDriveFailureReason,
  type OpeningDriveMarketContext,
  type OpeningDriveProtocol,
  type OpeningDriveRejectionReason,
  type OpeningDriveSessionBinding,
  type OpeningDriveSignal,
  type OpeningDriveStrategyDefinition,
  type OpeningDriveTargetPortfolio,
} from './strategy/opening-drive'
export {
  decideIntradayMomentum,
  decodeDefaultIntradayMomentumProtocol,
  decodeIntradayMomentumProtocol,
  defaultIntradayMomentumProtocolDocument,
  hashIntradayMomentumProtocol,
  intradayMomentumBehaviorHash,
  intradayMomentumExecutionModel,
  IntradayMomentumFailure,
  IntradayMomentumProtocolDecodeError,
  IntradayMomentumProtocolSchema,
  makeIntradayMomentumDefinition,
  type IntradayMomentumFailureReason,
  type IntradayMomentumMarketContext,
  type IntradayMomentumProtocol,
  type IntradayMomentumRejectionReason,
  type IntradayMomentumSessionBinding,
  type IntradayMomentumSignal,
  type IntradayMomentumStrategyDefinition,
  type IntradayMomentumTargetPortfolio,
} from './strategy/intraday-momentum'

/** The application root composes exactly one reviewed strategy implementation. */
export const activeStrategyName = 'opening-drive-momentum' as const
export const activeStrategyBehaviorHash = openingDriveBehaviorHash
export const loadActiveStrategyProtocol = decodeDefaultOpeningDriveProtocol

export const makeActiveStrategyRuntime = (
  protocol: OpeningDriveProtocol,
  provenance: RuntimeProvenance,
): StrategyRuntime => ({
  definition: makeOpeningDriveDefinition(protocol),
  provenance,
})

/** Attach the reviewed module identity to the executable application exported by that module. */
const bindReviewedStrategySourceDataFirst = <
  TMarket,
  TFailure extends StrategyDecisionFailure,
  TTarget extends TargetPortfolio,
>(
  application: StrategyApplication<TMarket, TFailure, TTarget>,
  reviewedSource: ReviewedStrategySource,
): StrategyApplication<TMarket, TFailure, TTarget> => ({
  ...application,
  reviewedSource: Object.freeze({ ...reviewedSource }),
})

export const bindReviewedStrategySource = Pipeable.generic<
  <TMarket, TFailure extends StrategyDecisionFailure, TTarget extends TargetPortfolio>(
    reviewedSource: ReviewedStrategySource,
  ) => (
    application: StrategyApplication<TMarket, TFailure, TTarget>,
  ) => StrategyApplication<TMarket, TFailure, TTarget>,
  typeof bindReviewedStrategySourceDataFirst
>(2, bindReviewedStrategySourceDataFirst)
export type {
  RiskBalancedTrendMarketContext,
  RiskBalancedTrendStrategyApplication,
  RiskBalancedTrendStrategyDefinition,
  RiskBalancedTrendTargetPortfolio,
} from './strategy/risk-balanced-trend'

export interface StrategyRuntime {
  /** Canonical application used by all pure evaluation and runtime decision paths. */
  readonly application?: StrategyApplication<any, any, any>
  /** Compatibility projection for archived callers; it is the same definition instance as application.definition. */
  readonly definition: StrategyDefinition<any, any, any, any>
  readonly provenance: RuntimeProvenance
}

export type StrategyRuntimeInput =
  | StrategyRuntime
  | StrategyDefinition<any, StrategyDecisionFailure, TargetPortfolio, any>

export const strategyDefinition = (
  input: StrategyRuntimeInput,
): StrategyDefinition<any, StrategyDecisionFailure, TargetPortfolio, any> =>
  'definition' in input ? input.definition : input

/**
 * Compatibility resolution for archived daily test/runtime constructors. Intraday runtimes deliberately omit the
 * legacy application adapter and use their verified intraday decision boundary directly.
 */
export const strategyApplication = (input: StrategyRuntimeInput): StrategyApplication<any, any, any> => {
  if ('application' in input && input.application !== undefined) return input.application
  const definition = strategyDefinition(input)
  if (definition.name !== 'risk-balanced-trend' || definition.holdingPeriod !== 'MULTI_SESSION') {
    throw new Error(`strategy ${definition.name} has no legacy daily application adapter`)
  }
  return makeRiskBalancedTrendApplication(definition.parameters, definition as RiskBalancedTrendStrategyDefinition)
}
