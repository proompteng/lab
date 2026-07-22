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
import type { DailyBar, EvaluationResult, InputManifest, IsoDate, Protocol } from './types'

export interface StrategyService {
  readonly name: string
  readonly universe: readonly string[]
  readonly parameters: Protocol
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

const requireMatchingUniverse = (manifest: InputManifest, protocol: Protocol): InputManifest => {
  const snapshot = manifest.finalizedSnapshot
  if (
    snapshot.universeId !== protocol.universeId ||
    snapshot.universeSymbolHash !== protocol.universeSymbolHash ||
    snapshot.symbols.join(',') !== protocol.universe.join(',')
  ) {
    throw new TypeError('Signal snapshot universe does not match the compiled strategy universe')
  }
  return manifest
}

export const makeStrategy = (protocol: Protocol, provenance: RuntimeProvenance): StrategyService => {
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
    evaluate: (bars, manifest) =>
      evaluateRiskBalancedTrend(bars, requireMatchingUniverse(manifest, protocol), protocol, provenance),
    prepareLock: (manifest, sessionDates, priorTrialRunIds) => {
      const inputManifest = requireMatchingUniverse(manifest, protocol)
      const precommit = prepareRiskBalancedTrendQualification(sessionDates, inputManifest, protocol, provenance)
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
        universeRationale:
          'Bayn uses the exact source-controlled Signal universe identified by universe ID and symbol hash; it does not select or optimize symbols during evaluation.',
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

export const StrategyLayer = (protocol: Protocol, provenance: RuntimeProvenance) =>
  Layer.succeed(Strategy, makeStrategy(protocol, provenance))
