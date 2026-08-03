import { pipe, Result } from 'effect'

import { runQualificationBootstrap } from './bootstrap'
import {
  decodePriorTrialRunIds,
  decodeQualificationAnalysis,
  decodeQualificationSeries,
  decodeQualificationStatisticsPolicy,
  qualificationStatisticsSchemaFailure,
} from './decoding'
import { decideQualification } from './decision'
import { statisticsFailure, type QualificationStatisticsFailure } from './failure'
import { hashQualificationEvidence } from './hashing'
import type {
  QualificationAnalysis,
  QualificationAnalysisInput,
  QualificationSeries,
  QualificationStatisticsPolicy,
} from './model'
import { isCanonicalOrder } from './ordering'
import { calculateQualificationPower } from './power'
import { buildCompleteBlocks } from './series'
import { calculateWalkForward } from './walk-forward'

export interface QualificationBoundTrialHistory {
  readonly candidateOrdinal: number
  readonly priorTrialCount: number
  readonly priorTrialsHash: string
}

type QualificationLineage = {
  readonly priorTrialRunIds: readonly string[]
  readonly priorTrialCount: number
  readonly priorTrialsHash?: string
}

const analyzeQualificationLineage = (
  seriesInput: QualificationSeries,
  policyInput: QualificationStatisticsPolicy,
  lineage: QualificationLineage,
): Result.Result<QualificationAnalysis, QualificationStatisticsFailure> =>
  pipe(
    Result.all({
      series: pipe(
        decodeQualificationSeries(seriesInput),
        Result.mapError(qualificationStatisticsSchemaFailure('series')),
      ),
      policy: pipe(
        decodeQualificationStatisticsPolicy(policyInput),
        Result.mapError(qualificationStatisticsSchemaFailure('policy')),
      ),
    }),
    Result.flatMap(({ policy, series }) => {
      if (!isCanonicalOrder(lineage.priorTrialRunIds)) {
        return statisticsFailure({ _tag: 'QualificationLineageInvalid', priorTrialRunIds: lineage.priorTrialRunIds })
      }
      return pipe(
        buildCompleteBlocks(series),
        Result.flatMap((blocks) => {
          const availableCompleteSessions = blocks.reduce((total, block) => total + block.evidence.observationCount, 0)
          return pipe(
            Result.all({
              power: calculateQualificationPower(policy, blocks.length, availableCompleteSessions),
              bootstrap: runQualificationBootstrap(series, blocks, policy, lineage.priorTrialCount),
              walkForward: calculateWalkForward(series, policy),
            }),
            Result.flatMap(({ bootstrap, power, walkForward }) => {
              const { gates, reasonCodes, status } = decideQualification({ policy, power, bootstrap, walkForward })
              const material = {
                schemaVersion: 'bayn.qualification-analysis.v1' as const,
                runId: series.runId,
                policy,
                priorTrialRunIds: lineage.priorTrialRunIds,
                ...(lineage.priorTrialsHash === undefined
                  ? {}
                  : {
                      priorTrialCount: lineage.priorTrialCount,
                      priorTrialsHash: lineage.priorTrialsHash,
                    }),
                candidateOrdinal: lineage.priorTrialCount + 1,
                completeBlocks: blocks.map((block) => block.evidence),
                power,
                bootstrap,
                walkForward,
                gates,
                status,
                reasonCodes,
              }
              return pipe(
                hashQualificationEvidence('analysis', material),
                Result.flatMap((analysisHash) =>
                  pipe(
                    decodeQualificationAnalysis({ ...material, analysisHash }),
                    Result.mapError(qualificationStatisticsSchemaFailure('analysis')),
                  ),
                ),
              )
            }),
          )
        }),
      )
    }),
  )

export const analyzeQualificationInput = (
  input: QualificationAnalysisInput,
): Result.Result<QualificationAnalysis, QualificationStatisticsFailure> =>
  pipe(
    Result.all({
      priorTrialRunIds: pipe(
        decodePriorTrialRunIds(input.priorTrialRunIds),
        Result.mapError(qualificationStatisticsSchemaFailure('prior-trial-run-ids')),
      ),
    }),
    Result.flatMap(({ priorTrialRunIds }) =>
      analyzeQualificationLineage(input.series, input.policy, {
        priorTrialRunIds,
        priorTrialCount: priorTrialRunIds.length,
      }),
    ),
  )

export const analyzeQualificationAtOrdinal = (
  series: QualificationSeries,
  policy: QualificationStatisticsPolicy,
  history: QualificationBoundTrialHistory,
): Result.Result<QualificationAnalysis, QualificationStatisticsFailure> => {
  if (
    !Number.isSafeInteger(history.candidateOrdinal) ||
    history.candidateOrdinal <= 0 ||
    !Number.isSafeInteger(history.priorTrialCount) ||
    history.priorTrialCount < 0 ||
    history.candidateOrdinal !== history.priorTrialCount + 1 ||
    !/^[0-9a-f]{64}$/.test(history.priorTrialsHash)
  ) {
    return statisticsFailure({ _tag: 'QualificationBoundLineageInvalid', ...history })
  }
  return analyzeQualificationLineage(series, policy, {
    priorTrialRunIds: [],
    priorTrialCount: history.priorTrialCount,
    priorTrialsHash: history.priorTrialsHash,
  })
}

export const analyzeQualification = (
  series: QualificationSeries,
  policy: QualificationStatisticsPolicy,
  priorTrialRunIds: readonly string[],
): Result.Result<QualificationAnalysis, QualificationStatisticsFailure> =>
  analyzeQualificationInput({ series, policy, priorTrialRunIds })
