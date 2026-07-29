import { pipe, Result } from 'effect'

import type { RuntimeProvenance } from './contracts'
import {
  defaultQualificationStatisticsPolicyDocument,
  makeQualificationLock,
  makeQualificationPolicyDocument,
  type QualificationConstructionFailure,
  type QualificationLock,
} from './qualification'
import {
  analyzeQualification,
  defaultQualificationStatisticsPolicy,
  prepareQualificationSeries,
  type QualificationAnalysis,
  type QualificationStatisticsFailure,
} from './qualification-statistics'
import {
  compileCurrentRiskBalancedTrendDecision,
  evaluateRiskBalancedTrend,
  parseMatchingManifest,
  prepareRiskBalancedTrendQualification,
  type CurrentDecisionCycleBinding,
  type CurrentRiskBalancedTrendDecision,
  type RiskBalancedTrendEvaluationIssue,
  type RiskBalancedTrendFailure,
} from './risk-balanced-trend'
import type { DailyBar, EvaluationResult, InputManifest, IsoDate, Protocol } from './types'

export type CurrentStrategyDecision = CurrentRiskBalancedTrendDecision
export type CurrentStrategyDecisionCycleBinding = CurrentDecisionCycleBinding
export type CurrentStrategyDecisionFailure = RiskBalancedTrendFailure
export type StrategyPrepareLockFailure = RiskBalancedTrendFailure | QualificationConstructionFailure

export interface Strategy {
  readonly name: string
  readonly parameters: Protocol
  readonly provenance: RuntimeProvenance
  readonly evaluate: (
    bars: readonly DailyBar[],
    manifest: InputManifest,
  ) => Result.Result<EvaluationResult, readonly RiskBalancedTrendEvaluationIssue[]>
  readonly currentDecision: (
    bars: readonly DailyBar[],
    manifest: InputManifest,
    cycleBinding: CurrentStrategyDecisionCycleBinding,
  ) => Result.Result<CurrentStrategyDecision, CurrentStrategyDecisionFailure>
  readonly prepareLock: (
    manifest: InputManifest,
    sessionDates: readonly IsoDate[],
    priorTrialRunIds: readonly string[],
  ) => Result.Result<QualificationLock, StrategyPrepareLockFailure>
  readonly analyze: (
    evaluation: EvaluationResult,
    priorTrialRunIds: readonly string[],
  ) => Result.Result<QualificationAnalysis, QualificationStatisticsFailure>
}

const universeRationale =
  'The precommitted five-sleeve cross-asset universe uses broad commodities (DBC), developed ex-US equities (EFA), intermediate US Treasuries (IEF), US equities (SPY), and US real estate (VNQ); symbols were fixed without inspecting candidate prices or returns.'

export const makeStrategy = (protocol: Protocol, provenance: RuntimeProvenance): Strategy => {
  return {
    name: 'risk-balanced-trend',
    parameters: protocol,
    provenance,
    evaluate: (bars, manifest) =>
      pipe(
        parseMatchingManifest(manifest, protocol),
        Result.mapError((failure): readonly RiskBalancedTrendEvaluationIssue[] => [failure]),
        Result.flatMap((inputManifest) => evaluateRiskBalancedTrend(bars, inputManifest, protocol, provenance)),
      ),
    currentDecision: (bars, manifest, cycleBinding) =>
      pipe(
        parseMatchingManifest(manifest, protocol),
        Result.flatMap((inputManifest) =>
          compileCurrentRiskBalancedTrendDecision(bars, inputManifest, protocol, cycleBinding),
        ),
      ),
    prepareLock: (manifest, sessionDates, priorTrialRunIds) =>
      pipe(
        parseMatchingManifest(manifest, protocol),
        Result.flatMap((inputManifest) =>
          pipe(
            Result.all({
              precommit: prepareRiskBalancedTrendQualification(sessionDates, inputManifest, protocol, provenance),
              benchmarkPolicy: makeQualificationPolicyDocument('bayn.risk-balanced-trend-benchmark-policy.v1', {
                schemaVersion: 'bayn.risk-balanced-trend-benchmark-policy.v1',
                comparison: 'stronger-of-buy-and-hold-or-direct-volatility-timing',
                excessReturnBasis: 'after-cost-over-cash',
                sharpeBasis: 'daily-excess-over-cash',
                alignment: 'candidate-sessions-and-exposure-rules',
              }),
              thresholdPolicy: makeQualificationPolicyDocument('bayn.risk-balanced-trend-threshold-policy.v1', {
                schemaVersion: 'bayn.risk-balanced-trend-threshold-policy.v1',
                thresholds: protocol.thresholds,
              }),
              uncertaintyPolicy: defaultQualificationStatisticsPolicyDocument,
              executionPolicy: makeQualificationPolicyDocument(
                protocol.executionModel.schemaVersion,
                protocol.executionModel,
              ),
            }),
            Result.flatMap(({ benchmarkPolicy, executionPolicy, precommit, thresholdPolicy, uncertaintyPolicy }) => {
              const snapshot = inputManifest.finalizedSnapshot
              return makeQualificationLock({
                schemaVersion: 'bayn.qualification-lock.v3',
                candidateRunId: precommit.candidateRunId,
                protocolHash: precommit.protocolHash,
                sourceRevision: provenance.sourceRevision,
                image: provenance.image,
                universeId: protocol.universeId,
                universeSymbolHash: protocol.universeSymbolHash,
                universe: protocol.universe,
                universeRationale,
                data: {
                  snapshotId: snapshot.snapshotId,
                  publicationId: snapshot.publicationId,
                  inputManifestHash: inputManifest.hash,
                  contentHash: snapshot.contentHash,
                  sessionsContentHash: snapshot.sessionsContentHash,
                  provider: snapshot.source,
                  sourceFeed: snapshot.sourceFeed,
                  adjustment: snapshot.adjustment,
                  calendarVersion: snapshot.calendarVersion,
                  firstSession: snapshot.firstSession,
                  lastSession: snapshot.lastSession,
                  selectedSessionCount: precommit.selectedSessionCount,
                  selectedRebalanceCount: precommit.selectedRebalanceCount,
                  bounds: inputManifest.bounds,
                },
                policies: {
                  benchmark: benchmarkPolicy,
                  thresholds: thresholdPolicy,
                  uncertainty: uncertaintyPolicy,
                  execution: executionPolicy,
                },
                priorTrialRunIds,
              })
            }),
          ),
        ),
      ),
    analyze: (evaluation, priorTrialRunIds) =>
      pipe(
        prepareQualificationSeries(evaluation),
        Result.flatMap((series) =>
          analyzeQualification(series, defaultQualificationStatisticsPolicy, priorTrialRunIds),
        ),
      ),
  }
}

export * as monthEndLiquidityReversal from './month-end-liquidity-reversal'
