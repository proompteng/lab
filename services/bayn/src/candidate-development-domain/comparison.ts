import { Result } from 'effect'

import { canonicalHashV1Result, type CanonicalHashFailure } from '../hash'
import {
  analyzeSelectedBenchmarkComparisonInput,
  type QualificationSelectedBenchmarkComparisonAnalysis,
  type QualificationSeries,
  type QualificationStatisticsFailure,
} from '../qualification-statistics'
import type { IsoDate } from '../schemas'
import type { EvaluationResult } from '../types'
import { candidateDevelopmentComparisonSemantics } from './protocol'
import type { CandidateDevelopmentPreflightPass } from './preflight'
import type { CandidateDevelopmentRebalanceBoundary } from './calendar'

type CandidateDevelopmentComparisonGateKey = keyof typeof candidateDevelopmentComparisonSemantics.gates

export interface CandidateDevelopmentComparisonSemanticsEvidence {
  readonly schemaVersion: typeof candidateDevelopmentComparisonSemantics.evidence.schemaVersion
  readonly candidateDevelopmentProtocolHash: string
  readonly strategyProtocolHash: string
  readonly comparisonSemantics: typeof candidateDevelopmentComparisonSemantics
  readonly analysis: QualificationSelectedBenchmarkComparisonAnalysis
}

export type CandidateDevelopmentComparisonSemanticsIssue =
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSemanticsShapeInvalid'
      readonly path: string
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSemanticsSchemaMismatch'
      readonly expected: CandidateDevelopmentComparisonSemanticsEvidence['schemaVersion']
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonDevelopmentProtocolMismatch'
      readonly expected: string
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonStrategyProtocolMismatch'
      readonly expected: string
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonAnalysisFailed'
      readonly cause: QualificationStatisticsFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSeriesProjectionFailed'
      readonly cause: QualificationStatisticsFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentBaselineStrategyProtocolMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSeriesRunMismatch'
      readonly expected: string
      readonly observed: string
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSeriesWindowMismatch'
      readonly index: number
      readonly expected: IsoDate | undefined
      readonly observed: IsoDate | undefined
      readonly expectedCount: number
      readonly observedCount: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonRebalanceScheduleMismatch'
      readonly index: number
      readonly expected: IsoDate | undefined
      readonly observed: IsoDate | undefined
      readonly expectedCount: number
      readonly observedCount: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSignalExecutionMismatch'
      readonly index: number
      readonly expected: CandidateDevelopmentRebalanceBoundary | undefined
      readonly observed: CandidateDevelopmentRebalanceBoundary | undefined
      readonly expectedCount: number
      readonly observedCount: number
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonAnalysisSchemaMismatch'
      readonly expected: typeof candidateDevelopmentComparisonSemantics.evidence.analysisSchemaVersion
      readonly observed: string
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonSemanticsHashFailed'
      readonly material: 'expected-evidence' | 'observed-evidence'
      readonly cause: CanonicalHashFailure
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonBaselineMismatch'
      readonly gate: CandidateDevelopmentComparisonGateKey
      readonly expected: string
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentAnnualizedReturnComparisonMismatch'
      readonly expected: number
      readonly observed: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentSelectedBenchmarkComparisonMismatch'
      readonly expected: string
      readonly observedBootstrap: unknown
      readonly observedWalkForward: unknown
    }
  | {
      readonly _tag: 'CandidateDevelopmentComparisonEvidenceMismatch'
      readonly expectedHash: string
      readonly observedHash: string
    }

const comparisonEvidenceRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const firstSequenceMismatch = <A>(
  expected: readonly A[],
  observed: readonly A[],
  same: (left: A | undefined, right: A | undefined) => boolean,
): { readonly index: number; readonly expected: A | undefined; readonly observed: A | undefined } | undefined => {
  const index = Array.from({ length: Math.max(expected.length, observed.length) }, (_, value) => value).find(
    (value) => !same(expected.at(value), observed.at(value)),
  )
  return index === undefined ? undefined : { index, expected: expected.at(index), observed: observed.at(index) }
}

export const validateCandidateDevelopmentComparisonSeriesBinding = (
  preflight: CandidateDevelopmentPreflightPass,
  baseline: EvaluationResult,
  series: QualificationSeries,
): Result.Result<QualificationSeries, CandidateDevelopmentComparisonSemanticsIssue> => {
  if (baseline.protocolHash !== preflight.expectedStrategyProtocolHash) {
    return Result.fail({
      _tag: 'CandidateDevelopmentBaselineStrategyProtocolMismatch',
      expected: preflight.expectedStrategyProtocolHash,
      observed: baseline.protocolHash,
    })
  }
  if (series.runId !== baseline.runId) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonSeriesRunMismatch',
      expected: baseline.runId,
      observed: series.runId,
    })
  }

  const expectedSessions = preflight.selectedObservationSessions
  const observedSessions = series.observations.map((observation) => observation.sessionDate)
  const sessionMismatch = firstSequenceMismatch(expectedSessions, observedSessions, (left, right) => left === right)
  if (sessionMismatch !== undefined) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonSeriesWindowMismatch',
      ...sessionMismatch,
      expectedCount: expectedSessions.length,
      observedCount: observedSessions.length,
    })
  }

  const expectedRebalanceSchedule = preflight.expectedRebalanceSchedule
  const observedRebalanceSchedule = baseline.signalDecisions.map(({ signalDate, executionDate }) => ({
    signalDate,
    executionDate,
  }))
  const decisionMismatch = firstSequenceMismatch(
    expectedRebalanceSchedule,
    observedRebalanceSchedule,
    (left, right) => left?.signalDate === right?.signalDate && left?.executionDate === right?.executionDate,
  )
  if (decisionMismatch !== undefined) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonSignalExecutionMismatch',
      ...decisionMismatch,
      expectedCount: expectedRebalanceSchedule.length,
      observedCount: observedRebalanceSchedule.length,
    })
  }

  const expectedRebalanceExecutionDates = expectedRebalanceSchedule.map(({ executionDate }) => executionDate)
  const observedRebalanceExecutionDates = series.rebalanceExecutionDates
  const rebalanceMismatch = firstSequenceMismatch(
    expectedRebalanceExecutionDates,
    observedRebalanceExecutionDates,
    (left, right) => left === right,
  )
  return rebalanceMismatch === undefined
    ? Result.succeed(series)
    : Result.fail({
        _tag: 'CandidateDevelopmentComparisonRebalanceScheduleMismatch',
        ...rebalanceMismatch,
        expectedCount: expectedRebalanceExecutionDates.length,
        observedCount: observedRebalanceExecutionDates.length,
      })
}

export const buildCandidateDevelopmentComparisonSemanticsEvidence = (
  preflight: CandidateDevelopmentPreflightPass,
  series: unknown,
): Result.Result<CandidateDevelopmentComparisonSemanticsEvidence, CandidateDevelopmentComparisonSemanticsIssue> =>
  analyzeSelectedBenchmarkComparisonInput(series, preflight.statisticsPolicy, preflight.attempt.priorTrialCount).pipe(
    Result.mapError((cause) => ({
      _tag: 'CandidateDevelopmentComparisonAnalysisFailed' as const,
      cause,
    })),
    Result.flatMap((analysis) =>
      analysis.schemaVersion === preflight.comparisonSemantics.evidence.analysisSchemaVersion
        ? Result.succeed({
            schemaVersion: candidateDevelopmentComparisonSemantics.evidence.schemaVersion,
            candidateDevelopmentProtocolHash: preflight.protocolIdentity.candidateDevelopmentProtocolHash,
            strategyProtocolHash: preflight.expectedStrategyProtocolHash,
            comparisonSemantics: preflight.comparisonSemantics,
            analysis,
          })
        : Result.fail({
            _tag: 'CandidateDevelopmentComparisonAnalysisSchemaMismatch' as const,
            expected: preflight.comparisonSemantics.evidence.analysisSchemaVersion,
            observed: analysis.schemaVersion,
          }),
    ),
  )

export const validateCandidateDevelopmentComparisonSemanticsEvidence = (
  preflight: CandidateDevelopmentPreflightPass,
  series: unknown,
  evidence: unknown,
): Result.Result<CandidateDevelopmentComparisonSemanticsEvidence, CandidateDevelopmentComparisonSemanticsIssue> => {
  const root = comparisonEvidenceRecord(evidence)
  if (root === undefined) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonSemanticsShapeInvalid',
      path: 'comparisonSemantics',
      observed: evidence,
    })
  }
  if (root.schemaVersion !== preflight.comparisonSemantics.evidence.schemaVersion) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonSemanticsSchemaMismatch',
      expected: preflight.comparisonSemantics.evidence.schemaVersion,
      observed: root.schemaVersion,
    })
  }
  if (root.candidateDevelopmentProtocolHash !== preflight.protocolIdentity.candidateDevelopmentProtocolHash) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonDevelopmentProtocolMismatch',
      expected: preflight.protocolIdentity.candidateDevelopmentProtocolHash,
      observed: root.candidateDevelopmentProtocolHash,
    })
  }
  if (root.strategyProtocolHash !== preflight.expectedStrategyProtocolHash) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonStrategyProtocolMismatch',
      expected: preflight.expectedStrategyProtocolHash,
      observed: root.strategyProtocolHash,
    })
  }

  const observedSemantics = comparisonEvidenceRecord(root.comparisonSemantics)
  const observedGates = comparisonEvidenceRecord(observedSemantics?.gates)
  if (observedSemantics === undefined || observedGates === undefined) {
    return Result.fail({
      _tag: 'CandidateDevelopmentComparisonSemanticsShapeInvalid',
      path: 'comparisonSemantics.comparisonSemantics',
      observed: root.comparisonSemantics,
    })
  }

  const expectedGates = preflight.comparisonSemantics.gates
  const gate = (Object.keys(expectedGates) as CandidateDevelopmentComparisonGateKey[]).find((key) => {
    const observedGate = comparisonEvidenceRecord(observedGates[key])
    return observedGate === undefined || observedGate.baseline !== expectedGates[key].baseline
  })
  if (gate !== undefined) {
    const observedGate = comparisonEvidenceRecord(observedGates[gate])
    return observedGate === undefined
      ? Result.fail({
          _tag: 'CandidateDevelopmentComparisonSemanticsShapeInvalid',
          path: `comparisonSemantics.gates.${gate}`,
          observed: observedGates[gate],
        })
      : Result.fail({
          _tag: 'CandidateDevelopmentComparisonBaselineMismatch',
          gate,
          expected: expectedGates[gate].baseline,
          observed: observedGate.baseline,
        })
  }

  return buildCandidateDevelopmentComparisonSemanticsEvidence(preflight, series).pipe(
    Result.flatMap((expected) => {
      const observedAnalysis = comparisonEvidenceRecord(root.analysis)
      const observedBootstrap = comparisonEvidenceRecord(observedAnalysis?.bootstrap)
      const observedWalkForward = comparisonEvidenceRecord(observedAnalysis?.walkForward)
      if (observedAnalysis === undefined || observedBootstrap === undefined || observedWalkForward === undefined) {
        return Result.fail<CandidateDevelopmentComparisonSemanticsIssue>({
          _tag: 'CandidateDevelopmentComparisonSemanticsShapeInvalid',
          path: 'comparisonSemantics.analysis',
          observed: root.analysis,
        })
      }
      if (
        observedBootstrap.annualizedReturnDifferenceLowerBound !==
        expected.analysis.bootstrap.annualizedReturnDifferenceLowerBound
      ) {
        return Result.fail<CandidateDevelopmentComparisonSemanticsIssue>({
          _tag: 'CandidateDevelopmentAnnualizedReturnComparisonMismatch',
          expected: expected.analysis.bootstrap.annualizedReturnDifferenceLowerBound,
          observed: observedBootstrap.annualizedReturnDifferenceLowerBound,
        })
      }
      if (
        observedBootstrap.selectedBenchmark !== expected.analysis.bootstrap.selectedBenchmark ||
        observedWalkForward.selectedBenchmark !== expected.analysis.walkForward.selectedBenchmark
      ) {
        return Result.fail<CandidateDevelopmentComparisonSemanticsIssue>({
          _tag: 'CandidateDevelopmentSelectedBenchmarkComparisonMismatch',
          expected: expected.analysis.bootstrap.selectedBenchmark,
          observedBootstrap: observedBootstrap.selectedBenchmark,
          observedWalkForward: observedWalkForward.selectedBenchmark,
        })
      }

      return Result.all({
        expectedHash: canonicalHashV1Result(expected).pipe(
          Result.mapError((cause) => ({
            _tag: 'CandidateDevelopmentComparisonSemanticsHashFailed' as const,
            material: 'expected-evidence' as const,
            cause,
          })),
        ),
        observedHash: canonicalHashV1Result(evidence).pipe(
          Result.mapError((cause) => ({
            _tag: 'CandidateDevelopmentComparisonSemanticsHashFailed' as const,
            material: 'observed-evidence' as const,
            cause,
          })),
        ),
      }).pipe(
        Result.flatMap(({ expectedHash, observedHash }) =>
          expectedHash === observedHash
            ? Result.succeed(evidence as CandidateDevelopmentComparisonSemanticsEvidence)
            : Result.fail<CandidateDevelopmentComparisonSemanticsIssue>({
                _tag: 'CandidateDevelopmentComparisonEvidenceMismatch',
                expectedHash,
                observedHash,
              }),
        ),
      )
    }),
  )
}
