import { Result } from 'effect'

import { prepareQualificationSeries } from '../qualification-statistics'
import type { EvaluationResult } from '../types'
import {
  validateCandidateDevelopmentComparisonSemanticsEvidence,
  validateCandidateDevelopmentComparisonSeriesBinding,
  type CandidateDevelopmentComparisonSemanticsEvidence,
  type CandidateDevelopmentComparisonSemanticsIssue,
} from './comparison'
import {
  validateCandidateDevelopmentDoubledCostCausalPath,
  type CandidateDevelopmentDoubledCostEvidence,
  type CandidateDevelopmentDoubledCostIssue,
  type CandidateDevelopmentDoubledCostRun,
} from './doubled-cost'
import type { CandidateDevelopmentPreflightPass } from './preflight'

export interface CandidateDevelopmentEvaluation {
  readonly baseline: EvaluationResult
  readonly comparisonSemantics: CandidateDevelopmentComparisonSemanticsEvidence
  readonly stressed: CandidateDevelopmentDoubledCostRun
}

export interface CandidateDevelopmentEvaluationDecision {
  readonly baseline: EvaluationResult
  readonly comparisonSemantics: CandidateDevelopmentComparisonSemanticsEvidence
  readonly doubledCost: CandidateDevelopmentDoubledCostEvidence
}

export type CandidateDevelopmentEvaluationIssue =
  | {
      readonly _tag: 'CandidateDevelopmentEvaluationComparisonInvalid'
      readonly cause: CandidateDevelopmentComparisonSemanticsIssue
    }
  | {
      readonly _tag: 'CandidateDevelopmentEvaluationDoubledCostInvalid'
      readonly cause: CandidateDevelopmentDoubledCostIssue
    }

export const decideCandidateDevelopmentEvaluation = (
  preflight: CandidateDevelopmentPreflightPass,
  evaluation: CandidateDevelopmentEvaluation,
): Result.Result<CandidateDevelopmentEvaluationDecision, CandidateDevelopmentEvaluationIssue> =>
  prepareQualificationSeries(evaluation.baseline).pipe(
    Result.mapError((cause) => ({
      _tag: 'CandidateDevelopmentComparisonSeriesProjectionFailed' as const,
      cause,
    })),
    Result.flatMap((series) =>
      validateCandidateDevelopmentComparisonSeriesBinding(preflight, evaluation.baseline, series),
    ),
    Result.flatMap((series) =>
      validateCandidateDevelopmentComparisonSemanticsEvidence(preflight, series, evaluation.comparisonSemantics),
    ),
    Result.mapError(
      (cause): CandidateDevelopmentEvaluationIssue => ({
        _tag: 'CandidateDevelopmentEvaluationComparisonInvalid',
        cause,
      }),
    ),
    Result.flatMap((comparisonSemantics) => {
      const baseline = {
        signalDecisions: evaluation.baseline.signalDecisions,
        simulation: evaluation.baseline.simulation,
      }
      const doubledCost = { baseline, stressed: evaluation.stressed }
      return validateCandidateDevelopmentDoubledCostCausalPath(baseline, evaluation.stressed).pipe(
        Result.mapError(
          (cause): CandidateDevelopmentEvaluationIssue => ({
            _tag: 'CandidateDevelopmentEvaluationDoubledCostInvalid',
            cause,
          }),
        ),
        Result.map(() => ({ baseline: evaluation.baseline, comparisonSemantics, doubledCost })),
      )
    }),
  )
