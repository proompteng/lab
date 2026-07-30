import { pipe, Result } from 'effect'

import {
  runSelectedBenchmarkBootstrapComparison,
  type QualificationSelectedBenchmarkBootstrapComparison,
} from './bootstrap'
import { decodeQualificationSeries, qualificationStatisticsSchemaFailure } from './decoding'
import type { QualificationStatisticsFailure } from './failure'
import { hashQualificationEvidence } from './hashing'
import type { PowerAnalysis, QualificationSeries, QualificationStatisticsPolicy } from './model'
import { calculateQualificationPower } from './power'
import { buildCompleteBlocks } from './series'
import {
  calculateSelectedBenchmarkWalkForwardComparison,
  type QualificationSelectedBenchmarkWalkForwardComparison,
} from './walk-forward'

export interface QualificationSelectedBenchmarkComparisonAnalysis {
  readonly schemaVersion: 'bayn.selected-benchmark-comparison-analysis.v1'
  readonly runId: string
  readonly seriesHash: string
  readonly priorTrialCount: number
  readonly power: PowerAnalysis
  readonly bootstrap: QualificationSelectedBenchmarkBootstrapComparison
  readonly walkForward: QualificationSelectedBenchmarkWalkForwardComparison
  readonly analysisHash: string
}

export const analyzeSelectedBenchmarkComparison = (
  series: QualificationSeries,
  policy: QualificationStatisticsPolicy,
  priorTrialCount: number,
): Result.Result<QualificationSelectedBenchmarkComparisonAnalysis, QualificationStatisticsFailure> =>
  pipe(
    hashQualificationEvidence('selected-benchmark-comparison-series', series),
    Result.flatMap((seriesHash) =>
      pipe(
        buildCompleteBlocks(series),
        Result.flatMap((blocks) => {
          const availableCompleteSessions = blocks.reduce((total, block) => total + block.evidence.observationCount, 0)
          return pipe(
            Result.all({
              power: calculateQualificationPower(policy, blocks.length, availableCompleteSessions),
              bootstrap: runSelectedBenchmarkBootstrapComparison(series, blocks, policy, priorTrialCount),
              walkForward: calculateSelectedBenchmarkWalkForwardComparison(series, policy),
            }),
            Result.flatMap(({ bootstrap, power, walkForward }) => {
              const material = {
                schemaVersion: 'bayn.selected-benchmark-comparison-analysis.v1' as const,
                runId: series.runId,
                seriesHash,
                priorTrialCount,
                power,
                bootstrap,
                walkForward,
              }
              return pipe(
                hashQualificationEvidence('selected-benchmark-comparison-analysis', material),
                Result.map((analysisHash) => ({ ...material, analysisHash })),
              )
            }),
          )
        }),
      ),
    ),
  )

export const analyzeSelectedBenchmarkComparisonInput = (
  series: unknown,
  policy: QualificationStatisticsPolicy,
  priorTrialCount: number,
): Result.Result<QualificationSelectedBenchmarkComparisonAnalysis, QualificationStatisticsFailure> =>
  pipe(
    decodeQualificationSeries(series),
    Result.mapError(qualificationStatisticsSchemaFailure('series')),
    Result.flatMap((decoded) => analyzeSelectedBenchmarkComparison(decoded, policy, priorTrialCount)),
  )
