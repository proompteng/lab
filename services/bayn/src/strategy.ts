import type { RuntimeProvenance } from './contracts'
import { riskBalancedTrendBehaviorHash } from './behavior'
import { makeRiskBalancedTrendApplication } from './strategy/risk-balanced-trend'
import type { RiskBalancedTrendStrategyDefinition } from './strategy/risk-balanced-trend'
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
  hashOpeningDriveQualificationPolicy,
  hashOpeningDriveReplayCostModel,
  makeOpeningDriveDefinition,
  openingDriveReplayCostModelDocument,
  OpeningDriveFailure,
  OpeningDriveQualificationFailure,
  OpeningDriveProtocolDecodeError,
  OpeningDriveProtocolSchema,
  qualifyOpeningDrive,
  replayOpeningDriveSession,
  defaultOpeningDriveQualificationPolicy,
  validateOpeningDriveQualificationPolicy,
  type OpeningDriveFailureReason,
  type OpeningDriveMarketContext,
  type OpeningDrivePortfolioReplay,
  type OpeningDriveProtocol,
  type OpeningDriveQualificationBinding,
  type OpeningDriveQualificationCalendar,
  type OpeningDriveQualificationFailureReason,
  type OpeningDriveQualificationGate,
  type OpeningDriveQualificationPolicy,
  type OpeningDriveQualificationReceipt,
  type OpeningDriveQualificationRun,
  type OpeningDriveRejectionReason,
  type OpeningDriveReplaySessionInput,
  type OpeningDriveSessionBinding,
  type OpeningDriveSessionReplay,
  type OpeningDriveSignal,
  type OpeningDriveStrategyDefinition,
  type OpeningDriveTargetPortfolio,
  type QualifyOpeningDriveInput,
} from './strategy/opening-drive'

/** The application root composes exactly one reviewed strategy implementation. */
export const makeActiveStrategyApplication = makeRiskBalancedTrendApplication
export const activeStrategyName = 'risk-balanced-trend' as const
export const activeStrategyBehaviorHash = riskBalancedTrendBehaviorHash

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
 * Compatibility resolution for archived test/runtime constructors. The application-plan root always supplies
 * `application`; the fallback only preserves old evidence fixtures while they migrate to the canonical boundary.
 */
export const strategyApplication = (input: StrategyRuntimeInput): StrategyApplication<any, any, any> => {
  if ('application' in input && input.application !== undefined) return input.application
  const definition = strategyDefinition(input)
  if (definition.name !== 'risk-balanced-trend' || definition.holdingPeriod !== 'MULTI_SESSION') {
    throw new Error(`strategy ${definition.name} has no legacy daily application adapter`)
  }
  return makeRiskBalancedTrendApplication(definition.parameters, definition as RiskBalancedTrendStrategyDefinition)
}
