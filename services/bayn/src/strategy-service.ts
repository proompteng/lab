import { Context, Layer } from 'effect'

import type { RuntimeProvenance } from './contracts'
import {
  defaultQualificationStatisticsPolicyDocument,
  makeQualificationLock,
  makeQualificationPolicyDocument,
  type QualificationLock,
} from './qualification'
import {
  analyzeQualification,
  defaultQualificationStatisticsPolicy,
  prepareQualificationSeries,
  type QualificationAnalysis,
} from './qualification-statistics'
import { evaluateRiskBalancedTrend, prepareRiskBalancedTrendQualification } from './risk-balanced-trend'
import { evaluateTsmom, prepareTsmomQualification } from './strategy'
import type {
  DailyBar,
  EvaluationResult,
  InputManifest,
  IsoDate,
  RiskBalancedTrendProtocol,
  TsmomProtocol,
} from './types'

export interface StrategyService {
  readonly name: string
  readonly universe: readonly string[]
  readonly parameters: unknown
  readonly provenance: RuntimeProvenance
  readonly evaluate: (bars: readonly DailyBar[], manifest: InputManifest) => EvaluationResult
  readonly prepareLock: (
    manifest: InputManifest,
    sessionDates: readonly IsoDate[],
    priorTrialRunIds: readonly string[],
  ) => QualificationLock
  readonly analyze: (evaluation: EvaluationResult, priorTrialRunIds: readonly string[]) => QualificationAnalysis
}

export class Strategy extends Context.Service<Strategy, StrategyService>()('bayn/Strategy') {}

export const makeTsmomStrategy = (protocol: TsmomProtocol, provenance: RuntimeProvenance): StrategyService => {
  const benchmarkPolicy = makeQualificationPolicyDocument('bayn.tsmom-benchmark-policy.v1', {
    schemaVersion: 'bayn.tsmom-benchmark-policy.v1',
    comparison: 'stronger-of-buy-and-hold-or-direct-volatility-timing',
    excessReturnBasis: 'after-cost-over-cash',
    sharpeBasis: 'daily-excess-over-cash',
    alignment: 'candidate-sessions-and-exposure-rules',
  })
  const thresholdPolicy = makeQualificationPolicyDocument('bayn.tsmom-threshold-policy.v1', {
    schemaVersion: 'bayn.tsmom-threshold-policy.v1',
    thresholds: protocol.thresholds,
  })
  const executionPolicy = makeQualificationPolicyDocument(
    protocol.executionModel.schemaVersion,
    protocol.executionModel,
  )

  return {
    name: 'tsmom',
    universe: protocol.universe,
    parameters: protocol,
    provenance,
    evaluate: (bars, manifest) => evaluateTsmom(bars, manifest, protocol, provenance),
    prepareLock: (manifest, sessionDates, priorTrialRunIds) => {
      const precommit = prepareTsmomQualification(sessionDates, manifest, protocol, provenance)
      const snapshot = manifest.finalizedSnapshot
      return makeQualificationLock({
        schemaVersion: 'bayn.qualification-lock.v2',
        candidateRunId: precommit.candidateRunId,
        protocolHash: precommit.protocolHash,
        sourceRevision: provenance.sourceRevision,
        image: provenance.image,
        universe: protocol.universe,
        universeRationale:
          'Legacy TSMOM ETF universe with complete finalized SIP/all daily coverage; this qualification does not establish websocket execution coverage.',
        data: {
          snapshotId: snapshot.snapshotId,
          publicationId: snapshot.publicationId,
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
          bounds: manifest.bounds,
        },
        policies: {
          benchmark: benchmarkPolicy,
          thresholds: thresholdPolicy,
          uncertainty: defaultQualificationStatisticsPolicyDocument,
          execution: executionPolicy,
        },
        priorTrialRunIds,
      })
    },
    analyze: (evaluation, priorTrialRunIds) =>
      analyzeQualification(
        prepareQualificationSeries(evaluation),
        defaultQualificationStatisticsPolicy,
        priorTrialRunIds,
      ),
  }
}

export const TsmomStrategyLayer = (protocol: TsmomProtocol, provenance: RuntimeProvenance) =>
  Layer.succeed(Strategy, makeTsmomStrategy(protocol, provenance))

export const makeRiskBalancedTrendStrategy = (
  protocol: RiskBalancedTrendProtocol,
  provenance: RuntimeProvenance,
): StrategyService => {
  const benchmarkPolicy = makeQualificationPolicyDocument('bayn.risk-balanced-trend-benchmark-policy.v1', {
    schemaVersion: 'bayn.risk-balanced-trend-benchmark-policy.v1',
    comparison: 'stronger-of-buy-and-hold-or-direct-volatility-timing',
    excessReturnBasis: 'after-cost-over-cash',
    sharpeBasis: 'daily-excess-over-cash',
    alignment: 'candidate-sessions-and-exposure-rules',
  })
  const thresholdPolicy = makeQualificationPolicyDocument('bayn.risk-balanced-trend-threshold-policy.v1', {
    schemaVersion: 'bayn.risk-balanced-trend-threshold-policy.v1',
    thresholds: protocol.thresholds,
  })
  const executionPolicy = makeQualificationPolicyDocument(
    protocol.executionModel.schemaVersion,
    protocol.executionModel,
  )

  return {
    name: 'risk-balanced-trend',
    universe: protocol.universe,
    parameters: protocol,
    provenance,
    evaluate: (bars, manifest) => evaluateRiskBalancedTrend(bars, manifest, protocol, provenance),
    prepareLock: (manifest, sessionDates, priorTrialRunIds) => {
      const precommit = prepareRiskBalancedTrendQualification(sessionDates, manifest, protocol, provenance)
      const snapshot = manifest.finalizedSnapshot
      return makeQualificationLock({
        schemaVersion: 'bayn.qualification-lock.v2',
        candidateRunId: precommit.candidateRunId,
        protocolHash: precommit.protocolHash,
        sourceRevision: provenance.sourceRevision,
        image: provenance.image,
        universe: protocol.universe,
        universeRationale:
          'Precommitted comparison universe inherited from TSMOM; finalized SIP/all daily coverage is complete, but this lock does not claim universe optimization or websocket execution coverage.',
        data: {
          snapshotId: snapshot.snapshotId,
          publicationId: snapshot.publicationId,
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
          bounds: manifest.bounds,
        },
        policies: {
          benchmark: benchmarkPolicy,
          thresholds: thresholdPolicy,
          uncertainty: defaultQualificationStatisticsPolicyDocument,
          execution: executionPolicy,
        },
        priorTrialRunIds,
      })
    },
    analyze: (evaluation, priorTrialRunIds) =>
      analyzeQualification(
        prepareQualificationSeries(evaluation),
        defaultQualificationStatisticsPolicy,
        priorTrialRunIds,
      ),
  }
}
