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

export const analyzeQualificationInput = (
  input: QualificationAnalysisInput,
): Result.Result<QualificationAnalysis, QualificationStatisticsFailure> =>
  pipe(
    Result.all({
      series: pipe(
        decodeQualificationSeries(input.series),
        Result.mapError(qualificationStatisticsSchemaFailure('series')),
      ),
      policy: pipe(
        decodeQualificationStatisticsPolicy(input.policy),
        Result.mapError(qualificationStatisticsSchemaFailure('policy')),
      ),
      priorTrialRunIds: pipe(
        decodePriorTrialRunIds(input.priorTrialRunIds),
        Result.mapError(qualificationStatisticsSchemaFailure('prior-trial-run-ids')),
      ),
    }),
    Result.flatMap(({ policy, priorTrialRunIds, series }) => {
      if (!isCanonicalOrder(priorTrialRunIds)) {
        return statisticsFailure({ _tag: 'QualificationLineageInvalid', priorTrialRunIds })
      }
      return pipe(
        buildCompleteBlocks(series),
        Result.flatMap((blocks) => {
          const availableCompleteSessions = blocks.reduce((total, block) => total + block.evidence.observationCount, 0)
          return pipe(
            Result.all({
              power: calculateQualificationPower(policy, blocks.length, availableCompleteSessions),
              bootstrap: runQualificationBootstrap(series, blocks, policy, priorTrialRunIds.length),
              walkForward: calculateWalkForward(series, policy),
            }),
            Result.flatMap(({ bootstrap, power, walkForward }) => {
              const { gates, reasonCodes, status } = decideQualification({ policy, power, bootstrap, walkForward })
              const material = {
                schemaVersion: 'bayn.qualification-analysis.v1' as const,
                runId: series.runId,
                policy,
                priorTrialRunIds,
                candidateOrdinal: priorTrialRunIds.length + 1,
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

export const analyzeQualification = (
  series: QualificationSeries,
  policy: QualificationStatisticsPolicy,
  priorTrialRunIds: readonly string[],
): Result.Result<QualificationAnalysis, QualificationStatisticsFailure> =>
  analyzeQualificationInput({ series, policy, priorTrialRunIds })
