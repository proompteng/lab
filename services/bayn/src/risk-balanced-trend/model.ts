import type { Result, Schema } from 'effect'

import type { ExecutionSessionBinding } from '../execution-session'
import { renderSimulationFailure, type SimulationFailure, type SimulationResult } from '../simulation'
import { renderSimulationReconciliationIssue, type SimulationReconciliationIssue } from '../simulation-reconciliation'
import type { DecisionPlan, EvaluationResult, IsoDate, SignalDecision } from '../types'

export type RiskBalancedTrendDomainFailure =
  | {
      readonly _tag: 'InvalidRiskBalancedTrendNumber'
      readonly operation:
        | 'annualized-portfolio-volatility'
        | 'annualized-volatility'
        | 'composite-score'
        | 'covariance'
        | 'daily-return'
        | 'horizon-return'
        | 'normalized-trend'
        | 'portfolio-variance'
        | 'weight-allocation'
      readonly value: number
      readonly symbol: string | null
      readonly reason: 'negative' | 'not-finite'
    }
  | {
      readonly _tag: 'RiskBalancedTrendSessionHistoryMismatch'
      readonly signalDate: IsoDate
      readonly expectedCount: number
      readonly observedDates: readonly IsoDate[]
    }
  | {
      readonly _tag: 'RiskBalancedTrendUniverseMismatch'
      readonly expected: readonly string[]
      readonly observed: readonly string[]
    }
  | {
      readonly _tag: 'RiskBalancedTrendCloseHistoryMismatch'
      readonly symbol: string
      readonly expectedCount: number
      readonly observedCount: number
    }
  | {
      readonly _tag: 'InvalidRiskBalancedTrendClose'
      readonly symbol: string
      readonly index: number
      readonly value: number
    }
  | {
      readonly _tag: 'MissingRiskBalancedTrendClose'
      readonly symbol: string
      readonly horizonSessions: number | null
    }
  | {
      readonly _tag: 'CovarianceInputMismatch'
      readonly leftCount: number
      readonly rightCount: number
      readonly minimumCount: 2
    }
  | {
      readonly _tag: 'UnboundedRiskBalancedTrendWeights'
      readonly totalWeight: number
      readonly maximumSymbolWeight: number
      readonly maximumPortfolioVolatility: number
      readonly observedPortfolioVolatility: number
    }
  | {
      readonly _tag: 'SignalSessionMissing'
      readonly signalIndex: number
      readonly sessionCount: number
    }
  | {
      readonly _tag: 'CurrentDecisionBindingDecodeFailed'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'CurrentDecisionSessionMismatch'
      readonly manifestSession: IsoDate
      readonly snapshotSession: IsoDate
      readonly bindingSession: IsoDate
      readonly observedSession: IsoDate | null
    }
  | {
      readonly _tag: 'CurrentDecisionNotMonthEnd'
      readonly signalSession: IsoDate
      readonly executionSession: IsoDate
    }
  | {
      readonly _tag: 'CurrentDecisionCoverageMismatch'
      readonly signalDate: IsoDate
      readonly expectedSymbols: readonly string[]
      readonly observedSymbols: readonly string[]
    }
  | {
      readonly _tag: 'DecisionSchemaMismatch'
      readonly observed: string
      readonly expected: 'bayn.risk-balanced-trend-decision-plan.v1'
    }
  | {
      readonly _tag: 'ManifestDecodeFailed'
      readonly cause: Schema.SchemaError
    }
  | {
      readonly _tag: 'ManifestUniverseMismatch'
      readonly expectedId: string
      readonly observedId: string
      readonly expectedSymbolHash: string
      readonly observedSymbolHash: string
      readonly expectedSymbols: readonly string[]
      readonly observedSymbols: readonly string[]
    }
  | {
      readonly _tag: 'ManifestSnapshotBoundsMismatch'
      readonly manifestFirst: IsoDate
      readonly snapshotFirst: IsoDate
      readonly manifestLast: IsoDate
      readonly snapshotLast: IsoDate
      readonly manifestRows: number
      readonly snapshotRows: number
      readonly manifestSessions: number
      readonly snapshotSessions: number
    }

export type RiskBalancedTrendFailure = SimulationFailure | RiskBalancedTrendDomainFailure

export type RiskBalancedTrendEvaluationIssue = RiskBalancedTrendFailure | SimulationReconciliationIssue

const domainFailureTags = new Set<RiskBalancedTrendDomainFailure['_tag']>([
  'InvalidRiskBalancedTrendNumber',
  'RiskBalancedTrendSessionHistoryMismatch',
  'RiskBalancedTrendUniverseMismatch',
  'RiskBalancedTrendCloseHistoryMismatch',
  'InvalidRiskBalancedTrendClose',
  'MissingRiskBalancedTrendClose',
  'CovarianceInputMismatch',
  'UnboundedRiskBalancedTrendWeights',
  'SignalSessionMissing',
  'CurrentDecisionBindingDecodeFailed',
  'CurrentDecisionSessionMismatch',
  'CurrentDecisionNotMonthEnd',
  'CurrentDecisionCoverageMismatch',
  'DecisionSchemaMismatch',
  'ManifestDecodeFailed',
  'ManifestUniverseMismatch',
  'ManifestSnapshotBoundsMismatch',
])

const reconciliationFailureTags = new Set<SimulationReconciliationIssue['_tag']>([
  'InvalidInteger',
  'InvalidIdentity',
  'MissingReference',
  'EvidenceMismatch',
  'InvalidEvidenceState',
  'IncompleteEvidence',
  'ComputationFailed',
])

const isDomainFailure = (issue: RiskBalancedTrendEvaluationIssue): issue is RiskBalancedTrendDomainFailure =>
  domainFailureTags.has(issue._tag as RiskBalancedTrendDomainFailure['_tag'])

const isReconciliationFailure = (issue: RiskBalancedTrendEvaluationIssue): issue is SimulationReconciliationIssue =>
  reconciliationFailureTags.has(issue._tag as SimulationReconciliationIssue['_tag'])

const renderDomainFailure = (failure: RiskBalancedTrendDomainFailure): string => {
  switch (failure._tag) {
    case 'InvalidRiskBalancedTrendNumber':
      return `${failure.operation} produced ${failure.reason} value ${failure.value}${failure.symbol === null ? '' : ` for ${failure.symbol}`}`
    case 'RiskBalancedTrendSessionHistoryMismatch':
      return `risk-balanced trend requires ${failure.expectedCount} ordered sessions ending on ${failure.signalDate}`
    case 'RiskBalancedTrendUniverseMismatch':
      return `risk-balanced trend universe ${failure.observed.join(',')} does not match ${failure.expected.join(',')}`
    case 'RiskBalancedTrendCloseHistoryMismatch':
      return `risk-balanced trend requires ${failure.expectedCount} closes for ${failure.symbol}; observed ${failure.observedCount}`
    case 'InvalidRiskBalancedTrendClose':
      return `risk-balanced trend close ${failure.symbol}[${failure.index}] is invalid: ${failure.value}`
    case 'MissingRiskBalancedTrendClose':
      return `risk-balanced trend has no ${failure.horizonSessions === null ? 'current' : `${failure.horizonSessions}-session`} close for ${failure.symbol}`
    case 'CovarianceInputMismatch':
      return `covariance requires aligned inputs of at least ${failure.minimumCount}; observed ${failure.leftCount}/${failure.rightCount}`
    case 'UnboundedRiskBalancedTrendWeights':
      return `risk-balanced trend weights are outside limits: total=${failure.totalWeight}, symbol<=${failure.maximumSymbolWeight}, volatility=${failure.observedPortfolioVolatility}<=${failure.maximumPortfolioVolatility}`
    case 'SignalSessionMissing':
      return `risk-balanced trend signal index ${failure.signalIndex} is outside ${failure.sessionCount} sessions`
    case 'CurrentDecisionBindingDecodeFailed':
      return `current decision binding is invalid: ${failure.cause.message}`
    case 'CurrentDecisionSessionMismatch':
      return `current decision session ${failure.observedSession ?? 'missing'} does not match manifest/snapshot/binding ${failure.manifestSession}/${failure.snapshotSession}/${failure.bindingSession}`
    case 'CurrentDecisionNotMonthEnd':
      return `current decision signal ${failure.signalSession} and execution ${failure.executionSession} are in the same month`
    case 'CurrentDecisionCoverageMismatch':
      return `current decision covers ${failure.observedSymbols.join(',')}; expected ${failure.expectedSymbols.join(',')}`
    case 'DecisionSchemaMismatch':
      return `strategy decision schema ${failure.observed} does not match ${failure.expected}`
    case 'ManifestDecodeFailed':
      return `strategy manifest is invalid: ${failure.cause.message}`
    case 'ManifestUniverseMismatch':
      return `Signal universe ${failure.observedId}/${failure.observedSymbolHash}/${failure.observedSymbols.join(',')} does not match ${failure.expectedId}/${failure.expectedSymbolHash}/${failure.expectedSymbols.join(',')}`
    case 'ManifestSnapshotBoundsMismatch':
      return `Signal manifest bounds ${failure.manifestFirst}..${failure.manifestLast}/${failure.manifestRows}/${failure.manifestSessions} do not match snapshot ${failure.snapshotFirst}..${failure.snapshotLast}/${failure.snapshotRows}/${failure.snapshotSessions}`
  }
}

export const renderRiskBalancedTrendFailure = (failure: RiskBalancedTrendFailure): string =>
  isDomainFailure(failure) ? renderDomainFailure(failure) : renderSimulationFailure(failure)

export const renderRiskBalancedTrendEvaluationIssues = (issues: readonly RiskBalancedTrendEvaluationIssue[]): string =>
  issues
    .map((issue) =>
      isDomainFailure(issue)
        ? renderDomainFailure(issue)
        : isReconciliationFailure(issue)
          ? renderSimulationReconciliationIssue(issue)
          : renderSimulationFailure(issue),
    )
    .join('; ')

export interface CurrentRiskBalancedTrendDecision {
  readonly decision: DecisionPlan
  readonly priceMicros: Readonly<Record<string, string>>
}

export type CurrentDecisionCycleBinding = ExecutionSessionBinding

export interface QualificationPrecommit {
  readonly candidateRunId: string
  readonly protocolHash: string
  readonly selectedSessionCount: number
  readonly selectedRebalanceCount: number
  readonly signalDates: readonly IsoDate[]
  readonly executionDates: readonly IsoDate[]
}

export interface PreparedEvaluation {
  readonly runId: string
  readonly protocolHash: string
  readonly strategy: SimulationResult
  readonly buyAndHold: SimulationResult
  readonly directVolTiming: SimulationResult
  readonly doubleCost: SimulationResult
  readonly simulation: NonNullable<SimulationResult['simulation']>
  readonly signalDecisions: readonly SignalDecision[]
}

export type RiskBalancedTrendDecision = Result.Result<DecisionPlan, RiskBalancedTrendFailure>

export type CurrentRiskBalancedTrendDecisionResult = Result.Result<
  CurrentRiskBalancedTrendDecision,
  RiskBalancedTrendFailure
>

export type RiskBalancedTrendEvaluation = Result.Result<EvaluationResult, readonly RiskBalancedTrendEvaluationIssue[]>
