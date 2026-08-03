import { pipe, Result } from 'effect'

import type { RuntimeProvenance } from '../../contracts'
import {
  defaultQualificationStatisticsPolicyDocument,
  makeQualificationLock,
  makeQualificationPolicyDocument,
  type QualificationConstructionFailure,
  type QualificationLock,
} from '../../qualification'
import {
  analyzeQualification,
  defaultQualificationStatisticsPolicy,
  prepareQualificationSeries,
  type QualificationAnalysis,
  type QualificationStatisticsFailure,
} from '../../qualification-statistics'
import { prepareRiskBalancedTrendQualification } from './qualification-precommit'
import type { RiskBalancedTrendFailure } from '../../risk-balanced-trend/model'
import type { EvaluationResult, InputManifest, IsoDate, Protocol } from '../../types'

export type RiskBalancedTrendStrategyPrepareLockFailure = RiskBalancedTrendFailure | QualificationConstructionFailure

export type RiskBalancedTrendQualificationFailure = QualificationConstructionFailure | QualificationStatisticsFailure

const universeRationale =
  'The precommitted five-sleeve cross-asset universe uses broad commodities (DBC), developed ex-US equities (EFA), intermediate US Treasuries (IEF), US equities (SPY), and US real estate (VNQ); symbols were fixed without inspecting candidate prices or returns.'

export const prepareRiskBalancedTrendQualificationLock = (
  manifest: InputManifest,
  sessionDates: readonly IsoDate[],
  priorTrialRunIds: readonly string[],
  protocol: Protocol,
  provenance: RuntimeProvenance,
): Result.Result<QualificationLock, RiskBalancedTrendStrategyPrepareLockFailure> =>
  pipe(
    Result.all({
      precommit: prepareRiskBalancedTrendQualification(sessionDates, manifest, protocol, provenance),
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
      executionPolicy: makeQualificationPolicyDocument(protocol.executionModel.schemaVersion, protocol.executionModel),
    }),
    Result.flatMap(({ benchmarkPolicy, executionPolicy, precommit, thresholdPolicy, uncertaintyPolicy }) => {
      const snapshot = manifest.finalizedSnapshot
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
          inputManifestHash: manifest.hash,
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
          uncertainty: uncertaintyPolicy,
          execution: executionPolicy,
        },
        priorTrialRunIds,
      })
    }),
  )

export const analyzeRiskBalancedTrendEvaluation = (
  evaluation: EvaluationResult,
  priorTrialRunIds: readonly string[],
): Result.Result<QualificationAnalysis, QualificationStatisticsFailure> =>
  pipe(
    prepareQualificationSeries(evaluation),
    Result.flatMap((series) => analyzeQualification(series, defaultQualificationStatisticsPolicy, priorTrialRunIds)),
  )
